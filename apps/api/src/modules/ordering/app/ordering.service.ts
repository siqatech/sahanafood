import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  Money,
  alergenosDe,
  calculateOrderTotals,
  extractInclusiveTax,
  compareTotals,
  transitionOrder,
  canModify as canModifyOrder,
  checkDiscountApproval,
  DiscountError,
  DEFAULT_DISCOUNT_POLICY,
  type Discount,
  type DiscountPolicy,
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
import { resolveAcceptancePolicy } from './acceptance-policy.js';
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
  readonly code = 'ORDER_INVALID_TRANSITION';
}

export class OrderOutOfCoverageError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-out-of-coverage';
  readonly title = 'Fuera de zona de cobertura';
  readonly code = 'ORDER_OUT_OF_COVERAGE';
}

export class OrderProductUnavailableError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/order-product-unavailable';
  readonly title = 'Producto no disponible';
  readonly code = 'ORDER_PRODUCT_UNAVAILABLE';
}

export class OrderBelowMinimumError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/order-below-minimum';
  readonly title = 'Pedido por debajo del mínimo';
  readonly code = 'ORDER_BELOW_MINIMUM';
}

/**
 * La marca no se produce en el local destino (RN-ORD-09, RN-ORG-01).
 *
 * Es el error que aparece cuando alguien da de alta una marca nueva y se olvida
 * de asociarla a una cocina: sin esta validación el pedido entraría, llegaría a
 * la cocina de nadie y se descubriría cuando el cliente reclamase. La spec 05
 * §9 no lo cataloga; se añade aquí con código propio y queda anotado en
 * `docs/22-risks.md`.
 */
export class OrderBrandNotServedError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-brand-not-served';
  readonly title = 'La marca no se produce en este local';
  readonly code = 'ORDER_BRAND_NOT_SERVED';
}

/**
 * El canal está pausado en ese local (RN-KIT-04, T5.18).
 *
 * 409 y no 422: el pedido es correcto, lo que pasa es que la cocina no da
 * abasto ahora mismo. Y **lleva `retryAfterMinutes`** porque el cliente que
 * recibe esto —un marketplace, la tienda web— tiene que poder decir «vuelve en
 * un rato» en vez de «error»: la venta no está perdida, solo aplazada.
 */
export class ChannelPausedError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/channel-paused';
  readonly title = 'El canal no acepta pedidos ahora mismo';
  readonly code = 'CHANNEL_PAUSED';
}

export class IdempotencyPayloadMismatchError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/idempotency-payload-mismatch';
  readonly title = 'La clave de idempotencia se reutilizó con otro contenido';
  readonly code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
}

/**
 * El pedido cambió entre que el cliente lo leyó y que intentó modificarlo
 * (RN-ORD-07). Aceptar la modificación a ciegas pisaría el cambio de otro
 * —típicamente el cajero y el supervisor tocando el mismo pedido a la vez—.
 */
export class OrderVersionConflictError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-version-conflict';
  readonly title = 'El pedido cambió mientras lo editabas';
  readonly code = 'ORDER_VERSION_CONFLICT';
}

/**
 * El descuento pasa del umbral y no vino aprobado (RN-T08, RN-POS-03).
 *
 * No es un error del cliente ni del sistema: es la regla funcionando. La
 * respuesta lleva el porcentaje acumulado para que el cajero vea por qué se le
 * pide el PIN y no crea que es un fallo.
 */
export class DiscountRequiresApprovalError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/discount-requires-approval';
  readonly title = 'El descuento requiere PIN de supervisor';
  readonly code = 'DISCOUNT_REQUIRES_APPROVAL';
}

/** Se intentó modificar un pedido que ya está en cocina (RN-ORD-07). */
export class OrderNotModifiableError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-not-modifiable';
  readonly title = 'El pedido ya no admite modificación';
  readonly code = 'ORDER_NOT_MODIFIABLE';
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
  /**
   * Versión de la fila. El cliente la devuelve como `If-Match` al modificar
   * (RN-ORD-07); sin exponerla no habría forma de detectar ediciones
   * simultáneas.
   */
  rowVersion: number;
  /** true si la petición se resolvió por dedupe/idempotencia (RN-ORD-03). */
  deduplicated?: boolean;
}

/** Línea vendida sin red, con su snapshot de precios ya calculado en el POS. */
export interface OfflineOrderLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  modifiersTotalMinor?: number | undefined;
  discountMinor?: number | undefined;
  modifiers?:
    Array<{ id: string; name: string; priceDeltaMinor: number }> | undefined;
  notes?: string | undefined;
}

export interface OfflineOrderInput {
  /** ULID generado en el POS. Es la clave de dedupe (ADR-0010). */
  clientId: string;
  brandId: string;
  locationId: string;
  channel?: string | undefined;
  lines: OfflineOrderLine[];
  /** Total que el POS cobró de verdad. Prevalece sobre el recalculado. */
  totalMinor: number;
  discountTotalMinor?: number | undefined;
  deliveryFeeMinor?: number | undefined;
  tipMinor?: number | undefined;
  taxRateBps?: number | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  notes?: string | undefined;
  /** Instante real de la venta en el local. */
  soldAt?: string | undefined;
  /**
   * Con qué cobró el cajero. Es lo que decide si la venta mueve la gaveta.
   *
   * Se aceptaba en la PWA y se tiraba aquí: `offlineOrderSchema` no lo
   * declaraba y zod lo quitaba en silencio. El resultado era que **ninguna
   * venta del mostrador llegaba al arqueo** y toda caja cerraba con un
   * sobrante del tamaño de lo vendido en efectivo.
   */
  paymentMethod?: string | undefined;
  actorId?: string | undefined;
  traceId?: string | undefined;
}

export interface OfflineSubmitResult {
  order: OrderSummary;
  outcome: 'accepted' | 'accepted_with_alerts' | 'duplicate';
  /** Inconsistencias detectadas. NUNCA bloquean el pedido (RN-T07). */
  alerts: string[];
}

/** Margen sobre el tiempo de preparación para liberar un programado (RN-ORD-05). */
export const SCHEDULED_RELEASE_MARGIN_MINUTES = 10;

function hashPayload(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Los alérgenos que se guardan en la línea, o `null` si no se sabe.
 *
 * La distinción es el punto entero: `[]` es «el restaurante no declaró
 * ninguno» y `null` es «no se registró». Devolver `[]` sin producto resuelto
 * convertiría una ignorancia en una afirmación de inocuidad, que es el error
 * caro de una alergia.
 */
function alergenosSnapshot(
  producto: { allergens?: unknown } | undefined,
): string[] | null {
  if (!producto) return null;
  return alergenosDe(producto.allergens);
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

    // 3) La marca tiene que producirse en el local destino (RN-ORD-09).
    await this.assertBrandServedAt(tenantId, input.brandId, input.locationId);

    // 3b) El canal tiene que estar aceptando (RN-KIT-04). Va DESPUÉS del
    //     dedupe y la idempotencia a propósito: un reintento de un pedido que
    //     ya entró tiene que seguir devolviendo ese pedido aunque el canal se
    //     haya pausado entre medias. Rechazarlo dejaría al marketplace
    //     creyendo que no entró comida que ya está en la plancha.
    await this.assertChannelAccepting(
      tenantId,
      input.locationId,
      input.channel,
    );

    // 4) Resolver catálogo y precios para el canal (RN-ORD-09).
    const { domainLines, porId } = await this.resolveLines(tenantId, input);

    // 5) Cobertura y mínimo de la zona, si es delivery (RN-ORD-09).
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

    // 6) Totales: SIEMPRE en el dominio compartido, nunca aquí ni en SQL.
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

    // 7) Estado inicial: programado o recibido (RN-ORD-05).
    const esProgramado =
      input.scheduledAt !== undefined && input.scheduledAt > new Date();

    const prepMinutes = Math.max(
      ...domainLines.map((l) => porId.get(l.productId)?.prepMinutes ?? 10),
    );

    return withTenant(this.pool, tenantId, async (ctx) => {
      // La política se lee DENTRO de la transacción para que un pedido con
      // aceptación automática nazca ya aceptado (RN-ORD-04). Aceptarlo después,
      // en otra transacción, dejaría una ventana en la que existe `received` sin
      // que nadie lo esté mirando — y si el proceso muere en esa ventana, el
      // pedido se queda esperando a una persona que no sabe que existe.
      const politica = esProgramado
        ? { autoAccept: false }
        : await resolveAcceptancePolicy(ctx, input.brandId, input.channel);

      const estadoInicial: OrderState = esProgramado
        ? 'scheduled'
        : politica.autoAccept
          ? 'accepted'
          : 'received';

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
          // Se copia con el resto del snapshot: ajustar mañana el prep_time del
          // producto no debe mover la ventana de liberación de un programado de
          // ayer (RN-ORD-05).
          prepMinutes,
          ...(estadoInicial === 'accepted' ? { acceptedAt: new Date() } : {}),
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
          // Se copian, no se referencian (RN-ORD-02): si el dueño corrige la
          // carta el martes, la comanda del lunes tiene que seguir diciendo lo
          // que se declaró el lunes. `null` si el producto no se pudo resolver,
          // porque «no se registró» NO es «no lleva nada».
          allergens: alergenosSnapshot(porId.get(line.productId)),
          notes: input.lines[i]?.notes ?? null,
        })),
      );

      // El timeline refleja lo ocurrido, no el resultado: un pedido que nace
      // aceptado se recibió Y se aceptó, y quien reconstruya el caso mañana
      // tiene que poder ver que la aceptación fue automática y no de alguien.
      await this.appendEvent(ctx, {
        orderId,
        event: 'submit',
        fromStatus: null,
        toStatus: esProgramado ? 'scheduled' : 'received',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          channel: input.channel,
          externalRef: input.externalRef ?? null,
        },
      });

      if (estadoInicial === 'accepted') {
        await this.appendEvent(ctx, {
          orderId,
          event: 'accept',
          fromStatus: 'received',
          toStatus: 'accepted',
          actorType: 'system',
          reason: 'Aceptación automática por política del canal (RN-ORD-04).',
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        });
      }

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
        eventType: esProgramado
          ? 'order.scheduled'
          : estadoInicial === 'accepted'
            ? 'order.accepted'
            : 'order.received',
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

      // Se relee en vez de componer el resumen a mano: la fila recién escrita
      // es la fuente de verdad y así no hay dos formas de construir el mismo
      // objeto que puedan divergir (la anterior devolvía promisedAt en null
      // aunque acababa de calcularlo).
      return this.getSummary(tenantId, orderId, ctx);
    });
  }

  /**
   * Aparta un pedido que NO se pudo interpretar (RN-ORD-10, RN-INT-02).
   *
   * Este método es la razón de que «cero pérdida» sea alcanzable. Cuando la
   * ingesta no puede mapear un SKU o el payload viene roto, la alternativa
   * cómoda es registrar el error y descartar; el resultado es un cliente que
   * pagó y nunca recibe comida, y nadie se entera hasta la reclamación. Aquí el
   * pedido se crea igualmente, en `needs_review`, con el payload crudo en su
   * timeline para que alguien pueda resolverlo y reprocesarlo.
   *
   * Los importes van a cero a propósito: no se conoce el precio de algo que no
   * se pudo mapear, e inventarlo sería peor que dejarlo en cero y visible.
   * También respeta el dedupe: dos reintentos del mismo webhook roto producen
   * UN pedido en la bandeja, no una avalancha.
   */
  async submitForReview(
    tenantId: string,
    input: {
      brandId: string;
      locationId: string;
      channel: string;
      externalRef: string;
      reason: string;
      rawPayload: unknown;
      customerName?: string | undefined;
      customerPhone?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<OrderSummary> {
    const existente = await this.findByExternalRef(
      tenantId,
      input.channel,
      input.externalRef,
    );
    if (existente) return { ...existente, deduplicated: true };

    const cero = Money.zero().toDecimalString();

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
          externalRef: input.externalRef,
          status: 'needs_review',
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          subtotal: cero,
          discountTotal: cero,
          deliveryFee: cero,
          tip: cero,
          total: cero,
          taxableBase: cero,
          tax: cero,
          notes: input.reason,
        })
        .returning({
          id: schema.orders.id,
          createdAt: schema.orders.createdAt,
        });

      const orderId = order!.id;

      await this.appendEvent(ctx, {
        orderId,
        event: 'mapping_failed',
        fromStatus: null,
        toStatus: 'needs_review',
        actorType: 'system',
        reason: input.reason,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        // El payload crudo viaja con el pedido: sin él, «resolver la excepción»
        // sería adivinar.
        data: { rawPayload: input.rawPayload, channel: input.channel },
      });

      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.needs_review',
        payload: {
          orderId,
          orderNumber,
          channel: input.channel,
          externalRef: input.externalRef,
          reason: input.reason,
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      return this.getSummary(tenantId, orderId, ctx);
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
        // El MOTIVO viaja en el evento, no solo en auditoría. Sin él, quien
        // reacciona a una cancelación no puede explicar por qué: la merma de
        // inventario quedaría registrada como «sin motivo» y el aviso al
        // cliente no podría decirle nada. Auditoría se lee después; el evento
        // se consume ahora.
        payload: {
          orderId,
          from: actual.status,
          to: siguiente,
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
        },
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

  /**
   * Detalle de un pedido apartado, con **lo que llegó del canal**.
   *
   * `submitForReview` guarda el payload crudo en el evento `mapping_failed`
   * porque «sin él, resolver la excepción sería adivinar» — y durante toda F4 y
   * F5 no hubo ninguna forma de leerlo: `getTimeline` devuelve todo menos
   * `data`. El dato estaba a salvo y era inalcanzable, que para quien tiene que
   * resolver la excepción es lo mismo que no tenerlo.
   *
   * Va aparte del timeline y con permiso propio (`orders.review_exceptions`) a
   * propósito: el payload trae nombre y teléfono del cliente tal cual los mandó
   * el canal, y eso no tiene por qué verlo todo el que puede leer pedidos.
   */
  async getException(
    tenantId: string,
    orderId: string,
  ): Promise<{
    orderId: string;
    orderNumber: number;
    channel: string;
    brandId: string;
    externalRef: string | null;
    reason: string | null;
    customerName: string | null;
    customerPhone: string | null;
    createdAt: string;
    /** Tal cual lo mandó el canal. `null` si el pedido no vino de fuera. */
    rawPayload: unknown;
  }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const filas = await ctx.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      const pedido = filas[0];
      if (!pedido) throw new NotFoundError('Pedido no encontrado.');
      if (pedido.status !== 'needs_review') {
        throw new OrderInvalidTransitionError(
          `El pedido no está en revisión; está en "${pedido.status}".`,
          { from: pedido.status as OrderState, event: 'mapping_resolved' },
        );
      }

      const eventos = await ctx.db
        .select()
        .from(schema.orderEvents)
        .where(
          and(
            eq(schema.orderEvents.orderId, orderId),
            eq(schema.orderEvents.event, 'mapping_failed'),
          ),
        )
        .orderBy(desc(schema.orderEvents.occurredAt))
        .limit(1);
      const datos = eventos[0]?.data as
        { rawPayload?: unknown } | null | undefined;

      return {
        orderId: pedido.id,
        orderNumber: pedido.orderNumber,
        channel: pedido.channel,
        brandId: pedido.brandId,
        externalRef: pedido.externalRef,
        // El motivo está en dos sitios y se prefiere el del evento: el de
        // `notes` puede haberlo pisado una edición posterior.
        reason: eventos[0]?.reason ?? pedido.notes,
        customerName: pedido.customerName,
        customerPhone: pedido.customerPhone,
        createdAt: pedido.createdAt.toISOString(),
        rawPayload: datos?.rawPayload ?? null,
      };
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
    filters: {
      status?: OrderState;
      channel?: string;
      limit?: number;
      /** Nº de pedido, referencia del canal, teléfono o nombre del cliente. */
      search?: string;
    } = {},
  ): Promise<OrderSummary[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const conditions = [];
      if (filters.status)
        conditions.push(eq(schema.orders.status, filters.status));
      if (filters.channel)
        conditions.push(eq(schema.orders.channel, filters.channel));

      const texto = filters.search?.trim();
      if (texto) {
        // Los cuatro campos por los que alguien pregunta cuando llama.
        //
        // El número va aparte y como IGUALDAD, no como `LIKE`: quien dice «mi
        // pedido es el 12» no quiere ver el 120, el 121 y el 312. Los otros tres
        // sí van por coincidencia parcial, porque el teléfono se dicta a medias
        // y el nombre se escribe de diez maneras.
        const numero = /^\d+$/.test(texto) ? Number(texto) : null;
        const patron = `%${texto}%`;
        conditions.push(
          sql`(
            ${numero !== null ? sql`${schema.orders.orderNumber} = ${numero} OR` : sql``}
            ${schema.orders.externalRef} ILIKE ${patron} OR
            ${schema.orders.customerPhone} ILIKE ${patron} OR
            ${schema.orders.customerName} ILIKE ${patron}
          )`,
        );
      }

      const query = ctx.db.select().from(schema.orders);
      const filtered =
        conditions.length > 0 ? query.where(and(...conditions)) : query;
      const rows = await filtered
        .orderBy(desc(schema.orders.createdAt))
        .limit(Math.min(filters.limit ?? 50, 200));
      return rows.map((r) => this.toSummary(r));
    });
  }

  /**
   * El pedido con sus LÍNEAS, para la pantalla de trazabilidad (specs/ux/03).
   *
   * `ord_order_lines` se escribe desde F4 con un comentario que explica que es
   * un **snapshot** —no se referencia el catálogo, se copia (RN-ORD-02)— y
   * ninguna ruta las devolvía. El operador que atiende «¿dónde está mi pedido?»
   * podía ver el estado y el total, y no QUÉ pidió el cliente; y el snapshot,
   * que existe precisamente para poder responder eso meses después, no se podía
   * consultar. Es el cuarto caso de la misma forma que §8.4c del gate.
   */
  async getDetail(
    tenantId: string,
    orderId: string,
  ): Promise<
    OrderSummary & {
      externalRef: string | null;
      customerName: string | null;
      customerPhone: string | null;
      deliveryAddress: string | null;
      notes: string | null;
      cancelReason: string | null;
      acceptedAt: string | null;
      closedAt: string | null;
      /**
       * Cuántos pedidos tiene este cliente CONTANDO ESTE, o `null` si no hay
       * teléfono. Se devuelve el HECHO, no la etiqueta: quién es «frecuente» lo
       * decide `senalDeCliente` en `@sahana/domain`, para que el panel, el POS
       * y el KDS no acaben con tres umbrales distintos.
       */
      customerOrders: number | null;
      lines: Array<{
        id: string;
        productName: string;
        quantity: number;
        lineTotal: string;
        modifiers: unknown;
        notes: string | null;
        isAdjustment: boolean;
      }>;
    }
  > {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const resumen = await this.getSummary(tenantId, orderId, ctx);

      const filas = await ctx.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      const pedido = filas[0]!;

      const lineas = await ctx.db
        .select()
        .from(schema.orderLines)
        .where(eq(schema.orderLines.orderId, orderId))
        .orderBy(schema.orderLines.createdAt);

      // Cuántas veces ha comprado este cliente. Se cuenta por TELÉFONO, igual
      // que el CRM agrupa: el mismo señor pide por la web, por WhatsApp y por
      // Rappi, y contarlo por canal lo convertiría en tres desconocidos.
      //
      // Los cancelados cuentan: para saber si es un cliente de siempre importa
      // cuántas veces ha pedido, no cuántas terminaron bien.
      let customerOrders: number | null = null;
      if (pedido.customerPhone) {
        const { rows } = await ctx.client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ord_orders WHERE customer_phone = $1`,
          [pedido.customerPhone],
        );
        customerOrders = Number(rows[0]?.n ?? 0);
      }

      return {
        ...resumen,
        externalRef: pedido.externalRef,
        customerName: pedido.customerName,
        customerPhone: pedido.customerPhone,
        customerOrders,
        deliveryAddress: pedido.deliveryAddress,
        notes: pedido.notes,
        cancelReason: pedido.cancelReason,
        acceptedAt: pedido.acceptedAt?.toISOString() ?? null,
        closedAt: pedido.closedAt?.toISOString() ?? null,
        lines: lineas.map((l) => ({
          id: l.id,
          productName: l.productName,
          quantity: l.quantity,
          // Importe como cadena decimal, igual que el resto de la API: pasarlo
          // por `number` metería coma flotante en lo único que no la admite.
          lineTotal: Money.parse(l.lineTotal).toDecimalString(),
          modifiers: l.modifiers,
          notes: l.notes,
          isAdjustment: l.isAdjustment,
        })),
      };
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

  // ------------------------------------- Sincronización offline (RN-T07)

  /**
   * Ingresa un pedido vendido SIN RED (RN-T07, ADR-0008, spec 05 §5 F3).
   *
   * La regla es una y no admite excepciones: **la venta offline nunca se
   * rechaza al sincronizar**. El cliente ya se fue con su comida y su boleta;
   * el servidor no puede decidir tres horas después que ese pedido no existió.
   *
   * De ahí las tres diferencias con `submit()`:
   *
   * 1. **Los importes vienen del SNAPSHOT del POS, no del catálogo actual.** Si
   *    el precio cambió mientras el local estaba sin red, prevalece el que se
   *    le cobró al cliente. Recalcular produciría un pedido que no coincide con
   *    el ticket que la persona tiene en la mano.
   * 2. **Ninguna validación bloquea.** Producto retirado, fuera de cobertura,
   *    bajo el mínimo: todo eso genera ALERTA y el pedido entra igual.
   * 3. **Los totales del POS se comparan con los del servidor** y la diferencia,
   *    si la hay, se alerta. Es la comprobación que detecta que el dominio
   *    compartido dejó de estar sincronizado entre ambos lados.
   *
   * El dedupe lo da el índice único `(tenant, channel, external_ref)` con el
   * ULID del cliente: reenviar el mismo lote no crea pedidos nuevos.
   */
  async submitOffline(
    tenantId: string,
    input: OfflineOrderInput,
  ): Promise<OfflineSubmitResult> {
    // Dedupe primero: un reintento de sincronización es lo normal, no la
    // excepción, y no debe costar ni una transacción de escritura.
    const existente = await this.findByExternalRef(
      tenantId,
      input.channel ?? 'pos',
      input.clientId,
    );
    if (existente) {
      return { order: existente, outcome: 'duplicate', alerts: [] };
    }

    const canal = input.channel ?? 'pos';
    const alerts: string[] = [];

    // Se contrasta contra el catálogo VIGENTE solo para detectar diferencias;
    // el importe que manda sigue siendo el del snapshot.
    let catalogoActual: Map<string, { name: string; priceMinor: number }>;
    try {
      const catalogo = await this.catalog.getResolvedCatalog(tenantId, {
        brandId: input.brandId,
        channel: canal,
        locationId: input.locationId,
      });
      catalogoActual = new Map(
        catalogo.products.map((p) => [
          p.id,
          { name: p.name, priceMinor: p.price.minorUnits },
        ]),
      );
    } catch {
      // Ni siquiera poder leer el catálogo puede impedir que la venta entre.
      catalogoActual = new Map();
      alerts.push(
        'No se pudo contrastar contra el catálogo vigente al sincronizar.',
      );
    }

    let subtotal = Money.zero();
    for (const linea of input.lines) {
      const actual = catalogoActual.get(linea.productId);
      if (!actual) {
        alerts.push(
          `El producto "${linea.productName}" ya no está disponible en el canal; se acepta con el precio del ticket.`,
        );
      } else if (actual.priceMinor !== linea.unitPriceMinor) {
        // RN-T07: prevalece el precio del snapshot. La alerta existe para que
        // alguien revise el margen, no para corregir el pedido.
        alerts.push(
          `El precio de "${linea.productName}" cambió (${Money.fromMinor(linea.unitPriceMinor).toDecimalString()} → ${Money.fromMinor(actual.priceMinor).toDecimalString()}); prevalece el del ticket.`,
        );
      }
      subtotal = subtotal.add(Money.fromMinor(linea.lineTotalMinor));
    }

    const envio = Money.fromMinor(input.deliveryFeeMinor ?? 0);
    const propina = Money.fromMinor(input.tipMinor ?? 0);
    const descuento = Money.fromMinor(input.discountTotalMinor ?? 0);
    const base = subtotal.subtract(descuento).add(envio);
    const totalServidor = base.add(propina);
    const impuesto = extractInclusiveTax(base, input.taxRateBps ?? 1800);

    // Comparación POS ↔ servidor: es lo que detecta que el dominio compartido
    // dejó de estar sincronizado entre ambos lados, que sería un fallo grave y
    // silencioso.
    const reportado = Money.fromMinor(input.totalMinor);
    const comparacion = compareTotals(totalServidor, reportado);
    if (!comparacion.matches) {
      alerts.push(
        `El total del POS (${reportado.toDecimalString()}) no coincide con el recalculado (${totalServidor.toDecimalString()}); prevalece el del ticket.`,
      );
    }
    // Prevalece SIEMPRE el del ticket: es lo que el cliente pagó.
    const total = reportado;

    return withTenant(this.pool, tenantId, async (ctx) => {
      const orderNumber = await this.nextOrderNumber(ctx);

      const [order] = await ctx.db
        .insert(schema.orders)
        .values({
          tenantId,
          brandId: input.brandId,
          locationId: input.locationId,
          orderNumber,
          channel: canal,
          externalRef: input.clientId,
          // La venta offline entra ya aceptada: se cobró y se entregó. Nacer
          // en `received` invitaría a que el barrido la rechazara sola.
          status: 'accepted',
          customerName: input.customerName ?? null,
          customerPhone: input.customerPhone ?? null,
          paymentMethod: input.paymentMethod ?? null,
          subtotal: subtotal.toDecimalString(),
          discountTotal: descuento.toDecimalString(),
          deliveryFee: envio.toDecimalString(),
          tip: propina.toDecimalString(),
          total: total.toDecimalString(),
          taxableBase: base.toDecimalString(),
          tax: impuesto.tax.toDecimalString(),
          taxRateBps: input.taxRateBps ?? 1800,
          acceptedAt: new Date(),
          notes: input.notes ?? null,
        })
        .returning({ id: schema.orders.id });

      const orderId = order!.id;

      await ctx.db.insert(schema.orderLines).values(
        input.lines.map((l) => ({
          tenantId,
          orderId,
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
          unitPrice: Money.fromMinor(l.unitPriceMinor).toDecimalString(),
          modifiersTotal: Money.fromMinor(
            l.modifiersTotalMinor ?? 0,
          ).toDecimalString(),
          discount: Money.fromMinor(l.discountMinor ?? 0).toDecimalString(),
          lineTotal: Money.fromMinor(l.lineTotalMinor).toDecimalString(),
          modifiers: l.modifiers ?? [],
          notes: l.notes ?? null,
        })),
      );

      await this.appendEvent(ctx, {
        orderId,
        event: 'submit',
        fromStatus: null,
        toStatus: 'accepted',
        actorType: 'system',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          offline: true,
          clientId: input.clientId,
          soldAt: input.soldAt ?? null,
        },
      });

      // Las alertas van al TIMELINE del pedido, no a un log: quien revise ese
      // pedido mañana tiene que ver por qué se marcó, sin buscar en otro sitio.
      if (alerts.length > 0) {
        await this.appendEvent(ctx, {
          orderId,
          event: 'offline_alert',
          fromStatus: 'accepted',
          toStatus: 'accepted',
          actorType: 'system',
          reason: alerts.join(' | '),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          data: { alerts },
        });

        await recordAudit(ctx, {
          actorType: 'system',
          action: 'order.offline_alert',
          resourceType: 'order',
          resourceId: orderId,
          reason: alerts.join(' | '),
          ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
          data: { clientId: input.clientId, alerts },
        });
      }

      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.accepted',
        payload: {
          orderId,
          orderNumber,
          channel: canal,
          offline: true,
          total: total.toJSON(),
          alerts: alerts.length,
          // El medio de pago viaja en el evento para que el consumidor de caja
          // no tenga que releer el pedido. Está también en la fila: el evento
          // es la vía rápida, la fila es la verdad.
          paymentMethod: input.paymentMethod ?? null,
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      const resumen = await this.getSummary(tenantId, orderId, ctx);
      return {
        order: resumen,
        outcome: alerts.length > 0 ? 'accepted_with_alerts' : 'accepted',
        alerts,
      };
    });
  }

  // ------------------------------------------- Descuentos (RN-T08, RN-POS-03)

  /**
   * Aplica un descuento al pedido, exigiendo aprobación si pasa del umbral.
   *
   * La decisión de si hace falta PIN la toma `@sahana/domain` sobre el
   * descuento ACUMULADO, no sobre el que se aplica ahora: tres descuentos del
   * 10 % con umbral del 15 % son un 30 % sin que nadie firme nada, y ese es el
   * fraude de mostrador que la regla existe para frenar.
   *
   * Verificar el PIN es responsabilidad del llamador (el controlador, que tiene
   * el módulo de identidad a mano); aquí se exige la PRUEBA de que se verificó.
   * Separarlo así permite que el POS offline aplique la misma regla sin poder
   * saltarse la comprobación al sincronizar.
   */
  async applyDiscount(
    tenantId: string,
    orderId: string,
    input: {
      discount: Discount;
      reason: string;
      actorId?: string | undefined;
      /** Supervisor que autorizó, ya verificado por el llamador. */
      approvedBy?: string | undefined;
      policy?: DiscountPolicy | undefined;
      traceId?: string | undefined;
    },
  ): Promise<OrderSummary> {
    if (!input.reason.trim()) {
      throw new ValidationError('Todo descuento exige motivo.');
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        status: OrderState;
        subtotal: string;
        discount_total: string;
        delivery_fee: string;
        tip: string;
        tax_rate_bps: number;
        row_version: number;
      }>(
        `SELECT status, subtotal, discount_total, delivery_fee, tip,
                tax_rate_bps, row_version
           FROM ord_orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Pedido no encontrado.');

      // Descontar sobre un pedido ya cerrado sería reescribir un cobro hecho;
      // eso es una nota de crédito, no un descuento (RN-POS-05).
      if (!canModifyOrder(actual.status)) {
        throw new OrderNotModifiableError(
          `Un pedido en "${actual.status}" ya no admite descuentos: sería una nota de crédito.`,
          { orderStatus: actual.status },
        );
      }

      const subtotal = Money.parse(actual.subtotal);
      const yaDescontado = Money.parse(actual.discount_total);

      let veredicto;
      try {
        veredicto = checkDiscountApproval({
          subtotalMinor: subtotal.minorUnits,
          alreadyDiscountedMinor: yaDescontado.minorUnits,
          discount: input.discount,
          ...(input.policy !== undefined ? { policy: input.policy } : {}),
        });
      } catch (error) {
        if (error instanceof DiscountError) {
          throw new ValidationError(error.message, { code: error.code });
        }
        throw error;
      }

      if (veredicto.requiresApproval && !input.approvedBy) {
        throw new DiscountRequiresApprovalError(
          `El descuento acumulado llega al ${(veredicto.totalBps / 100).toFixed(2)} % y supera el umbral: hace falta el PIN de un supervisor.`,
          {
            totalBps: veredicto.totalBps,
            thresholdBps: (input.policy ?? DEFAULT_DISCOUNT_POLICY)
              .thresholdBps,
            approvalReason: veredicto.reason,
          },
        );
      }

      // El total se recalcula con el descuento acumulado: base imponible e IGV
      // salen del dominio, nunca de una resta hecha aquí.
      const base = subtotal
        .subtract(veredicto.totalAfter)
        .add(Money.parse(actual.delivery_fee));
      const tax = extractInclusiveTax(base, actual.tax_rate_bps);
      const total = base.add(Money.parse(actual.tip));

      await ctx.db
        .update(schema.orders)
        .set({
          discountTotal: veredicto.totalAfter.toDecimalString(),
          taxableBase: base.toDecimalString(),
          tax: tax.tax.toDecimalString(),
          total: total.toDecimalString(),
          rowVersion: actual.row_version + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, orderId));

      await this.appendEvent(ctx, {
        orderId,
        event: 'discount',
        fromStatus: actual.status,
        toStatus: actual.status,
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        reason: input.reason,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          amount: veredicto.amount.toJSON(),
          totalDiscount: veredicto.totalAfter.toJSON(),
          totalBps: veredicto.totalBps,
          approvedBy: input.approvedBy ?? null,
        },
      });

      // Todo descuento va a auditoría, con o sin aprobación: es dinero que
      // deja de entrar y alguien tiene que poder revisarlo después.
      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: veredicto.requiresApproval
          ? 'order.discount_approved'
          : 'order.discount_applied',
        resourceType: 'order',
        resourceId: orderId,
        reason: input.reason,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: {
          amount: veredicto.amount.toJSON(),
          totalDiscount: veredicto.totalAfter.toJSON(),
          totalBps: veredicto.totalBps,
          approvedBy: input.approvedBy ?? null,
        },
      });

      return this.getSummary(tenantId, orderId, ctx);
    });
  }

  // --------------------------------------------- Modificación (RN-ORD-07)

  /**
   * Modifica un pedido antes de que entre en cocina.
   *
   * Dos reglas que no son negociables y que explican la forma del método:
   *
   * 1. **Nunca se reescribe una línea confirmada.** Se marcan las anteriores
   *    como sustituidas añadiendo LÍNEAS DE AJUSTE (`is_adjustment`). El motivo
   *    no es purismo: el comprobante electrónico ya emitido y el consumo de
   *    stock se calculan sobre lo que hubo en cada momento, y reescribir la
   *    línea original destruiría la única prueba de qué se pidió primero.
   * 2. **Control optimista con `If-Match` sobre `row_version`.** Sin él, el
   *    cajero y el supervisor editando a la vez producen la última escritura
   *    gana, en silencio, con una línea perdida.
   */
  async modify(
    tenantId: string,
    orderId: string,
    input: {
      lines: SubmitLineInput[];
      expectedVersion: number;
      reason?: string | undefined;
      actorId?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<OrderSummary> {
    // Se leen fuera de la transacción de escritura los datos que hacen falta
    // para resolver el catálogo; la comprobación de versión se repite DENTRO
    // con cerrojo, que es la que manda.
    const cabecera = await this.loadHeader(tenantId, orderId);

    if (!canModifyOrder(cabecera.status)) {
      throw new OrderNotModifiableError(
        `Un pedido en estado "${cabecera.status}" ya no se puede modificar: está en producción o cerrado.`,
        { orderStatus: cabecera.status },
      );
    }

    const { domainLines, porId } = await this.resolveLines(tenantId, {
      brandId: cabecera.brandId,
      locationId: cabecera.locationId,
      channel: cabecera.channel,
      lines: input.lines,
    });

    const totals = calculateOrderTotals({
      lines: domainLines,
      deliveryFeeMinor: Money.parse(cabecera.deliveryFee).minorUnits,
      tipMinor: Money.parse(cabecera.tip).minorUnits,
    });

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        row_version: number;
        status: OrderState;
      }>(
        'SELECT row_version, status FROM ord_orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Pedido no encontrado.');

      if (actual.row_version !== input.expectedVersion) {
        throw new OrderVersionConflictError(
          `El pedido va por la versión ${actual.row_version} y enviaste ${input.expectedVersion}. Vuelve a cargarlo.`,
          { currentVersion: actual.row_version },
        );
      }
      // Se repite dentro del cerrojo: entre la lectura y esta transacción el
      // pedido pudo entrar en cocina.
      if (!canModifyOrder(actual.status)) {
        throw new OrderNotModifiableError(
          `Un pedido en estado "${actual.status}" ya no se puede modificar.`,
          { orderStatus: actual.status },
        );
      }

      // Las líneas vigentes se marcan como ajuste: quedan en la tabla como
      // historia, y el estado actual del pedido son las que NO son ajuste.
      await ctx.db
        .update(schema.orderLines)
        .set({ isAdjustment: true })
        .where(
          and(
            eq(schema.orderLines.orderId, orderId),
            eq(schema.orderLines.isAdjustment, false),
          ),
        );

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
          // Se copian, no se referencian (RN-ORD-02): si el dueño corrige la
          // carta el martes, la comanda del lunes tiene que seguir diciendo lo
          // que se declaró el lunes. `null` si el producto no se pudo resolver,
          // porque «no se registró» NO es «no lleva nada».
          allergens: alergenosSnapshot(porId.get(line.productId)),
          notes: input.lines[i]?.notes ?? null,
        })),
      );

      await ctx.db
        .update(schema.orders)
        .set({
          subtotal: totals.subtotal.toDecimalString(),
          discountTotal: totals.orderDiscount.toDecimalString(),
          total: totals.total.toDecimalString(),
          taxableBase: totals.taxableBase.toDecimalString(),
          tax: totals.tax.toDecimalString(),
          rowVersion: actual.row_version + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, orderId));

      // El timeline registra la modificación sin cambiar de estado: el pedido
      // sigue donde estaba, pero su contenido no es el mismo.
      await this.appendEvent(ctx, {
        orderId,
        event: 'modify',
        fromStatus: actual.status,
        toStatus: actual.status,
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { total: totals.total.toJSON(), lineas: totals.lines.length },
      });

      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.modified',
        payload: { orderId, total: totals.total.toJSON() },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'order.modified',
        resourceType: 'order',
        resourceId: orderId,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { fromVersion: actual.row_version },
      });

      return this.getSummary(tenantId, orderId, ctx);
    });
  }

  // ------------------------------------ Bandeja de excepciones (RN-ORD-10)

  /**
   * Resuelve a mano el mapeo de un pedido apartado y lo devuelve al flujo
   * normal (spec 05 §7 `POST /orders/:id/resolve-mapping`).
   *
   * Es la única salida de `needs_review` que no es un rechazo, y por tanto la
   * pieza que hace que apartar un pedido sea de verdad recuperable y no un
   * cementerio con mejor nombre. Quien resuelve indica qué productos nuestros
   * corresponden a lo que pidió el cliente; a partir de ahí el pedido se
   * recalcula con el catálogo vigente y sigue su curso.
   */
  async resolveMapping(
    tenantId: string,
    orderId: string,
    input: {
      lines: SubmitLineInput[];
      actorId?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<OrderSummary> {
    const cabecera = await this.loadHeader(tenantId, orderId);
    if (cabecera.status !== 'needs_review') {
      throw new OrderInvalidTransitionError(
        `Solo se resuelve el mapeo de un pedido en revisión; este está en "${cabecera.status}".`,
        { from: cabecera.status, event: 'mapping_resolved' },
      );
    }

    await this.assertBrandServedAt(
      tenantId,
      cabecera.brandId,
      cabecera.locationId,
    );

    const { domainLines, porId } = await this.resolveLines(tenantId, {
      brandId: cabecera.brandId,
      locationId: cabecera.locationId,
      channel: cabecera.channel,
      lines: input.lines,
    });

    // El envío y la propina del pedido apartado eran cero (no se sabían); si el
    // pedido traía dirección, se recalcula la cobertura ahora que sí hay
    // líneas y por tanto importe con el que comparar el mínimo.
    let deliveryFeeMinor = 0;
    let zoneId: string | null = null;
    if (cabecera.deliveryLat !== null && cabecera.deliveryLng !== null) {
      const cobertura = await this.organization.findCoverage(
        tenantId,
        [cabecera.deliveryLng, cabecera.deliveryLat],
        cabecera.brandId,
      );
      if (!cobertura) {
        throw new OrderOutOfCoverageError(
          'La dirección del pedido sigue fuera de la zona de reparto: hay que rechazarlo, no resolverlo.',
        );
      }
      zoneId = cobertura.zoneId;
      deliveryFeeMinor = cobertura.deliveryFee.minorUnits;
    }

    const totals = calculateOrderTotals({
      lines: domainLines,
      deliveryFeeMinor,
    });

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        status: OrderState;
        row_version: number;
      }>(
        'SELECT status, row_version FROM ord_orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Pedido no encontrado.');
      if (actual.status !== 'needs_review') {
        // Otro supervisor lo resolvió mientras tanto.
        throw new OrderInvalidTransitionError(
          `El pedido ya no está en revisión (está en "${actual.status}").`,
          { from: actual.status, event: 'mapping_resolved' },
        );
      }

      const siguiente = transitionOrder('needs_review', 'mapping_resolved');

      // El pedido apartado no tenía líneas: aquí nacen por primera vez.
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
          // Se copian, no se referencian (RN-ORD-02): si el dueño corrige la
          // carta el martes, la comanda del lunes tiene que seguir diciendo lo
          // que se declaró el lunes. `null` si el producto no se pudo resolver,
          // porque «no se registró» NO es «no lleva nada».
          allergens: alergenosSnapshot(porId.get(line.productId)),
          notes: input.lines[i]?.notes ?? null,
        })),
      );

      await ctx.db
        .update(schema.orders)
        .set({
          status: siguiente,
          zoneId,
          subtotal: totals.subtotal.toDecimalString(),
          discountTotal: totals.orderDiscount.toDecimalString(),
          deliveryFee: totals.deliveryFee.toDecimalString(),
          total: totals.total.toDecimalString(),
          taxableBase: totals.taxableBase.toDecimalString(),
          tax: totals.tax.toDecimalString(),
          rowVersion: actual.row_version + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, orderId));

      await this.appendEvent(ctx, {
        orderId,
        event: 'mapping_resolved',
        fromStatus: 'needs_review',
        toStatus: siguiente,
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { total: totals.total.toJSON() },
      });

      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'order.received',
        payload: { orderId, total: totals.total.toJSON(), resolved: true },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      // Resolver una excepción cambia el importe que se cobrará: va a
      // auditoría igual que un descuento manual.
      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'order.mapping_resolved',
        resourceType: 'order',
        resourceId: orderId,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { total: totals.total.toJSON(), lineas: totals.lines.length },
      });

      return this.getSummary(tenantId, orderId, ctx);
    });
  }

  // ------------------------------------------------------------- Internos

  /**
   * Comprueba que la marca se produce en alguna cocina activa del local
   * (RN-ORD-09). Se hace ANTES de resolver precios porque es más barato y
   * porque un fallo aquí no es del cliente, es de configuración: cuanto antes
   * salte, antes se arregla.
   */
  private async assertBrandServedAt(
    tenantId: string,
    brandId: string,
    locationId: string,
  ): Promise<void> {
    const cocinas = await this.organization.kitchensForBrand(tenantId, brandId);
    if (!cocinas.some((k) => k.locationId === locationId)) {
      throw new OrderBrandNotServedError(
        'Esta marca no está asignada a ninguna cocina activa del local indicado.',
        { brandId, locationId },
      );
    }
  }

  /**
   * Comprueba que el canal está aceptando en ese local (RN-KIT-04).
   *
   * La pausa la escribe Kitchen cuando la cocina se satura, y se consulta
   * aquí. La tabla es de Ordering justamente para que esta consulta no
   * obligue a depender de Kitchen —que ya depende de Ordering—.
   */
  private async assertChannelAccepting(
    tenantId: string,
    locationId: string,
    channel: string,
  ): Promise<void> {
    const pausa = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        reason: string | null;
        until: Date | null;
      }>(
        `SELECT reason, until FROM ord_channel_pauses
          WHERE location_id = $1 AND channel = $2
            AND (until IS NULL OR until > now())`,
        [locationId, channel],
      );
      return rows[0];
    });
    if (!pausa) return;

    const minutos =
      pausa.until === null
        ? null
        : Math.max(1, Math.ceil((pausa.until.getTime() - Date.now()) / 60_000));

    throw new ChannelPausedError(
      pausa.reason ??
        'La cocina no da abasto ahora mismo y este canal está pausado.',
      {
        channel,
        // Que el cliente pueda decir «vuelve en 20 min» en vez de «error» es la
        // diferencia entre aplazar la venta y perderla.
        ...(minutos !== null ? { retryAfterMinutes: minutos } : {}),
      },
    );
  }

  /**
   * Pausa o reabre un canal en un local.
   *
   * Público en la API del módulo porque quien lo llama es **Kitchen**, al
   * saturarse. `paused_by` distingue el origen y no es cosmético: el
   * despausado automático NO levanta una pausa que puso una persona. Si el
   * encargado cerró Rappi porque se quedó sin pollo, que la cocina se
   * descongestione no significa que ya haya pollo.
   */
  async setChannelPause(
    tenantId: string,
    input: {
      locationId: string;
      channel: string;
      paused: boolean;
      pausedBy: 'kitchen' | 'manual';
      reason?: string | undefined;
      until?: Date | undefined;
    },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      // El local tiene que ser de este tenant. Sin esta comprobación, un id
      // ajeno choca contra la clave foránea y sale un 500 con SQL dentro: RLS
      // impide el daño, pero el error no dice nada y parece una avería nuestra.
      const { rows: local } = await client.query(
        'SELECT 1 FROM org_locations WHERE id = $1',
        [input.locationId],
      );
      if (local.length === 0) throw new NotFoundError('Local no encontrado.');

      if (input.paused) {
        await client.query(
          `INSERT INTO ord_channel_pauses
             (tenant_id, location_id, channel, paused_by, reason, until)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, location_id, channel) DO UPDATE
             SET reason = EXCLUDED.reason,
                 until = EXCLUDED.until,
                 paused_at = now(),
                 -- Una pausa manual GANA sobre una automática: si ya la había
                 -- puesto una persona, la cocina no puede degradarla a
                 -- automática y luego levantarla sola.
                 paused_by = CASE
                   WHEN ord_channel_pauses.paused_by = 'manual' THEN 'manual'
                   ELSE EXCLUDED.paused_by END`,
          [
            tenantId,
            input.locationId,
            input.channel,
            input.pausedBy,
            input.reason ?? null,
            input.until ?? null,
          ],
        );
      } else {
        await client.query(
          `DELETE FROM ord_channel_pauses
            WHERE location_id = $1 AND channel = $2
              AND ($3 = 'manual' OR paused_by = 'kitchen')`,
          [input.locationId, input.channel, input.pausedBy],
        );
      }
    });
  }

  /** Canales pausados de un local. Para el panel y el KDS. */
  async pausedChannels(
    tenantId: string,
    locationId: string,
  ): Promise<
    Array<{ channel: string; pausedBy: string; reason: string | null }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        channel: string;
        paused_by: string;
        reason: string | null;
      }>(
        `SELECT channel, paused_by, reason FROM ord_channel_pauses
          WHERE location_id = $1 AND (until IS NULL OR until > now())
          ORDER BY channel`,
        [locationId],
      );
      return rows.map((r) => ({
        channel: r.channel,
        pausedBy: r.paused_by,
        reason: r.reason,
      }));
    });
  }

  /**
   * Traduce líneas de entrada a líneas de dominio resolviendo precio,
   * disponibilidad y modificadores del canal. Compartido por `submit`,
   * `modify` y `resolveMapping`: si cada uno resolviera precios a su manera,
   * modificar un pedido podría cobrarlo con reglas distintas a crearlo.
   */
  private async resolveLines(
    tenantId: string,
    input: {
      brandId: string;
      locationId: string;
      channel: string;
      lines: SubmitLineInput[];
    },
  ): Promise<{
    domainLines: OrderLineInput[];
    porId: Map<
      string,
      Awaited<
        ReturnType<CatalogService['getResolvedCatalog']>
      >['products'][number]
    >;
  }> {
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

    return { domainLines, porId };
  }

  /** Cabecera del pedido: lo mínimo para poder recalcularlo. */
  private async loadHeader(
    tenantId: string,
    orderId: string,
  ): Promise<{
    status: OrderState;
    brandId: string;
    locationId: string;
    channel: string;
    deliveryFee: string;
    tip: string;
    deliveryLat: number | null;
    deliveryLng: number | null;
    rowVersion: number;
  }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, orderId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new NotFoundError('Pedido no encontrado.');
      return {
        status: row.status as OrderState,
        brandId: row.brandId,
        locationId: row.locationId,
        channel: row.channel,
        deliveryFee: row.deliveryFee,
        tip: row.tip,
        deliveryLat: row.deliveryLat,
        deliveryLng: row.deliveryLng,
        rowVersion: row.rowVersion,
      };
    });
  }

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
      rowVersion: row.rowVersion,
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
