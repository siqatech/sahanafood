import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  rankCouriers,
  applyShipmentEvent,
  AssignmentError,
  InvalidTransitionError,
  type ShipmentEvent,
  type ShipmentState,
  type CourierLoad,
  type RankedCourier,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { CONFIG, type AppConfig } from '../../../config/config.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { PublicTokensService } from '../../../common/public-tokens.service.js';
import { CashService } from '../../cash/index.js';

/**
 * Delivery propio (spec 09, T5.15–T5.17).
 *
 * Tres decisiones que gobiernan el módulo:
 *
 *  1. **El envío es una entidad aparte del pedido**, con su propia máquina de
 *     estados. Un reparto fallido no cancela el pedido: se reintenta o se
 *     devuelve (RN-DLV-03).
 *  2. **La asignación es manual en F5**, pero puntuada: el servicio devuelve el
 *     ranking de `@sahana/domain` con el motivo escrito, y una persona elige.
 *     La automática de F6 usará la misma función.
 *  3. **El cobro contra entrega es dinero del repartidor hasta que liquide**
 *     (RN-DLV-02). No entra en la caja al marcar entregado: entra al liquidar,
 *     contra una sesión de caja concreta, porque hasta entonces está en un
 *     bolsillo y no en un cajón.
 */

/**
 * Transición imposible sobre un envío. 409 y no 422: el problema no es lo que
 * se pidió, es el estado en el que está el envío, y ese estado puede haber
 * cambiado por otra pantalla hace dos segundos.
 */
export class ShipmentInvalidTransitionError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/shipment-invalid-transition';
  readonly title = 'Transición de envío no válida';
  readonly code = 'SHIPMENT_INVALID_TRANSITION';
}

/** Un pedido ya tiene un envío vivo. Dos son dos motos a la misma puerta. */
export class ShipmentAlreadyExistsError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/shipment-already-exists';
  readonly title = 'El pedido ya tiene un envío en curso';
  readonly code = 'SHIPMENT_ALREADY_EXISTS';
}

export interface ShipmentView {
  id: string;
  orderId: string;
  status: ShipmentState;
  courierId: string | null;
  courierName: string | null;
  externalCourier: string | null;
  codAmount: string | null;
  codCollected: boolean;
  settled: boolean;
  promisedAt: string | null;
  etaAt: string | null;
  attempts: number;
  failReason: string | null;
}

/** Lo que ve el cliente final por el enlace público. Nada más que esto. */
export interface PublicTrackingView {
  status: ShipmentState;
  orderStatus: string;
  etaAt: string | null;
  /** Nombre de PILA del repartidor. Ni apellido, ni teléfono, ni matrícula. */
  courierFirstName: string | null;
  brandName: string;
}

/** Cuánto debe cada repartidor por cobros contra entrega sin liquidar. */
export interface CourierBalance {
  courierId: string;
  courierName: string;
  pendingShipments: number;
  pendingAmount: string;
}

const TRACKING_TTL_HOURS = 48;

@Injectable()
export class DeliveryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly publicTokens: PublicTokensService,
    private readonly cash: CashService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------- Repartidores

  async createCourier(
    tenantId: string,
    input: {
      locationId: string;
      fullName: string;
      phone?: string | undefined;
      vehicle?: string | undefined;
      zoneIds?: string[] | undefined;
      userId?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; firstName: string }> {
    const fullName = input.fullName.trim();
    if (fullName.length < 2) {
      throw new ValidationError('El nombre del repartidor es obligatorio.');
    }
    // El nombre de pila se guarda al crear, no se deriva en cada consulta: el
    // tracking público lo enseña, y calcularlo cada vez con un `split` es una
    // fuga esperando a un nombre compuesto o a un apellido con espacios.
    const firstName = fullName.split(/\s+/)[0] ?? fullName;

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO dlv_couriers
           (tenant_id, location_id, full_name, first_name, phone, vehicle, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          tenantId,
          input.locationId,
          fullName,
          firstName,
          input.phone ?? null,
          input.vehicle ?? null,
          input.userId ?? null,
        ],
      );
      const id = rows[0]!.id;

      for (const zoneId of input.zoneIds ?? []) {
        await ctx.client.query(
          `INSERT INTO dlv_courier_zones (tenant_id, courier_id, zone_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [tenantId, id, zoneId],
        );
      }

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'delivery.courier_created',
        resourceType: 'courier',
        resourceId: id,
        data: { fullName, locationId: input.locationId },
      });

      return { id, firstName };
    });
  }

  /** Entrar o salir de turno. Un repartidor `off` no entra en la asignación. */
  async setCourierStatus(
    tenantId: string,
    courierId: string,
    status: 'available' | 'busy' | 'off',
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rowCount } = await client.query(
        `UPDATE dlv_couriers SET status = $2, updated_at = now()
          WHERE id = $1 AND active`,
        [courierId, status],
      );
      if ((rowCount ?? 0) === 0) {
        throw new NotFoundError('Repartidor no encontrado.');
      }
    });
  }

  async listCouriers(
    tenantId: string,
    locationId?: string,
  ): Promise<
    Array<{
      id: string;
      fullName: string;
      status: string;
      vehicle: string | null;
      activeShipments: number;
      zoneIds: string[];
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        full_name: string;
        status: string;
        vehicle: string | null;
        active_shipments: string;
        zone_ids: string[] | null;
      }>(
        `SELECT c.id, c.full_name, c.status, c.vehicle,
                (SELECT count(*) FROM dlv_shipments s
                  WHERE s.courier_id = c.id
                    AND s.status IN ('assigned','picked_up')) AS active_shipments,
                (SELECT array_agg(z.zone_id) FROM dlv_courier_zones z
                  WHERE z.courier_id = c.id) AS zone_ids
           FROM dlv_couriers c
          WHERE c.active AND ($1::uuid IS NULL OR c.location_id = $1)
          ORDER BY c.full_name`,
        [locationId ?? null],
      );
      return rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        status: r.status,
        vehicle: r.vehicle,
        activeShipments: Number(r.active_shipments),
        zoneIds: r.zone_ids ?? [],
      }));
    });
  }

  // ---------------------------------------------------------------- Envíos

  /**
   * Crea el envío de un pedido.
   *
   * Con `externalCourier` se registra un reparto de marketplace (RN-DLV-04):
   * no es nuestro repartidor y lo único que interesa es el handoff. Sin él, el
   * envío entra en la cola de asignación.
   */
  async createShipment(
    tenantId: string,
    input: {
      orderId: string;
      zoneId?: string | undefined;
      codAmountMinor?: number | undefined;
      promisedAt?: Date | undefined;
      externalCourier?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ShipmentView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: pedido } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM ord_orders WHERE id = $1',
        [input.orderId],
      );
      if (!pedido[0]) throw new NotFoundError('Pedido no encontrado.');

      const cod =
        input.codAmountMinor !== undefined && input.codAmountMinor > 0
          ? Money.fromMinor(input.codAmountMinor).toDecimalString()
          : null;

      let id: string;
      try {
        const { rows } = await ctx.client.query<{ id: string }>(
          `INSERT INTO dlv_shipments
             (tenant_id, order_id, zone_id, cod_amount, promised_at,
              external_courier, handoff_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            tenantId,
            input.orderId,
            input.zoneId ?? null,
            cod,
            input.promisedAt ?? null,
            input.externalCourier ?? null,
            input.externalCourier ? new Date() : null,
            // El reparto ajeno nace ya asignado: no hay nada que asignar, solo
            // que registrar quién se lo llevó.
            input.externalCourier ? 'assigned' : 'pending',
          ],
        );
        id = rows[0]!.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Dos envíos vivos del mismo pedido son dos motos a la misma puerta.
          throw new ShipmentAlreadyExistsError(
            'Este pedido ya tiene un envío en curso.',
          );
        }
        throw error;
      }

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'delivery.shipment_created',
        resourceType: 'shipment',
        resourceId: id,
        data: {
          orderId: input.orderId,
          external: input.externalCourier ?? null,
        },
      });

      return this.loadShipment(ctx, id);
    });
  }

  /**
   * A quién conviene asignarle este envío, y por qué (RN-DLV-01).
   *
   * Devuelve el ranking ENTERO, no solo el ganador. Enseñar «este, y estos
   * otros dos por si acaso» con el motivo de cada uno es lo que hace que un
   * encargado confíe en la recomendación antes de que en F6 se automatice.
   */
  async suggestCouriers(
    tenantId: string,
    shipmentId: string,
  ): Promise<RankedCourier[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const envio = await this.loadShipmentRow(ctx, shipmentId);

      const { rows } = await ctx.client.query<{
        id: string;
        first_name: string;
        status: string;
        active_shipments: string;
        zone_ids: string[] | null;
      }>(
        `SELECT c.id, c.first_name, c.status,
                (SELECT count(*) FROM dlv_shipments s
                  WHERE s.courier_id = c.id
                    AND s.status IN ('assigned','picked_up')) AS active_shipments,
                (SELECT array_agg(z.zone_id) FROM dlv_courier_zones z
                  WHERE z.courier_id = c.id) AS zone_ids
           FROM dlv_couriers c
          WHERE c.active
            AND c.location_id = (SELECT location_id FROM ord_orders WHERE id = $1)`,
        [envio.order_id],
      );

      const couriers: CourierLoad[] = rows.map((r) => ({
        courierId: r.id,
        name: r.first_name,
        activeShipments: Number(r.active_shipments),
        zoneIds: r.zone_ids ?? [],
        status: r.status as CourierLoad['status'],
      }));

      try {
        return rankCouriers(couriers, {
          zoneId: envio.zone_id,
          // Sin promesa registrada, se toma la creación del envío: la
          // antigüedad sigue significando algo y no se cuela un `now` que
          // haría que todos los envíos parecieran igual de urgentes.
          promisedAt: envio.promised_at ?? envio.created_at,
        });
      } catch (error) {
        if (error instanceof AssignmentError) {
          throw new ValidationError(error.message, { code: error.code });
        }
        throw error;
      }
    });
  }

  /** Asigna (o reasigna) un repartidor. */
  async assign(
    tenantId: string,
    shipmentId: string,
    courierId: string,
    actorId?: string,
  ): Promise<ShipmentView> {
    return this.transition(tenantId, shipmentId, 'assign', {
      courierId,
      ...(actorId !== undefined ? { actorId } : {}),
    });
  }

  async pickUp(
    tenantId: string,
    shipmentId: string,
    actorId?: string,
  ): Promise<ShipmentView> {
    return this.transition(tenantId, shipmentId, 'pick_up', {
      ...(actorId !== undefined ? { actorId } : {}),
    });
  }

  /**
   * Entrega. Aquí es donde se marca el cobro contra entrega como recibido.
   *
   * `codCollected` NO mete el dinero en caja: lo apunta como deuda del
   * repartidor hasta que liquide (RN-DLV-02). Meterlo aquí cuadraría el arqueo
   * con dinero que sigue en un bolsillo.
   */
  async deliver(
    tenantId: string,
    shipmentId: string,
    input: {
      evidence?: Record<string, unknown> | undefined;
      codCollected?: boolean | undefined;
      actorId?: string | undefined;
    } = {},
  ): Promise<ShipmentView> {
    return this.transition(tenantId, shipmentId, 'deliver', {
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.codCollected !== undefined
        ? { codCollected: input.codCollected }
        : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    });
  }

  async fail(
    tenantId: string,
    shipmentId: string,
    reason: string,
    actorId?: string,
  ): Promise<ShipmentView> {
    if (!reason.trim()) {
      // Sin motivo, la bandeja de fallos es una lista de pedidos rotos sin
      // nada que hacer con ellos.
      throw new ValidationError('Una entrega fallida exige un motivo.');
    }
    return this.transition(tenantId, shipmentId, 'fail', {
      reason,
      ...(actorId !== undefined ? { actorId } : {}),
    });
  }

  /** Nuevo intento tras un fallo: vuelve a la cola sin repartidor. */
  async retry(
    tenantId: string,
    shipmentId: string,
    actorId?: string,
  ): Promise<ShipmentView> {
    return this.transition(tenantId, shipmentId, 'retry', {
      ...(actorId !== undefined ? { actorId } : {}),
    });
  }

  /** Se devuelve al local. La política de merma o re-stock es de Inventory. */
  async returnToStore(
    tenantId: string,
    shipmentId: string,
    actorId?: string,
  ): Promise<ShipmentView> {
    return this.transition(tenantId, shipmentId, 'return', {
      ...(actorId !== undefined ? { actorId } : {}),
    });
  }

  /**
   * El motor de todas las transiciones.
   *
   * Una sola puerta: la máquina de estados decide, la fila se actualiza y el
   * evento sale por el outbox EN LA MISMA transacción. Un método por evento con
   * su propio UPDATE acabaría con seis versiones ligeramente distintas de la
   * misma escritura, y una de ellas sin outbox.
   */
  private async transition(
    tenantId: string,
    shipmentId: string,
    event: ShipmentEvent,
    options: {
      courierId?: string;
      reason?: string;
      evidence?: Record<string, unknown>;
      codCollected?: boolean;
      actorId?: string;
    } = {},
  ): Promise<ShipmentView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const actual = await this.loadShipmentRow(ctx, shipmentId, true);

      // Reasignar a alguien cuando ya hay repartidor es `reassign`, no
      // `assign`: la máquina distingue los dos porque el primero desde
      // `assigned` sería una transición no declarada.
      const evento: ShipmentEvent =
        event === 'assign' && actual.status === 'assigned' ? 'reassign' : event;

      let siguiente: ShipmentState;
      try {
        siguiente = applyShipmentEvent(actual.status, evento);
      } catch (error) {
        if (error instanceof InvalidTransitionError) {
          throw new ShipmentInvalidTransitionError(
            `No se puede aplicar "${evento}" a un envío en estado "${actual.status}".`,
            { from: actual.status, event: evento },
          );
        }
        throw error;
      }

      const ahora = new Date();
      const cobro = options.codCollected === true && actual.cod_amount !== null;

      await ctx.client.query(
        `UPDATE dlv_shipments
            SET status = $2,
                -- Al reintentar se SUELTA al repartidor: el envío vuelve a la
                -- cola de verdad, no queda pegado a quien ya falló una vez.
                courier_id = CASE WHEN $2 = 'pending' THEN NULL
                                  ELSE COALESCE($3, courier_id) END,
                assigned_at = CASE WHEN $2 = 'assigned' THEN $4 ELSE assigned_at END,
                picked_up_at = CASE WHEN $2 = 'picked_up' THEN $4 ELSE picked_up_at END,
                delivered_at = CASE WHEN $2 = 'delivered' THEN $4 ELSE delivered_at END,
                failed_at = CASE WHEN $2 = 'failed' THEN $4 ELSE failed_at END,
                fail_reason = CASE WHEN $2 = 'failed' THEN $5 ELSE fail_reason END,
                attempts = CASE WHEN $2 = 'failed' THEN attempts + 1 ELSE attempts END,
                evidence = COALESCE($6::jsonb, evidence),
                cod_collected = cod_collected OR $7,
                updated_at = $4
          WHERE id = $1`,
        [
          shipmentId,
          siguiente,
          options.courierId ?? null,
          ahora,
          options.reason ?? null,
          options.evidence ? JSON.stringify(options.evidence) : null,
          cobro,
        ],
      );

      // El evento va al outbox en la MISMA transacción que el cambio de estado
      // (ADR-0007). El aviso al cliente lo manda un consumidor.
      await enqueueEvent(ctx, {
        aggregateType: 'shipment',
        aggregateId: shipmentId,
        eventType: `delivery.shipment_${siguiente}`,
        payload: {
          shipmentId,
          orderId: actual.order_id,
          status: siguiente,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      });

      await recordAudit(ctx, {
        actorType: 'user',
        ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
        action: `delivery.shipment_${evento}`,
        resourceType: 'shipment',
        resourceId: shipmentId,
        data: {
          from: actual.status,
          to: siguiente,
          ...(options.courierId ? { courierId: options.courierId } : {}),
          ...(options.reason ? { reason: options.reason } : {}),
        },
      });

      return this.loadShipment(ctx, shipmentId);
    });
  }

  // ------------------------------------------------- Tracking público (T5.16)

  /**
   * Emite el enlace de seguimiento del pedido.
   *
   * Usa `pub_tokens` (ADR-0017), que se construyó justo para esto: una URL que
   * llega a alguien SIN cuenta y que tiene que resolver un tenant antes de
   * enseñar nada. No hizo falta ni un escape de RLS nuevo.
   */
  async issueTrackingLink(
    tenantId: string,
    shipmentId: string,
  ): Promise<{ token: string }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.loadShipmentRow(ctx, shipmentId);
      const token = await this.publicTokens.issue(ctx, {
        purpose: 'order_tracking',
        resourceType: 'shipment',
        resourceId: shipmentId,
        expiresAt: new Date(Date.now() + TRACKING_TTL_HOURS * 3_600_000),
      });
      return { token };
    });
  }

  /**
   * La URL de seguimiento del pedido, lista para mandar por WhatsApp — o `null`
   * si no hay nada que enseñar todavía.
   *
   * Existe para que el aviso de «tu pedido va en camino» **lleve el enlace
   * dentro**. Hasta ahora la página de seguimiento se emitía desde el panel y
   * alguien tenía que copiarla y pegarla en el chat a mano, así que en la
   * práctica el cliente casi nunca la recibía: la promesa estaba construida
   * entera y no llegaba a nadie.
   *
   * Tres decisiones:
   *
   *  · **Se REUTILIZA el token vivo.** Avisar dos veces —un reintento, un
   *    cambio de repartidor— no debe dejar dos enlaces distintos en el mismo
   *    chat: quien abriera el primero vería un seguimiento que ya nadie
   *    actualiza.
   *  · **El host preferido es el dominio propio VERIFICADO de la marca.** Es el
   *    que el cliente reconoce, y un enlace a un dominio ajeno en un chat de
   *    WhatsApp parece una estafa. Sin dominio verificado se usa la base
   *    configurada.
   *  · **Sin envío o sin base, devuelve `null` y no lanza.** El aviso se manda
   *    igual, sin enlace. Quedarse sin avisar por no tener una URL sería
   *    cambiar un problema pequeño por uno grande.
   */
  async trackingUrlForOrder(
    ctx: TenantContext,
    orderId: string,
  ): Promise<string | null> {
    const { rows: envios } = await ctx.client.query<{
      id: string;
      brand_id: string;
    }>(
      `SELECT s.id, o.brand_id
         FROM dlv_shipments s
         JOIN ord_orders o ON o.id = s.order_id
        WHERE s.order_id = $1
        ORDER BY s.created_at DESC
        LIMIT 1`,
      [orderId],
    );
    const envio = envios[0];
    // Sin envío no hay nada que seguir: mostrador, recojo en tienda, o un
    // marketplace que reparte con su propia flota y su propio seguimiento.
    if (!envio) return null;

    const base = await this.hostDeSeguimiento(ctx, envio.brand_id);
    if (!base) return null;

    const existente = await this.publicTokens.findLive(ctx, {
      purpose: 'order_tracking',
      resourceType: 'shipment',
      resourceId: envio.id,
    });
    const token =
      existente ??
      (await this.publicTokens.issue(ctx, {
        purpose: 'order_tracking',
        resourceType: 'shipment',
        resourceId: envio.id,
        expiresAt: new Date(Date.now() + TRACKING_TTL_HOURS * 3_600_000),
      }));

    return `${base}/seguimiento/${token}`;
  }

  /**
   * De qué host cuelga el enlace.
   *
   * Se consulta `sto_domains` con SQL y no a través del módulo de tienda a
   * propósito: lo único que hace falta es el host verificado de una marca, y
   * hacer que Delivery dependa de Storefront entero por un `SELECT` de una
   * columna acoplaría dos módulos que por lo demás no se conocen.
   *
   * **Solo dominios verificados.** Uno pendiente todavía no resuelve, así que
   * mandaría al cliente un enlace muerto — peor que no mandarle ninguno.
   */
  private async hostDeSeguimiento(
    ctx: TenantContext,
    brandId: string,
  ): Promise<string | null> {
    const { rows } = await ctx.client.query<{ host: string }>(
      // `status = 'active'`, no `'verified'`: ese valor NO EXISTE —la
      // restricción de la tabla solo admite pending/active/disabled— así que la
      // consulta no encontraba nunca nada y el dominio propio del cliente no se
      // usaba jamás. Pasaba desapercibido porque abajo hay un respaldo que sí
      // devolvía algo. `verifyDomain` marca `verified_at` Y pone `active`; se
      // comprueban las dos cosas porque son dos hechos distintos: que el CNAME
      // se comprobó y que el dominio está en servicio.
      `SELECT host FROM sto_domains
        WHERE brand_id = $1 AND status = 'active' AND verified_at IS NOT NULL
        ORDER BY is_subdomain, host
        LIMIT 1`,
      [brandId],
    );
    const propio = rows[0]?.host;
    if (propio) return `https://${propio}`;

    const base = this.config.publicTrackingBaseUrl;
    // Sin barra final: la URL se compone con `/seguimiento/…` y dos barras
    // seguidas rompen la ruta en algunos servidores.
    return base ? base.replace(/\/+$/, '') : null;
  }

  /**
   * Lo que ve quien abre el enlace. **Sin autenticación y con datos mínimos.**
   *
   * Estado, ETA, el nombre de PILA del repartidor y la marca. Nada más: este
   * enlace se reenvía por WhatsApp y acaba en capturas de pantalla, así que
   * cada campo de más es un dato personal publicado para siempre. En concreto,
   * NO va: la dirección (quien abre el enlace puede no vivir ahí), el teléfono
   * del cliente, el del repartidor, el importe ni el detalle del pedido.
   */
  async publicTracking(token: string): Promise<PublicTrackingView> {
    const resuelto = await this.publicTokens.resolve(token, 'order_tracking');

    return withTenant(this.pool, resuelto.tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        status: ShipmentState;
        eta_at: Date | null;
        order_status: string;
        courier_first_name: string | null;
        brand_name: string;
      }>(
        `SELECT s.status, s.eta_at,
                o.status AS order_status,
                c.first_name AS courier_first_name,
                b.name AS brand_name
           FROM dlv_shipments s
           JOIN ord_orders o ON o.id = s.order_id
           JOIN org_brands b ON b.id = o.brand_id
           LEFT JOIN dlv_couriers c ON c.id = s.courier_id
          WHERE s.id = $1`,
        [resuelto.resourceId],
      );
      const fila = rows[0];
      if (!fila) throw new NotFoundError('El envío ya no está disponible.');

      return {
        status: fila.status,
        orderStatus: fila.order_status,
        etaAt: fila.eta_at?.toISOString() ?? null,
        // Solo mientras hay alguien en camino. Antes de asignar no hay nadie a
        // quien nombrar, y después de entregar ya no hace falta.
        courierFirstName:
          fila.status === 'assigned' || fila.status === 'picked_up'
            ? fila.courier_first_name
            : null,
        brandName: fila.brand_name,
      };
    });
  }

  // ------------------------------------------------ Liquidación COD (T5.17)

  /** Lo que cada repartidor lleva encima y todavía no ha entregado en caja. */
  async courierBalances(tenantId: string): Promise<CourierBalance[]> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        courier_id: string;
        full_name: string;
        pending: string;
        total: string | null;
      }>(
        `SELECT c.id AS courier_id, c.full_name,
                count(s.id) AS pending,
                sum(s.cod_amount) AS total
           FROM dlv_couriers c
           JOIN dlv_shipments s ON s.courier_id = c.id
          WHERE s.cod_collected AND s.settled_session_id IS NULL
          GROUP BY c.id, c.full_name
          ORDER BY c.full_name`,
      );
      return rows.map((r) => ({
        courierId: r.courier_id,
        courierName: r.full_name,
        pendingShipments: Number(r.pending),
        pendingAmount: Money.parse(r.total ?? '0').toDecimalString(),
      }));
    });
  }

  /**
   * Liquida el efectivo de un repartidor contra una sesión de caja (RN-DLV-02).
   *
   * El orden importa y es deliberado: **primero se marcan los envíos** dentro
   * de la transacción, y solo se mete el movimiento en caja con lo que se marcó
   * de verdad. Al revés —movimiento primero— un fallo a mitad dejaría dinero
   * contado en caja y envíos que siguen apareciendo como deuda del repartidor:
   * el mismo billete en dos sitios.
   */
  async settleCourier(
    tenantId: string,
    input: {
      courierId: string;
      sessionId: string;
      actorId?: string | undefined;
    },
  ): Promise<{ shipments: number; amount: string }> {
    const liquidado = await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        cod_amount: string;
      }>(
        `UPDATE dlv_shipments
            SET settled_session_id = $2, settled_at = now(), updated_at = now()
          WHERE courier_id = $1
            AND cod_collected
            AND settled_session_id IS NULL
        RETURNING id, cod_amount`,
        [input.courierId, input.sessionId],
      );

      const total = rows.reduce(
        (acc, r) => acc.add(Money.parse(r.cod_amount)),
        Money.zero(),
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'delivery.courier_settled',
        resourceType: 'courier',
        resourceId: input.courierId,
        data: {
          sessionId: input.sessionId,
          shipments: rows.length,
          amount: total.toDecimalString(),
        },
      });

      return { shipments: rows.length, total };
    });

    if (liquidado.shipments > 0) {
      // Entra en caja como `cash_in`, no como `sale`: la venta ya se contó al
      // facturar el pedido. Contarla otra vez aquí duplicaría los ingresos del
      // día — el error clásico del cobro contra entrega.
      await this.cash.addMovement(tenantId, input.sessionId, {
        kind: 'cash_in',
        amountMinor: liquidado.total.minorUnits,
        method: 'cash',
        reason: `Liquidación de reparto (${liquidado.shipments} entrega${liquidado.shipments === 1 ? '' : 's'})`,
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      });
    }

    return {
      shipments: liquidado.shipments,
      amount: liquidado.total.toDecimalString(),
    };
  }

  // ----------------------------------------------------------------- Apoyo

  async listShipments(
    tenantId: string,
    filter: { status?: string | undefined } = {},
  ): Promise<ShipmentView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `SELECT id FROM dlv_shipments
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY COALESCE(promised_at, created_at)`,
        [filter.status ?? null],
      );
      const vistas: ShipmentView[] = [];
      for (const r of rows) vistas.push(await this.loadShipment(ctx, r.id));
      return vistas;
    });
  }

  async getShipment(tenantId: string, id: string): Promise<ShipmentView> {
    return withTenant(this.pool, tenantId, (ctx) => this.loadShipment(ctx, id));
  }

  private async loadShipmentRow(
    ctx: TenantContext,
    id: string,
    forUpdate = false,
  ): Promise<{
    id: string;
    order_id: string;
    status: ShipmentState;
    zone_id: string | null;
    cod_amount: string | null;
    promised_at: Date | null;
    created_at: Date;
  }> {
    const { rows } = await ctx.client.query<{
      id: string;
      order_id: string;
      status: ShipmentState;
      zone_id: string | null;
      cod_amount: string | null;
      promised_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, order_id, status, zone_id, cod_amount, promised_at, created_at
         FROM dlv_shipments WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    const fila = rows[0];
    if (!fila) throw new NotFoundError('Envío no encontrado.');
    return fila;
  }

  private async loadShipment(
    ctx: TenantContext,
    id: string,
  ): Promise<ShipmentView> {
    const { rows } = await ctx.client.query<{
      id: string;
      order_id: string;
      status: ShipmentState;
      courier_id: string | null;
      courier_name: string | null;
      external_courier: string | null;
      cod_amount: string | null;
      cod_collected: boolean;
      settled_session_id: string | null;
      promised_at: Date | null;
      eta_at: Date | null;
      attempts: number;
      fail_reason: string | null;
    }>(
      `SELECT s.id, s.order_id, s.status, s.courier_id, c.full_name AS courier_name,
              s.external_courier, s.cod_amount, s.cod_collected,
              s.settled_session_id, s.promised_at, s.eta_at, s.attempts, s.fail_reason
         FROM dlv_shipments s
         LEFT JOIN dlv_couriers c ON c.id = s.courier_id
        WHERE s.id = $1`,
      [id],
    );
    const f = rows[0];
    if (!f) throw new NotFoundError('Envío no encontrado.');
    return {
      id: f.id,
      orderId: f.order_id,
      status: f.status,
      courierId: f.courier_id,
      courierName: f.courier_name,
      externalCourier: f.external_courier,
      codAmount: f.cod_amount
        ? Money.parse(f.cod_amount).toDecimalString()
        : null,
      codCollected: f.cod_collected,
      settled: f.settled_session_id !== null,
      promisedAt: f.promised_at?.toISOString() ?? null,
      etaAt: f.eta_at?.toISOString() ?? null,
      attempts: f.attempts,
      failReason: f.fail_reason,
    };
  }
}

/**
 * Drizzle 0.45 envuelve los errores del driver en `DrizzleQueryError`, así que
 * el código de Postgres está en `.cause`. Se recorre la cadena en vez de mirar
 * solo el primer nivel: cuando cambió el envoltorio, la detección dejó de
 * funcionar sin que ninguna prueba lo notara.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let actual = error, saltos = 0; actual != null && saltos < 5; saltos++) {
    if (typeof actual !== 'object') return false;
    if ((actual as { code?: string }).code === '23505') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}
