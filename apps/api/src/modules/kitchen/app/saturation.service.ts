import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  evaluateSaturation,
  suggestPauseOrder,
  assertValidPolicy,
  SaturationError,
  type SaturationDecision,
  type SaturationLevel,
  type SaturationPolicy,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import {
  withSystem,
  withTenant,
  type TenantContext,
} from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { recordAudit } from '../../audit/index.js';
import { OrderingService } from '../../ordering/index.js';
import { KitchenService } from './kitchen.service.js';

/**
 * Capacidad y saturación de cocina (RN-KIT-04, T5.18 — paga **DT-03**).
 *
 * Lo que faltaba: el KDS no limitaba cuánto aceptaba, así que en hora punta la
 * cocina admitía más de lo que podía producir. **No fallaba nada** —los pedidos
 * entraban, la caja cobraba, el KDS los pintaba—; simplemente todos salían
 * tarde, y el cliente se enteraba después de pagar. Es el peor tipo de fallo:
 * el que no se ve en ningún log.
 *
 * Está en su propio servicio y no dentro de `KitchenService` porque toca dos
 * módulos —extiende promesas y pausa canales, ambos vía la API de Ordering— y
 * porque tiene una decisión de dominio propia. Mezclarlo con la gestión de
 * tickets haría que un cambio en la regla de saturación tocara el mismo archivo
 * que el marcado de tickets, que es lo que más se toca.
 */

export interface CapacityConfig {
  kitchenId: string;
  maxConcurrentItems: number;
  extendMinutes: number;
  pauseThresholdItems: number | null;
  channelPauseOrder: string[];
  level: SaturationLevel;
  levelSince: string | null;
  enabled: boolean;
}

export interface SaturationResult extends SaturationDecision {
  kitchenId: string;
  activeItems: number;
  previousLevel: SaturationLevel;
  /** Pedidos aún en `received` a los que se les movió la promesa. */
  ordersExtended: number;
  channelsPaused: string[];
  channelsResumed: string[];
}

@Injectable()
export class SaturationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly kitchen: KitchenService,
    private readonly ordering: OrderingService,
  ) {}

  // ------------------------------------------------------------ Configuración

  async getCapacity(
    tenantId: string,
    kitchenId: string,
  ): Promise<CapacityConfig> {
    return withTenant(this.pool, tenantId, (ctx) =>
      this.loadCapacity(ctx, kitchenId),
    );
  }

  async setCapacity(
    tenantId: string,
    kitchenId: string,
    input: {
      maxConcurrentItems: number;
      extendMinutes: number;
      pauseThresholdItems?: number | null | undefined;
      channelPauseOrder?: string[] | undefined;
      enabled?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<CapacityConfig> {
    const policy: SaturationPolicy = {
      maxConcurrentItems: input.maxConcurrentItems,
      extendMinutes: input.extendMinutes,
      pauseThresholdItems: input.pauseThresholdItems ?? null,
      channelPauseOrder: input.channelPauseOrder ?? [],
    };
    try {
      // Se valida con la MISMA función del dominio que decide, no con reglas
      // paralelas aquí: una configuración que la BD acepta y el dominio
      // rechaza es una cocina que nunca llega a saturarse.
      assertValidPolicy(policy);
    } catch (error) {
      if (error instanceof SaturationError) {
        throw new ValidationError(error.message);
      }
      throw error;
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO kit_capacity
           (tenant_id, kitchen_id, max_concurrent_items, extend_minutes,
            pause_threshold_items, channel_pause_order, enabled, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (tenant_id, kitchen_id) DO UPDATE
           SET max_concurrent_items = EXCLUDED.max_concurrent_items,
               extend_minutes = EXCLUDED.extend_minutes,
               pause_threshold_items = EXCLUDED.pause_threshold_items,
               channel_pause_order = EXCLUDED.channel_pause_order,
               enabled = EXCLUDED.enabled,
               updated_at = now()`,
        [
          tenantId,
          kitchenId,
          policy.maxConcurrentItems,
          policy.extendMinutes,
          policy.pauseThresholdItems,
          policy.channelPauseOrder,
          input.enabled ?? true,
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'kitchen.capacity_updated',
        resourceType: 'kitchen',
        resourceId: kitchenId,
        data: { ...policy },
      });

      return this.loadCapacity(ctx, kitchenId);
    });
  }

  /**
   * Orden de pausa sugerido a partir de las comisiones vigentes.
   *
   * Sugerencia, no imposición: hay motivos legítimos para no cerrar el canal
   * más caro —un contrato de exclusividad, una promoción en marcha—, y quien
   * los conoce es el dueño, no la tabla de tarifas.
   */
  async suggestChannelOrder(tenantId: string): Promise<string[]> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        channel: string;
        percent_bps: number;
      }>(
        // La tarifa VIGENTE de cada canal: cambiar el tarifario cierra la
        // anterior en vez de editarla (T5.07), así que la vigente es la que no
        // tiene fin o cuyo fin aún no llegó.
        `SELECT DISTINCT ON (channel) channel, percent_bps
           FROM pay_channel_tariffs
          WHERE effective_to IS NULL OR effective_to > now()
          ORDER BY channel, effective_from DESC`,
      );
      return suggestPauseOrder(
        rows.map((r) => ({
          channel: r.channel,
          commissionBps: Number(r.percent_bps),
        })),
      );
    });
  }

  // -------------------------------------------------------------- Evaluación

  /**
   * Mira la carga y aplica lo que toque.
   *
   * **Idempotente**: dice qué debe ser cierto ahora y aplica solo la
   * diferencia con lo que ya estaba. Llamarla dos veces seguidas con la misma
   * carga no extiende las promesas dos veces —que sería prometer media hora de
   * más por un barrido que corre cada minuto— ni vuelve a escribir el
   * histórico.
   */
  async evaluate(
    tenantId: string,
    kitchenId: string,
    now = new Date(),
  ): Promise<SaturationResult> {
    const carga = await this.kitchen.load(tenantId, kitchenId, now);
    const config = await this.getCapacity(tenantId, kitchenId);

    if (!config.enabled) {
      return {
        kitchenId,
        activeItems: carga.activeItems,
        previousLevel: config.level,
        level: 'normal',
        extendPromiseMinutes: 0,
        channelsToPause: [],
        reason: 'El control de capacidad está desactivado en esta cocina.',
        ordersExtended: 0,
        channelsPaused: [],
        channelsResumed: [],
      };
    }

    const decision = evaluateSaturation(
      { activeItems: carga.activeItems, lateTickets: carga.lateTickets },
      {
        maxConcurrentItems: config.maxConcurrentItems,
        extendMinutes: config.extendMinutes,
        pauseThresholdItems: config.pauseThresholdItems,
        channelPauseOrder: config.channelPauseOrder,
      },
    );

    const cambioDeNivel = decision.level !== config.level;

    // Las promesas se extienden SOLO al entrar en un nivel peor. Extenderlas en
    // cada evaluación acumularía quince minutos por minuto de barrido y el
    // cliente vería su promesa alejarse sola.
    const empeora = NIVEL_ORDEN[decision.level] > NIVEL_ORDEN[config.level];

    let ordersExtended = 0;
    const channelsPaused: string[] = [];
    const channelsResumed: string[] = [];

    const locales = await this.locationsOfKitchen(tenantId, kitchenId);

    if (empeora && decision.extendPromiseMinutes > 0) {
      ordersExtended = await this.extendPromises(
        tenantId,
        locales,
        decision.extendPromiseMinutes,
      );
    }

    // Canales: se aplica el estado objetivo, no un delta calculado a mano.
    const objetivo = new Set(decision.channelsToPause);
    for (const locationId of locales) {
      const pausados = await this.ordering.pausedChannels(tenantId, locationId);
      const yaPausadosPorCocina = new Set(
        pausados.filter((p) => p.pausedBy === 'kitchen').map((p) => p.channel),
      );

      for (const channel of objetivo) {
        if (yaPausadosPorCocina.has(channel)) continue;
        await this.ordering.setChannelPause(tenantId, {
          locationId,
          channel,
          paused: true,
          pausedBy: 'kitchen',
          reason: decision.reason,
        });
        channelsPaused.push(channel);
      }

      // Reabrir SOLO lo que cerró la cocina. Una pausa manual sigue en pie:
      // si el encargado cerró Rappi porque se quedó sin pollo, que la cocina
      // se descongestione no significa que ya haya pollo.
      for (const channel of yaPausadosPorCocina) {
        if (objetivo.has(channel)) continue;
        await this.ordering.setChannelPause(tenantId, {
          locationId,
          channel,
          paused: false,
          pausedBy: 'kitchen',
        });
        channelsResumed.push(channel);
      }
    }

    if (cambioDeNivel) {
      await withTenant(this.pool, tenantId, async (ctx) => {
        await ctx.client.query(
          `UPDATE kit_capacity
              SET level = $3, level_since = now(), updated_at = now()
            WHERE tenant_id = $1 AND kitchen_id = $2`,
          [tenantId, kitchenId, decision.level],
        );
        await ctx.client.query(
          `INSERT INTO kit_saturation_events
             (tenant_id, kitchen_id, from_level, to_level, active_items,
              channels_paused, orders_extended, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            tenantId,
            kitchenId,
            config.level,
            decision.level,
            carga.activeItems,
            decision.channelsToPause,
            ordersExtended,
            decision.reason,
          ],
        );

        // El evento sale por el outbox EN LA MISMA transacción (ADR-0007): el
        // KDS y los canales se enteran aunque el proceso muera después.
        await enqueueEvent(ctx, {
          aggregateType: 'kitchen',
          aggregateId: kitchenId,
          eventType:
            decision.level === 'normal'
              ? 'kitchen.recovered'
              : 'kitchen.saturated',
          payload: {
            kitchenId,
            level: decision.level,
            previousLevel: config.level,
            activeItems: carga.activeItems,
            channelsPaused: decision.channelsToPause,
            ordersExtended,
            reason: decision.reason,
          },
        });
      });
    }

    return {
      ...decision,
      kitchenId,
      activeItems: carga.activeItems,
      previousLevel: config.level,
      ordersExtended,
      channelsPaused,
      channelsResumed,
    };
  }

  /**
   * Evalúa TODAS las cocinas con capacidad activa. Lo llama el worker.
   *
   * Enumera tenants bajo `app.system` —que abre el catálogo de tenants y nada
   * más— y entra en el contexto de cada uno. Es más lento que una consulta
   * global, y es también la única forma de que este barrido no sea un agujero
   * por el que se vea la carga de todas las cocinas del sistema. Mismo patrón
   * que el barrido de devoluciones (ADR-0016 §1).
   */
  async sweep(): Promise<{ evaluated: number; changed: number }> {
    const tenants = await withSystem(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM ten_tenants WHERE status = 'active'",
      );
      return rows.map((r) => r.id);
    });

    let evaluated = 0;
    let changed = 0;
    for (const tenantId of tenants) {
      const cocinas = await withTenant(
        this.pool,
        tenantId,
        async ({ client }) => {
          const { rows } = await client.query<{ kitchen_id: string }>(
            'SELECT kitchen_id FROM kit_capacity WHERE enabled',
          );
          return rows.map((r) => r.kitchen_id);
        },
      );

      for (const kitchenId of cocinas) {
        // Una cocina que falla no puede parar el barrido de las demás: en hora
        // punta, dejar sin evaluar a todo el sistema por un error en una
        // cocina es exactamente lo que este barrido existe para evitar.
        try {
          const r = await this.evaluate(tenantId, kitchenId);
          evaluated++;
          if (r.level !== r.previousLevel) changed++;
        } catch {
          // Se cuenta como no evaluada y se sigue. El detalle sale por el log
          // del propio `evaluate` si llega a escribirlo.
        }
      }
    }
    return { evaluated, changed };
  }

  /** Historial de saturación, para discutir el umbral con datos y no a ojo. */
  async history(
    tenantId: string,
    kitchenId: string,
    limit = 50,
  ): Promise<
    Array<{
      fromLevel: string;
      toLevel: string;
      activeItems: number;
      channelsPaused: string[];
      ordersExtended: number;
      reason: string;
      at: string;
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        from_level: string;
        to_level: string;
        active_items: number;
        channels_paused: string[];
        orders_extended: number;
        reason: string;
        created_at: Date;
      }>(
        `SELECT from_level, to_level, active_items, channels_paused,
                orders_extended, reason, created_at
           FROM kit_saturation_events
          WHERE kitchen_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [kitchenId, Math.min(limit, 200)],
      );
      return rows.map((r) => ({
        fromLevel: r.from_level,
        toLevel: r.to_level,
        activeItems: r.active_items,
        channelsPaused: r.channels_paused,
        ordersExtended: r.orders_extended,
        reason: r.reason,
        at: r.created_at.toISOString(),
      }));
    });
  }

  // ----------------------------------------------------------------- Apoyo

  /**
   * Mueve la promesa de los pedidos que AÚN NO EMPEZARON.
   *
   * `received` y `accepted` solamente: uno ya en preparación tiene su comida en
   * la plancha y moverle la promesa solo maquilla el retraso. Y el cliente ya
   * vio ese número — cambiárselo cuando ya está esperando es peor que llegar
   * tarde.
   */
  private async extendPromises(
    tenantId: string,
    locationIds: string[],
    minutes: number,
  ): Promise<number> {
    if (locationIds.length === 0) return 0;
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rowCount } = await client.query(
        `UPDATE ord_orders
            SET promised_at = promised_at + ($2 || ' minutes')::interval,
                updated_at = now()
          WHERE location_id = ANY($1::uuid[])
            AND status IN ('received','accepted')
            AND promised_at IS NOT NULL`,
        [locationIds, minutes],
      );
      return rowCount ?? 0;
    });
  }

  private async locationsOfKitchen(
    tenantId: string,
    kitchenId: string,
  ): Promise<string[]> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ location_id: string }>(
        'SELECT location_id FROM org_kitchens WHERE id = $1',
        [kitchenId],
      );
      return rows.map((r) => r.location_id);
    });
  }

  private async loadCapacity(
    ctx: TenantContext,
    kitchenId: string,
  ): Promise<CapacityConfig> {
    const { rows } = await ctx.client.query<{
      max_concurrent_items: number;
      extend_minutes: number;
      pause_threshold_items: number | null;
      channel_pause_order: string[];
      level: SaturationLevel;
      level_since: Date | null;
      enabled: boolean;
    }>(
      `SELECT max_concurrent_items, extend_minutes, pause_threshold_items,
              channel_pause_order, level, level_since, enabled
         FROM kit_capacity WHERE kitchen_id = $1`,
      [kitchenId],
    );

    const fila = rows[0];
    if (!fila) {
      // Sin configurar, la cocina existe pero no tiene límite. Se comprueba
      // que la cocina EXISTE para no devolver una config inventada de un id
      // que no es de este tenant.
      const { rows: cocina } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM org_kitchens WHERE id = $1',
        [kitchenId],
      );
      if (!cocina[0]) throw new NotFoundError('Cocina no encontrada.');
      return {
        kitchenId,
        maxConcurrentItems: DEFECTO.maxConcurrentItems,
        extendMinutes: DEFECTO.extendMinutes,
        pauseThresholdItems: null,
        channelPauseOrder: [],
        level: 'normal',
        levelSince: null,
        // Desactivado hasta que alguien ponga un número: un límite inventado
        // por defecto cerraría canales en negocios que nunca lo pidieron.
        enabled: false,
      };
    }

    return {
      kitchenId,
      maxConcurrentItems: fila.max_concurrent_items,
      extendMinutes: fila.extend_minutes,
      pauseThresholdItems: fila.pause_threshold_items,
      channelPauseOrder: fila.channel_pause_order,
      level: fila.level,
      levelSince: fila.level_since?.toISOString() ?? null,
      enabled: fila.enabled,
    };
  }
}

const DEFECTO = { maxConcurrentItems: 20, extendMinutes: 15 };

const NIVEL_ORDEN: Record<SaturationLevel, number> = {
  normal: 0,
  saturated: 1,
  critical: 2,
};
