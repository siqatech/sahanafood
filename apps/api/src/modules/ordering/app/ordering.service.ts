import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  Money,
  calculateOrderTotals,
  transitionOrder,
  cancellationNeedsElevatedPermission,
  InvalidTransitionError,
  type OrderEvent,
  type OrderState,
  type OrderLineInput,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { CatalogService } from '../../catalog/index.js';
import { OrganizationService } from '../../organization/index.js';

/**
 * Orquestador de pedidos (spec 05, canónica).
 *
 * **RN-ORD-01: ningún módulo escribe en `ord_*` directamente.** Todo pedido
 * entra por `submit()`. Esa restricción es la que permite garantizar de verdad
 * el snapshot inmutable, el dedupe y el timeline: si otro módulo pudiera
 * insertar pedidos, cualquiera de las tres garantías se caería en silencio el
 * día que alguien tuviera prisa.
 *
 * El cálculo de importes NO vive aquí: se delega en `@sahana/domain`, el mismo
 * código que corre en el POS offline.
 */

// ------------------------------------------------------------------ Errores

export class OrderInvalidTransitionError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-invalid-transition';
  readonly title = 'Transición de pedido inválida';
}

export class OrderOutOfCoverageError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-out-of-coverage';
  readonly title = 'Fuera de zona de cobertura';
}

export class OrderProductUnavailableError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/order-product-unavailable';
  readonly title = 'Producto no disponible';
}

export class OrderBelowMinimumError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/order-below-minimum';
  readonly title = 'Pedido por debajo del mínimo';
}

export class IdempotencyPayloadMismatchError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/idempotency-payload-mismatch';
  readonly title = 'La clave de idempotencia se reutilizó con otro contenido';
}

// ------------------------------------------------------------------- Tipos

export interface SubmitLineInput {
  productId: string;
  quantity: number;
  modifierOptionIds?: string[] | undefined;
  notes?: string | undefined;
}

export interface SubmitOrderInput {
  brandId: string;
  locationId: string;
  channel: string;
  /** Referencia del canal externo; habilita el dedupe (RN-ORD-03). */
  externalRef?: string | undefined;
  lines: SubmitLineInput[];
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  delivery?:
    | {
        address: string;
        lat: number;
        lng: number;
      }
    | undefined;
  tipMinor?: number | undefined;
  scheduledAt?: Date | undefined;
  notes?: string | undefined;
  /** Clave de idempotencia de clientes propios (ADR-0010). */
  idempotencyKey?: string | undefined;
  actorId?: string | undefined;
  traceId?: string | undefined;
}

export interface OrderSummary {
  id: string;
  orderNumber: number;
  status: OrderState;
  channel: string;
  brandId: string;
  locationId: string;
  total: ReturnType<Money['toJSON']>;
  tax: ReturnType<Money['toJSON']>;
  promisedAt: string | null;
  createdAt: string;
  /** true si la petición se resolvió por dedupe/idempotencia (RN-ORD-03). */
  deduplicated?: boolean;
}

/** Margen sobre el tiempo de preparación para liberar un programado (RN-ORD-05). */
export const SCHEDULED_RELEASE_MARGIN_MINUTES = 10;

function hashPayload(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

@Injectable()
export class OrderingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly catalog: CatalogService,
    private readonly organization: OrganizationService,
  ) {}

  /**
   * Punto de entrada ÚNICO para crear pedidos (RN-ORD-01).
   *
   * Orden deliberado: primero se resuelven las comprobaciones baratas y las que
   * pueden rechazar el pedido (dedupe, catálogo, cobertura), y solo después se
   * abre la transacción que escribe. Así una avalancha de duplicados no
   * consume transacciones.
   */
  async submit(
    tenantId: string,
    input: SubmitOrderInput,
  ): Promise<OrderSummary> {
    // 1) Dedupe por referencia externa (RN-ORD-03): un reintento del canal
    //    devuelve el pedido existente, sin crear otro ni emitir evento nuevo.
    if (input.externalRef) {
      const existente = await this.findByExternalRef(
        tenantId,
        input.channel,
        input.externalRef,
      );
      if (existente) return { ...existente, deduplicated: true };
    }

    // 2) Idempotencia de clientes propios (ADR-0010).
    const payloadHash = hashPayload({
      brandId: input.brandId,
      locationId: input.locationId,
      channel: input.channel,
      lines: input.lines,
      tipMinor: input.tipMinor ?? 0,
    });
    if (input.idempotencyKey) {
      const previo = await this.findByIdempotencyKey(
        tenantId,
        input.idempotencyKey,
      );
      if (previo) {
        if (previo.payloadHash !== payloadHash) {
          // Misma clave, distinto contenido: es un error del cliente, no una
          // segunda creación. Crear el pedido sería peor que fallar.
          throw new IdempotencyPayloadMismatchError(
            'La clave de idempotencia ya se usó con un contenido distinto.',
          );
        }
        if (previo.orderId) {
          const pedido = await this.getSummary(tenantId, previo.orderId);
          return { ...pedido, deduplicated: true };
        }
      }
    }

    // 3) Resolver catálogo y precios para el canal (RN-ORD-09).
    const catalogo = await this.catalog.getResolvedCatalog(tenantId, {
      brandId: input.brandId,
      channel: input.channel,
      locationId: input.locationId,
    });
    const porId = new Map(catalogo.products.map((p) => [p.id, p]));

    const domainLines: OrderLineInput[] = input.lines.map((line, index) => {
      const producto = porId.get(line.productId);
      if (!producto) {
        // No distingue entre «no existe», «sin precio en el canal» y «pausado»:
        // desde fuera son el mismo hecho — no se puede vender ahora aquí.
        throw new OrderProductUnavailableError(
          `El producto ${line.productId} no está disponible en el canal ${input.channel}.`,
          { productId: line.productId },
        );
      }

      const seleccionados = new Set(line.modifierOptionIds ?? []);
      const selections = producto.modifierGroups
        .map((group) => ({
          groupId: group.id,
          optionIds: group.options
            .filter((o) => seleccionados.has(o.id))
            .map((o) => o.id),
        }))
        .filter((s) => s.optionIds.length > 0);

      return {
        lineId: `l${index}`,
        productId: producto.id,
        productName: producto.name,
        unitPriceMinor: producto.price.minorUnits,
        quantity: line.quantity,
        modifierGroups: producto.modifierGroups,
        modifierSelections: selections,
      };
    });

    // 4) Cobertura y mínimo de la zona, si es delivery (RN-ORD-09).
    let zoneId: string | null = null;
    let deliveryFeeMinor = 0;
    let minOrderMinor = 0;
    if (input.delivery) {
      const cobertura = await this.organization.findCoverage(
        tenantId,
        [input.delivery.lng, input.delivery.lat],
        input.brandId,
      );
      if (!cobertura) {
        throw new OrderOutOfCoverageError(
          'La dirección está fuera de nuestra zona de reparto.',
        );
      }
      zoneId = cobertura.zoneId;
      deliveryFeeMinor = cobertura.deliveryFee.minorUnits;
      minOrderMinor = cobertura.minOrder.minorUnits;
    }

    // 5) Totales: SIEMPRE en el dominio compartido, nunca aquí ni en SQL.
    const totals = calculateOrderTotals({
      lines: domainLines,
      deliveryFeeMinor,
      ...(input.tipMinor !== undefined ? { tipMinor: input.tipMinor } : {}),
    });

    // El mínimo se compara contra el consumo, sin envío ni propina: cobrar el
    // envío para alcanzar el mínimo sería engañar al cliente.
    if (minOrderMinor > 0 && totals.subtotal.minorUnits < minOrderMinor) {
      throw new OrderBelowMinimumError(
        `El pedido mínimo para esta zona es ${Money.fromMinor(minOrderMinor).toDecimalString()}.`,
        {
          minimum: Money.fromMinor(minOrderMinor).toJSON(),
          subtotal: totals.subtotal.toJSON(),
        },
      );
    }

    // 6) Estado inicial: programado o recibido (RN-ORD-05).
    const esProgramado =
      input.scheduledAt !== undefined && input.scheduledAt > new Date();
    const estadoInicial: OrderState = esProgramado ? 'scheduled' : 'received';

    const prepMinutes = Math.max(
      ...domainLines.map((l) => porId.get(l.productId)?.prepMinutes ?? 10),
    );

    return withTenant(this.pool, tenantId, async (ctx) => {
      const orderNumber = await this.nextOrderNumber(ctx);

      const [order] = await ctx.db
        .insert(schema.orders)
        .values({
          tenantId,
          brandId: input.brandId,
          locationId: input.locationId,
          orderNumber,
          channel: input.channel,
          externalRef: input.externalRef ?? null,
          status: estadoInicial,
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          deliveryAddress: input.delivery?.address ?? null,
          deliveryLat: input.delivery?.lat ?? null,
          deliveryLng: input.delivery?.lng ?? null,
          zoneId,
          // Todos los importes salen del dominio, en su representación exacta.
          subtotal: totals.subtotal.toDecimalString(),
          discountTotal: totals.orderDiscount.toDecimalString(),
          deliveryFee: totals.deliveryFee.toDecimalString(),
          tip: totals.tip.toDecimalString(),
          total: totals.total.toDecimalString(),
          taxableBase: totals.taxableBase.toDecimalString(),
          tax: totals.tax.toDecimalString(),
          taxRateBps: totals.taxRateBps,
          currency: totals.currency,
          scheduledAt: input.scheduledAt ?? null,
          promisedAt: esProgramado
            ? (input.scheduledAt ?? null)
            : new Date(Date.now() + prepMinutes * 60_000),
          notes: input.notes ?? null,
        })
        .returning({
          id: schema.orders.id,
          createdAt: schema.orders.createdAt,
        });

      const orderId = order!.id;

      // SNAPSHOT de líneas (RN-ORD-02): nombre y precio copiados, no referenciados.
      await ctx.db.insert(schema.orderLines).values(
        totals.lines.map((line, i) => ({
          tenantId,
          orderId,
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
          unitPrice: line.unitPrice.toDecimalString(),
          modifiersTotal: line.modifiersPerUnit.toDecimalString(),
          discount: line.discount.toDecimalString(),
          lineTotal: line.total.toDecimalString(),
          modifiers: this.snapshotModifiers(
            domainLines[i]!,
            porId.get(line.productId),
          ),
          notes: input.lines[i]?.notes ?? null,
        })),
      );

      await this.appendEvent(ctx, {
        orderId,
        event: 'submit',
        fromStatus: null,
        toStatus: estadoInicial,
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          channel: input.channel,
          externalRef: input.externalRef ?? null,
        },
      });

      if (input.idempotencyKey) {
        await ctx.db
          .insert(schema.idempotencyKeys)
          .values({
            tenantId,
            key: input.idempotencyKey,
            payloadHash,
            orderId,
          })
          .onConflictDoNothing();
      }

      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: esProgramado ? 'order.scheduled' : 'order.received',
        payload: {
          orderId,
          orderNumber,
          channel: input.channel,
          brandId: input.brandId,
          locationId: input.locationId,
          total: totals.total.toJSON(),
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      return {
        id: orderId,
        orderNumber,
        status: estadoInicial,
        channel: input.channel,
        brandId: input.brandId,
        locationId: input.locationId,
        total: totals.total.toJSON(),
        tax: totals.tax.toJSON(),
        promisedAt: null,
        createdAt: order!.createdAt.toISOString(),
      };
    });
  }

  /**
   * Aplica una transición de estado. La validez la decide `@sahana/domain`,
   * el mismo código que usa el POS offline.
   */
  async applyTransition(
    tenantId: string,
    orderId: string,
    event: OrderEvent,
    options: {
      actorId?: string;
      actorType?: 'user' | 'system';
      reason?: string;
      traceId?: string;
      hasElevatedPermission?: boolean;
    } = {},
  ): Promise<OrderSummary> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      // FOR UPDATE: dos transiciones simultáneas sobre el mismo pedido se
      // serializan; sin el cerrojo, ambas leerían el estado antiguo y una
      // pisaría a la otra.
      const { rows } = await ctx.client.query<{
        status: OrderState;
        row_version: number;
      }>(
        'SELECT status, row_version FROM ord_orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Pedido no encontrado.');

      // RN-ORD-06: cancelar en preparación o después exige permiso especial.
      if (
        event === 'cancel' &&
        cancellationNeedsElevatedPermission(actual.status) &&
        !options.hasElevatedPermission
      ) {
        throw new ValidationError(
          'Cancelar un pedido ya en preparación requiere el permiso orders.cancel_in_progress y un motivo.',
          { requiredPermission: 'orders.cancel_in_progress' },
        );
      }
      if (event === 'cancel' && !options.reason?.trim()) {
        throw new ValidationError('La cancelación requiere un motivo.');
      }

      let siguiente: OrderState;
      try {
        siguiente = transitionOrder(actual.status, event);
      } catch (error) {
        if (error instanceof InvalidTransitionError) {
          throw new OrderInvalidTransitionError(
            `No se puede aplicar "${event}" a un pedido en estado "${actual.status}".`,
            { from: actual.status, event },
          );
        }
        throw error;
      }

      const esFinal = [
        'delivered',
        'picked_up',
        'rejected',
        'cancelled',
      ].includes(siguiente);

      await ctx.db
        .update(schema.orders)
        .set({
          status: siguiente,
          rowVersion: actual.row_version + 1,
          updatedAt: new Date(),
          ...(siguiente === 'accepted' ? { acceptedAt: new Date() } : {}),
          ...(esFinal ? { closedAt: new Date() } : {}),
          ...(event === 'cancel' && options.reason
            ? { cancelReason: options.reason }
            : {}),
        })
        .where(eq(schema.orders.id, orderId));

      await this.appendEvent(ctx, {
        orderId,
        event,
        fromStatus: actual.status,
        toStatus: siguiente,
        ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
        ...(options.actorType !== undefined
          ? { actorType: options.actorType }
          : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      });

      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: `order.${siguiente}`,
        payload: { orderId, from: actual.status, to: siguiente },
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
      });

      // Las cancelaciones con costo van a auditoría (docs/14#auditoria).
      if (event === 'cancel') {
        await recordAudit(ctx, {
          actorType: options.actorType ?? 'user',
          ...(options.actorId !== undefined
            ? { actorId: options.actorId }
            : {}),
          action: 'order.cancelled',
          resourceType: 'order',
          resourceId: orderId,
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
          ...(options.traceId !== undefined
            ? { traceId: options.traceId }
            : {}),
          data: { fromStatus: actual.status },
        });
      }

      return this.getSummary(tenantId, orderId, ctx);
    });
  }

  /** Marca un pedido como necesitado de revisión manual (RN-ORD-10). */
  async flagForReview(
    tenantId: string,
    orderId: string,
    reason: string,
    traceId?: string,
  ): Promise<void> {
    await this.applyTransition(tenantId, orderId, 'mapping_failed', {
      actorType: 'system',
      reason,
      ...(traceId !== undefined ? { traceId } : {}),
    });
  }

  /** Timeline completo de un pedido (spec 05 §11.3). */
  async getTimeline(
    tenantId: string,
    orderId: string,
  ): Promise<
    Array<{
      occurredAt: string;
      event: string;
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
      reason: string | null;
    }>
  > {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.orderEvents)
        .where(eq(schema.orderEvents.orderId, orderId))
        .orderBy(schema.orderEvents.occurredAt);

      if (rows.length === 0) {
        // Sin eventos, o el pedido no existe (o es de otro tenant).
        const existe = await ctx.db
          .select({ id: schema.orders.id })
          .from(schema.orders)
          .where(eq(schema.orders.id, orderId))
          .limit(1);
        if (existe.length === 0)
          throw new NotFoundError('Pedido no encontrado.');
      }

      return rows.map((e) => ({
        occurredAt: e.occurredAt.toISOString(),
        event: e.event,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorType: e.actorType,
        reason: e.reason,
      }));
    });
  }

  /** Pedidos en la bandeja de excepciones (RN-ORD-10). */
  async listExceptions(tenantId: string): Promise<OrderSummary[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.status, 'needs_review'))
        .orderBy(desc(schema.orders.createdAt));
      return rows.map((r) => this.toSummary(r));
    });
  }

  async list(
    tenantId: string,
    filters: { status?: OrderState; channel?: string; limit?: number } = {},
  ): Promise<OrderSummary[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const conditions = [];
      if (filters.status)
        conditions.push(eq(schema.orders.status, filters.status));
      if (filters.channel)
        conditions.push(eq(schema.orders.channel, filters.channel));

      const query = ctx.db.select().from(schema.orders);
      const filtered =
        conditions.length > 0 ? query.where(and(...conditions)) : query;
      const rows = await filtered
        .orderBy(desc(schema.orders.createdAt))
        .limit(Math.min(filters.limit ?? 50, 200));
      return rows.map((r) => this.toSummary(r));
    });
  }

  async getSummary(
    tenantId: string,
    orderId: string,
    existingCtx?: TenantContext,
  ): Promise<OrderSummary> {
    const fetch = async (ctx: TenantContext): Promise<OrderSummary> => {
      const rows = await ctx.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      if (rows.length === 0) throw new NotFoundError('Pedido no encontrado.');
      return this.toSummary(rows[0]!);
    };
    return existingCtx
      ? fetch(existingCtx)
      : withTenant(this.pool, tenantId, fetch);
  }

  // ------------------------------------------------------------- Internos

  private toSummary(row: typeof schema.orders.$inferSelect): OrderSummary {
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status as OrderState,
      channel: row.channel,
      brandId: row.brandId,
      locationId: row.locationId,
      total: Money.parse(row.total).toJSON(),
      tax: Money.parse(row.tax).toJSON(),
      promisedAt: row.promisedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private snapshotModifiers(
    line: OrderLineInput,
    producto:
      | {
          modifierGroups: Array<{
            id: string;
            options: Array<{
              id: string;
              name: string;
              priceDeltaMinor: number;
            }>;
          }>;
        }
      | undefined,
  ): Array<{ id: string; name: string; priceDeltaMinor: number }> {
    if (!producto) return [];
    const elegidos = new Set(
      (line.modifierSelections ?? []).flatMap((s) => s.optionIds),
    );
    return producto.modifierGroups
      .flatMap((g) => g.options)
      .filter((o) => elegidos.has(o.id))
      .map((o) => ({
        id: o.id,
        name: o.name,
        priceDeltaMinor: o.priceDeltaMinor,
      }));
  }

  /** Número correlativo por tenant, sin huecos ni repeticiones. */
  private async nextOrderNumber(ctx: TenantContext): Promise<number> {
    const { rows } = await ctx.client.query<{ next_number: number }>(
      `INSERT INTO ord_counters (tenant_id, next_number) VALUES ($1, 2)
       ON CONFLICT (tenant_id) DO UPDATE
         SET next_number = ord_counters.next_number + 1
       RETURNING ord_counters.next_number - 1 AS next_number`,
      [ctx.tenantId],
    );
    return rows[0]!.next_number;
  }

  private async appendEvent(
    ctx: TenantContext,
    entry: {
      orderId: string;
      event: string;
      fromStatus: string | null;
      toStatus: string;
      actorType?: string;
      actorId?: string;
      reason?: string;
      traceId?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    await ctx.db.insert(schema.orderEvents).values({
      tenantId: ctx.tenantId,
      orderId: entry.orderId,
      event: entry.event,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      actorType: entry.actorType ?? 'system',
      actorId: entry.actorId ?? null,
      reason: entry.reason ?? null,
      traceId: entry.traceId ?? null,
      data: entry.data ?? {},
    });
  }

  private async findByExternalRef(
    tenantId: string,
    channel: string,
    externalRef: string,
  ): Promise<OrderSummary | undefined> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.channel, channel),
            eq(schema.orders.externalRef, externalRef),
          ),
        )
        .limit(1);
      return rows[0] ? this.toSummary(rows[0]) : undefined;
    });
  }

  private async findByIdempotencyKey(
    tenantId: string,
    key: string,
  ): Promise<{ payloadHash: string; orderId: string | null } | undefined> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.idempotencyKeys)
        .where(eq(schema.idempotencyKeys.key, key))
        .limit(1);
      return rows[0]
        ? { payloadHash: rows[0].payloadHash, orderId: rows[0].orderId }
        : undefined;
    });
  }
}
