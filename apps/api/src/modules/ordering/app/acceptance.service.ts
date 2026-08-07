import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, withSystem } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { ValidationError } from '../../../common/errors.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { recordAudit } from '../../audit/index.js';
import {
  OrderingService,
  OrderInvalidTransitionError,
  SCHEDULED_RELEASE_MARGIN_MINUTES,
} from './ordering.service.js';
import {
  resolveAcceptancePolicy,
  type AcceptancePolicy,
} from './acceptance-policy.js';

/**
 * Aceptación de pedidos y pedidos programados (RN-ORD-04, RN-ORD-05).
 *
 * El problema que resuelve no es técnico. Un pedido que llega y nadie acepta es
 * PEOR que uno rechazado: el cliente lo ve «en curso» en la app del canal, la
 * cocina no lo ve porque aún no está aceptado, y a los cuarenta minutos hay una
 * reclamación, un reembolso y una penalización de reputación. Por eso hay dos
 * relojes y no uno: a los 5 minutos se avisa (todavía se puede salvar) y a los
 * 10 se rechaza solo (rendirse a tiempo cuesta menos que fallar tarde).
 *
 * Los métodos de barrido reciben `now` explícito. No es por purismo: sin él las
 * pruebas tendrían que dormir minutos reales, no se ejecutarían en cada commit,
 * y una regla que decide sola sobre el dinero del cliente estaría sin probar.
 */

export const AUTO_REJECT_REASON =
  'Rechazo automático: nadie aceptó el pedido dentro del plazo configurado.';

export interface SweepResult {
  alerted: number;
  autoRejected: number;
}

@Injectable()
export class AcceptanceService {
  private readonly logger = new Logger(AcceptanceService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ordering: OrderingService,
  ) {}

  // ------------------------------------------------------------- Políticas

  async setPolicy(
    tenantId: string,
    input: {
      brandId?: string | undefined;
      channel?: string | undefined;
      autoAccept: boolean;
      alertAfterMinutes?: number | undefined;
      autoRejectAfterMinutes?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<AcceptancePolicy> {
    const alerta = input.alertAfterMinutes ?? 5;
    const rechazo = input.autoRejectAfterMinutes ?? 10;
    if (alerta > rechazo) {
      throw new ValidationError(
        'El aviso no puede llegar después del rechazo automático: no serviría de nada.',
      );
    }
    if (alerta <= 0 || rechazo <= 0) {
      throw new ValidationError('Los plazos deben ser positivos.');
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      // El índice único usa COALESCE, así que un upsert declarativo no puede
      // apuntarlo: se resuelve con borrado + inserción en la misma transacción.
      await ctx.client.query(
        `DELETE FROM ord_acceptance_policies
          WHERE tenant_id = $1
            AND COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND COALESCE(channel, '*') = COALESCE($3::text, '*')`,
        [tenantId, input.brandId ?? null, input.channel ?? null],
      );

      await ctx.db.insert(schema.acceptancePolicies).values({
        tenantId,
        brandId: input.brandId ?? null,
        channel: input.channel ?? null,
        autoAccept: input.autoAccept,
        alertAfterMinutes: alerta,
        autoRejectAfterMinutes: rechazo,
      });

      // Cambiar quién decide si un pedido entra —y cuánto se espera— es una
      // decisión de negocio con consecuencias económicas: va a auditoría.
      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'ordering.acceptance_policy_changed',
        resourceType: 'acceptance_policy',
        resourceId: `${input.brandId ?? '*'}:${input.channel ?? '*'}`,
        data: {
          autoAccept: input.autoAccept,
          alertAfterMinutes: alerta,
          autoRejectAfterMinutes: rechazo,
        },
      });

      return {
        autoAccept: input.autoAccept,
        alertAfterMinutes: alerta,
        autoRejectAfterMinutes: rechazo,
      };
    });
  }

  /** Política vigente para (marca, canal), resuelta por especificidad. */
  async resolvePolicy(
    tenantId: string,
    brandId: string,
    channel: string,
  ): Promise<AcceptancePolicy> {
    return withTenant(this.pool, tenantId, (ctx) =>
      resolveAcceptancePolicy(ctx, brandId, channel),
    );
  }

  async listPolicies(tenantId: string): Promise<
    Array<
      AcceptancePolicy & { brandId: string | null; channel: string | null }
    >
  > {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db.select().from(schema.acceptancePolicies);
      return rows.map((r) => ({
        brandId: r.brandId,
        channel: r.channel,
        autoAccept: r.autoAccept,
        alertAfterMinutes: r.alertAfterMinutes,
        autoRejectAfterMinutes: r.autoRejectAfterMinutes,
      }));
    });
  }

  // ------------------------------------------------ Barrido de vencimientos

  /**
   * Recorre los pedidos sin aceptar de UN tenant y aplica los dos relojes
   * (RN-ORD-04). Devuelve cuántos avisó y cuántos rechazó.
   *
   * El aviso se marca en la fila (`acceptance_alerted_at`) para no repetirlo en
   * cada vuelta: una notificación por minuto sobre el mismo pedido enseña al
   * equipo a ignorar las notificaciones, que es exactamente lo contrario de lo
   * que se busca.
   */
  async sweepTenant(tenantId: string, now = new Date()): Promise<SweepResult> {
    const pendientes = await withTenant(
      this.pool,
      tenantId,
      async ({ client }) => {
        const { rows } = await client.query<{
          id: string;
          brand_id: string;
          channel: string;
          order_number: number;
          created_at: Date;
          alerted: boolean;
        }>(
          `SELECT id, brand_id, channel, order_number, created_at,
                  acceptance_alerted_at IS NOT NULL AS alerted
             FROM ord_orders
            WHERE status = 'received'
            ORDER BY created_at`,
        );
        return rows;
      },
    );

    const resultado: SweepResult = { alerted: 0, autoRejected: 0 };

    for (const pedido of pendientes) {
      const politica = await this.resolvePolicy(
        tenantId,
        pedido.brand_id,
        pedido.channel,
      );
      const minutos =
        (now.getTime() - pedido.created_at.getTime()) / 60_000;

      if (minutos >= politica.autoRejectAfterMinutes) {
        // Se rechaza a través del orquestador, no con un UPDATE: así pasa por
        // la máquina de estados, deja timeline, evento de salida al canal y
        // auditoría, exactamente igual que si lo hubiera hecho una persona.
        try {
          await this.ordering.applyTransition(tenantId, pedido.id, 'reject', {
            actorType: 'system',
            reason: AUTO_REJECT_REASON,
          });
          resultado.autoRejected++;
          this.logger.warn(
            `Pedido ${pedido.order_number} rechazado automáticamente tras ${Math.round(minutos)} min sin aceptar (${pedido.channel}).`,
          );
        } catch (error) {
          if (error instanceof OrderInvalidTransitionError) {
            // Alguien lo aceptó (o lo rechazó otro worker) entre la lectura y
            // este momento. Con varias instancias del worker esto ocurre a
            // diario: perder la carrera es normal, no un error.
            this.logger.debug(
              `El pedido ${pedido.order_number} ya no estaba pendiente al ir a rechazarlo.`,
            );
          } else {
            throw error;
          }
        }
        continue;
      }

      if (minutos >= politica.alertAfterMinutes && !pedido.alerted) {
        const avisado = await withTenant(this.pool, tenantId, async (ctx) => {
          // La marca se pone con el UPDATE CONDICIONAL y el evento solo se
          // emite si esta transacción fue la que la puso. Con dos instancias
          // del worker, comprobar antes y escribir después dejaría a las dos
          // creyendo que les toca avisar, y el equipo recibiría la misma
          // alerta por duplicado.
          const { rowCount } = await ctx.client.query(
            `UPDATE ord_orders SET acceptance_alerted_at = $2
              WHERE id = $1 AND acceptance_alerted_at IS NULL`,
            [pedido.id, now],
          );
          if ((rowCount ?? 0) === 0) return false;

          await enqueueEvent(ctx, {
            aggregateType: 'order',
            aggregateId: pedido.id,
            eventType: 'order.acceptance_overdue',
            payload: {
              orderId: pedido.id,
              orderNumber: pedido.order_number,
              channel: pedido.channel,
              waitingMinutes: Math.round(minutos),
              autoRejectAtMinutes: politica.autoRejectAfterMinutes,
            },
          });
          return true;
        });
        if (avisado) resultado.alerted++;
      }
    }

    return resultado;
  }

  /**
   * Libera los programados que entran en su ventana de preparación
   * (RN-ORD-05): `scheduled_at − (prep_minutes + margen)`.
   *
   * El margen existe porque el tiempo de preparación es un promedio y la
   * promesa al cliente es una hora concreta: soltar el pedido justo a
   * `prep_minutes` garantiza llegar tarde la mitad de las veces.
   */
  async releaseScheduled(tenantId: string, now = new Date()): Promise<number> {
    const listos = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ord_orders
          WHERE status = 'scheduled'
            AND scheduled_at IS NOT NULL
            AND scheduled_at - make_interval(mins => prep_minutes + $2) <= $1
          ORDER BY scheduled_at`,
        [now, SCHEDULED_RELEASE_MARGIN_MINUTES],
      );
      return rows;
    });

    for (const pedido of listos) {
      await this.ordering.applyTransition(tenantId, pedido.id, 'release', {
        actorType: 'system',
        reason: 'Entró en su ventana de preparación.',
      });
    }
    return listos.length;
  }

  /**
   * Barrido de TODOS los tenants, para el worker periódico.
   *
   * La lista de tenants se obtiene con contexto de sistema —es plano de
   * control, no dato de negocio— y a partir de ahí cada tenant se procesa con
   * su propio contexto RLS. Un fallo en un tenant no puede parar a los demás:
   * si el barrido se abortara al primer error, un solo pedido problemático
   * dejaría sin vigilancia a toda la plataforma.
   */
  async sweepAllTenants(now = new Date()): Promise<SweepResult> {
    const tenants = await withSystem(this.pool, async ({ db }) => {
      const rows = await db
        .select({ id: schema.tenants.id })
        .from(schema.tenants)
        .where(eq(schema.tenants.status, 'active'));
      return rows.map((r) => r.id);
    });

    const total: SweepResult = { alerted: 0, autoRejected: 0 };
    for (const tenantId of tenants) {
      try {
        await this.releaseScheduled(tenantId, now);
        const r = await this.sweepTenant(tenantId, now);
        total.alerted += r.alerted;
        total.autoRejected += r.autoRejected;
      } catch (error) {
        this.logger.error(
          `Barrido de aceptación fallido para el tenant ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return total;
  }
}
