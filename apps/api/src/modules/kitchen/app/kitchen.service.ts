import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { alergenosDe } from '@sahana/domain';
import { enqueueEvent } from '../../../events/outbox.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Cocina / KDS (spec 07, T4.16).
 *
 * Es donde el pedido deja de ser una fila y se convierte en comida. Hasta aquí
 * todo el flujo terminaba en un estado de base de datos que nadie miraba.
 *
 * La unidad de trabajo es el TICKET POR ESTACIÓN, no el pedido (RN-KIT-01). El
 * de la parrilla no necesita ver las bebidas; mandar el pedido entero a todas
 * las pantallas obliga a cada cocinero a filtrar mentalmente lo suyo, que es
 * justo el trabajo que el KDS existe para quitar.
 *
 * El pedido pasa a `ready` cuando TODOS sus tickets están listos (RN-KIT-02).
 * Esa decisión se toma aquí, no en cada pantalla: si cada estación pudiera
 * declarar el pedido listo, saldría a reparto sin las papas.
 */

export type TicketStatus = 'pending' | 'in_progress' | 'ready' | 'cancelled';

export interface TicketLine {
  id: string;
  productName: string;
  quantity: number;
  modifiersText: string | null;
  notes: string | null;
  /**
   * Alérgenos declarados cuando se hizo el pedido (docs/25: «banda roja»).
   *
   * `null` significa **no se registró** —pedidos anteriores a la migración
   * 0037— y NO «no lleva ninguno», que es `[]`. La cocina tiene que poder
   * distinguirlo: una comanda antigua sin dato no es una comanda inocua.
   */
  allergens: string[] | null;
}

export interface TicketView {
  id: string;
  orderId: string;
  orderNumber: number;
  stationId: string;
  stationName: string;
  brandId: string;
  brandName: string;
  /**
   * De dónde vino el pedido.
   *
   * El KDS lo necesita tanto como la marca: un pedido de Rappi tiene un
   * repartidor esperando en la puerta y uno de la tienda web es un reparto
   * programado. docs/25 pide color por canal «usado consistentemente», y en la
   * cocina —que es donde se decide qué se cocina antes— era donde faltaba.
   */
  channel: string;
  status: TicketStatus;
  promisedAt: string | null;
  startedAt: string | null;
  readyAt: string | null;
  createdAt: string;
  /** Minutos desde que entró en cocina; es lo que el cocinero mira primero. */
  waitingMinutes: number;
  /** true si ya pasó el compromiso con el cliente. */
  late: boolean;
  rowVersion: number;
  lines: TicketLine[];
}

export class TicketInvalidTransitionError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/ticket-invalid-transition';
  readonly title = 'Transición de ticket inválida';
  readonly code = 'TICKET_INVALID_TRANSITION';
}

/**
 * Se intentó deshacer fuera de la ventana o con el pedido ya fuera de cocina.
 *
 * 409 y no 422: lo pedido es legítimo, lo que pasa es que llega tarde. El
 * mensaje tiene que decir qué hacer, porque quien lo lee está de pie delante
 * de una pantalla con vapor.
 */
export class UndoWindowExpiredError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/ticket-undo-expired';
  readonly title = 'Ya no se puede deshacer';
  readonly code = 'TICKET_UNDO_EXPIRED';
}

export class PackChecklistIncompleteError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/pack-checklist-incomplete';
  readonly title = 'La verificación de empaque está incompleta';
  readonly code = 'PACK_CHECKLIST_INCOMPLETE';
}

export class OrderNotReadyError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/order-not-ready';
  readonly title = 'El pedido todavía no está listo para empacar';
  readonly code = 'ORDER_NOT_READY';
}

/** Transiciones permitidas del ticket. Lo que no está aquí, no ocurre. */
/**
 * Cuánto tiempo se puede deshacer un toque (ux/02 pide 8 s).
 *
 * En el servidor se da algo más de margen que en la pantalla: el reloj de una
 * tablet no es el del servidor, y un deshacer legítimo rechazado por medio
 * segundo de desfase obliga a llamar al encargado — exactamente lo que esto
 * viene a evitar. Más allá de treinta segundos ya no es un toque accidental,
 * es una corrección, y esa va por el panel con su motivo.
 */
export const UNDO_WINDOW_SECONDS = 30;

/**
 * Estados del pedido en los que la cocina todavía manda.
 *
 * A partir de `packed` el pedido está en una bolsa y probablemente en manos de
 * un repartidor: retroceder ahí sería reescribir lo que otra persona hizo
 * después.
 */
const ESTADOS_EN_COCINA = new Set(['accepted', 'preparing', 'ready']);

/** Adónde vuelve un ticket al deshacer. Es el inverso, no un estado nuevo. */
const UNDO_TARGET: Partial<Record<TicketStatus, TicketStatus>> = {
  in_progress: 'pending',
  ready: 'in_progress',
};

const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  pending: ['in_progress', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  ready: [],
  cancelled: [],
};

export interface CreateTicketsResult {
  ticketIds: string[];
  /** true si los tickets ya existían (el consumidor se ejecutó otra vez). */
  alreadyExisted: boolean;
}

@Injectable()
export class KitchenService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Crea los tickets de un pedido aceptado (RN-KIT-01).
   *
   * IDEMPOTENTE por diseño: el consumidor de `order.accepted` se ejecuta al
   * menos una vez (ADR-0007), así que un reintento tiene que ser inofensivo.
   * La garantía la da el índice único (pedido, estación), no un `SELECT` previo
   * — dos tickets del mismo pedido en la misma pantalla significan comida
   * cocinada dos veces.
   */
  async createTicketsForOrder(
    tenantId: string,
    orderId: string,
    options: {
      traceId?: string | undefined;
      /**
       * Transacción del consumidor de eventos. Cuando viene, los tickets y la
       * marca de `inbox` se escriben JUNTOS: o hay ticket y queda registrado
       * como procesado, o no ocurre ninguna de las dos cosas.
       */
      ctx?: TenantContext | undefined;
    } = {},
  ): Promise<CreateTicketsResult> {
    const trabajo = async (
      ctx: TenantContext,
    ): Promise<CreateTicketsResult> => {
      const pedido = await this.loadOrderForKitchen(ctx, orderId);

      // Cocina destino: la que produce la marca en ese local (RN-ORG-01). El
      // submit ya validó que existe, así que aquí no debería fallar nunca;
      // si falla, es que la configuración cambió entre medias.
      const { rows: cocinas } = await ctx.client.query<{ id: string }>(
        `SELECT k.id
           FROM org_kitchens k
           JOIN org_brand_kitchens bk
             ON bk.kitchen_id = k.id AND bk.tenant_id = k.tenant_id
          WHERE k.location_id = $1 AND bk.brand_id = $2
            AND k.active = true AND bk.active = true
          ORDER BY k.created_at
          LIMIT 1`,
        [pedido.locationId, pedido.brandId],
      );
      const kitchenId = cocinas[0]?.id;
      if (!kitchenId) {
        throw new ValidationError(
          'El pedido no tiene cocina destino: la marca dejó de estar asignada a una cocina del local.',
          { orderId, brandId: pedido.brandId },
        );
      }

      const estaciones = await ctx.db
        .select()
        .from(schema.stations)
        .where(
          and(
            eq(schema.stations.kitchenId, kitchenId),
            eq(schema.stations.active, true),
          ),
        )
        .orderBy(asc(schema.stations.sortOrder));

      if (estaciones.length === 0) {
        throw new ValidationError(
          'La cocina destino no tiene estaciones activas: no hay dónde mandar el ticket.',
          { kitchenId },
        );
      }

      // Estación por defecto: la primera por orden. Un negocio que empieza con
      // una sola estación no debería tener que configurar nada.
      const porDefecto = estaciones[0]!;
      const porKind = new Map(
        estaciones.filter((e) => e.kind !== null).map((e) => [e.kind!, e]),
      );

      // Reparto de líneas por estación.
      const lineasPorEstacion = new Map<string, typeof pedido.lines>();
      for (const linea of pedido.lines) {
        const estacion =
          (linea.stationKind !== null
            ? porKind.get(linea.stationKind)
            : undefined) ?? porDefecto;
        const acumulado = lineasPorEstacion.get(estacion.id) ?? [];
        acumulado.push(linea);
        lineasPorEstacion.set(estacion.id, acumulado);
      }

      const ticketIds: string[] = [];
      let creadoAlguno = false;

      for (const [stationId, lineas] of lineasPorEstacion) {
        const insertado = await ctx.db
          .insert(schema.kitchenTickets)
          .values({
            tenantId,
            orderId,
            kitchenId,
            stationId,
            brandId: pedido.brandId,
            orderNumber: pedido.orderNumber,
            promisedAt: pedido.promisedAt,
          })
          .onConflictDoNothing()
          .returning({ id: schema.kitchenTickets.id });

        if (!insertado[0]) {
          // Ya existía: es un reintento del consumidor. Se recupera su id para
          // devolverlo, pero NO se vuelven a insertar líneas.
          const { rows } = await ctx.client.query<{ id: string }>(
            'SELECT id FROM kit_tickets WHERE order_id = $1 AND station_id = $2',
            [orderId, stationId],
          );
          if (rows[0]) ticketIds.push(rows[0].id);
          continue;
        }

        creadoAlguno = true;
        const ticketId = insertado[0].id;
        ticketIds.push(ticketId);

        await ctx.db.insert(schema.kitchenTicketLines).values(
          lineas.map((l) => ({
            tenantId,
            ticketId,
            orderLineId: l.id,
            // SNAPSHOT: si alguien toca el catálogo con el pedido en la
            // plancha, lo que el cocinero ve no cambia bajo sus manos.
            productName: l.productName,
            quantity: l.quantity,
            modifiersText: l.modifiersText,
            notes: l.notes,
          })),
        );
      }

      if (creadoAlguno) {
        await enqueueEvent(ctx, {
          aggregateType: 'order',
          aggregateId: orderId,
          eventType: 'kitchen.tickets_created',
          payload: {
            orderId,
            orderNumber: pedido.orderNumber,
            kitchenId,
            tickets: ticketIds.length,
          },
          ...(options.traceId !== undefined
            ? { traceId: options.traceId }
            : {}),
        });
      }

      return { ticketIds, alreadyExisted: !creadoAlguno };
    };

    return options.ctx
      ? trabajo(options.ctx)
      : withTenant(this.pool, tenantId, trabajo);
  }

  /** Cola de una estación, ordenada por compromiso con el cliente. */
  async queue(
    tenantId: string,
    query: { stationId?: string; kitchenId?: string; now?: Date },
  ): Promise<TicketView[]> {
    const now = query.now ?? new Date();

    return withTenant(this.pool, tenantId, async (ctx) => {
      // La cocina o la estación tienen que ser DE ESTE TENANT. Sin esta
      // comprobación, preguntar por una cocina ajena devuelve una cola vacía
      // —indistinguible de «tu cocina no tiene trabajo»— en vez de decir que
      // ese recurso no existe para ti.
      await this.assertOwnScope(ctx, query);

      const condiciones = [
        inArray(schema.kitchenTickets.status, ['pending', 'in_progress']),
      ];
      if (query.stationId) {
        condiciones.push(eq(schema.kitchenTickets.stationId, query.stationId));
      }
      if (query.kitchenId) {
        condiciones.push(eq(schema.kitchenTickets.kitchenId, query.kitchenId));
      }

      const filas = await ctx.db
        .select()
        .from(schema.kitchenTickets)
        .where(and(...condiciones))
        // Por COMPROMISO y no por hora de llegada: un pedido programado que
        // entra tarde puede ser lo más urgente de la pantalla.
        .orderBy(asc(schema.kitchenTickets.promisedAt));

      return this.hydrate(ctx, filas, now);
    });
  }

  async getTicket(
    tenantId: string,
    ticketId: string,
    now = new Date(),
  ): Promise<TicketView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const filas = await ctx.db
        .select()
        .from(schema.kitchenTickets)
        .where(eq(schema.kitchenTickets.id, ticketId))
        .limit(1);
      if (!filas[0]) throw new NotFoundError('Ticket no encontrado.');
      const [vista] = await this.hydrate(ctx, filas, now);
      return vista!;
    });
  }

  /** Tickets de un pedido, sin filtrar por estado. */
  async ticketsForOrder(
    tenantId: string,
    orderId: string,
    now = new Date(),
  ): Promise<TicketView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const filas = await ctx.db
        .select()
        .from(schema.kitchenTickets)
        .where(eq(schema.kitchenTickets.orderId, orderId));
      return this.hydrate(ctx, filas, now);
    });
  }

  /** El cocinero empieza a preparar (1 toque desde la cola). */
  async startTicket(
    tenantId: string,
    ticketId: string,
    actor: { actorId?: string | undefined; traceId?: string | undefined } = {},
  ): Promise<{ ticket: TicketView; orderStartedPreparing: boolean }> {
    const resultado = await this.transition(
      tenantId,
      ticketId,
      'in_progress',
      actor,
    );
    return {
      ticket: resultado.ticket,
      // El primer ticket que arranca es el que mete el pedido en `preparing`
      // (spec 05: «accepted→preparing: primer ticket iniciado»).
      orderStartedPreparing: resultado.firstOfOrder,
    };
  }

  /**
   * El cocinero termina su parte. Si era el último ticket del pedido, emite
   * `kitchen.order_ready` para que Ordering lo transicione (RN-KIT-02).
   */
  async readyTicket(
    tenantId: string,
    ticketId: string,
    actor: { actorId?: string | undefined; traceId?: string | undefined } = {},
  ): Promise<{ ticket: TicketView; orderReady: boolean }> {
    const resultado = await this.transition(tenantId, ticketId, 'ready', actor);
    return { ticket: resultado.ticket, orderReady: resultado.allReady };
  }

  /**
   * Deshacer el último toque de un ticket (ux/02, salda DT-11).
   *
   * Un cocinero con las manos ocupadas toca la tarjeta con el codo. Sin esto,
   * la única salida era buscar al encargado en mitad del servicio.
   *
   * ### Las dos barreras, y por qué son dos
   *
   *  1. **Ventana de tiempo.** Pasados unos segundos ya no es un toque
   *     accidental: es una corrección, y una corrección lleva motivo y se hace
   *     desde el panel. Sin esta barrera, «deshacer» sería una forma cómoda de
   *     reescribir cuánto tardó la cocina.
   *  2. **El pedido sigue en cocina.** En cuanto se empaca o se despacha, dejó
   *     de estar en manos de quien mira esta pantalla: retroceder ahí sería
   *     reescribir lo que otra persona hizo después, y el cliente ya tiene la
   *     bolsa.
   *
   * Si el pedido había pasado a `ready` porque este era el último ticket, se
   * emite `kitchen.order_resumed` para devolverlo a `preparing`. Deshacer el
   * ticket sin devolver el pedido dejaría a la cocina trabajando en algo que
   * el resto del sistema da por terminado — que es peor que no deshacer.
   *
   * **Queda auditado.** Es una corrección de un hecho ya registrado: sin
   * traza, los tiempos de cocina se vuelven negociables.
   */
  async undoTicket(
    tenantId: string,
    ticketId: string,
    actor: { actorId?: string | undefined; traceId?: string | undefined } = {},
  ): Promise<{ ticket: TicketView; orderResumed: boolean }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        status: TicketStatus;
        order_id: string;
        row_version: number;
        updated_at: Date;
        order_status: string;
      }>(
        `SELECT t.status, t.order_id, t.row_version, t.updated_at,
                o.status AS order_status
           FROM kit_tickets t
           JOIN ord_orders o ON o.id = t.order_id
          WHERE t.id = $1
          FOR UPDATE OF t`,
        [ticketId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Ticket no encontrado.');

      const destino = UNDO_TARGET[actual.status];
      if (!destino) {
        throw new TicketInvalidTransitionError(
          `Un ticket en "${actual.status}" no tiene nada que deshacer.`,
          { from: actual.status },
        );
      }

      const segundos = (Date.now() - actual.updated_at.getTime()) / 1000;
      if (segundos > UNDO_WINDOW_SECONDS) {
        throw new UndoWindowExpiredError(
          'Pasó el tiempo para deshacer. Pídelo al encargado desde el panel, con el motivo.',
          { seconds: Math.round(segundos), window: UNDO_WINDOW_SECONDS },
        );
      }

      // El pedido tiene que seguir EN COCINA. `packed` en adelante ya salió.
      //
      // `accepted` cuenta: el cocinero acaba de arrancar el ticket y el evento
      // que mueve el pedido a `preparing` puede no haberse consumido todavía
      // —el relay tarda segundos—. Dejarlo fuera bloqueaba justo el caso más
      // frecuente: tocar por error y deshacer al instante. Lo destapó la
      // prueba de auditoría.
      if (!ESTADOS_EN_COCINA.has(actual.order_status)) {
        throw new UndoWindowExpiredError(
          `El pedido ya está en "${actual.order_status}": salió de cocina y no se puede retroceder desde aquí.`,
          { orderStatus: actual.order_status },
        );
      }

      const ahora = new Date();
      await ctx.db
        .update(schema.kitchenTickets)
        .set({
          status: destino,
          rowVersion: actual.row_version + 1,
          updatedAt: ahora,
          // Se limpian las marcas de tiempo del paso deshecho: dejarlas haría
          // que el ticket contara como iniciado o listo en las métricas de
          // cocina, y esas alimentan la promesa que se le da al cliente.
          ...(actual.status === 'ready' ? { readyAt: null } : {}),
          ...(actual.status === 'in_progress' ? { startedAt: null } : {}),
        })
        .where(eq(schema.kitchenTickets.id, ticketId));

      // ¿El pedido estaba dado por listo gracias a este ticket?
      const orderResumed =
        actual.status === 'ready' && actual.order_status === 'ready';
      if (orderResumed) {
        await enqueueEvent(ctx, {
          aggregateType: 'order',
          aggregateId: actual.order_id,
          eventType: 'kitchen.order_resumed',
          payload: { orderId: actual.order_id, ticketId },
          ...(actor.traceId !== undefined ? { traceId: actor.traceId } : {}),
        });
      }

      await recordAudit(ctx, {
        actorType: 'user',
        ...(actor.actorId !== undefined ? { actorId: actor.actorId } : {}),
        action: 'kitchen.ticket_undone',
        resourceType: 'kitchen_ticket',
        resourceId: ticketId,
        ...(actor.traceId !== undefined ? { traceId: actor.traceId } : {}),
        data: { from: actual.status, to: destino, orderResumed },
      });

      const filas = await ctx.db
        .select()
        .from(schema.kitchenTickets)
        .where(eq(schema.kitchenTickets.id, ticketId))
        .limit(1);
      const [vista] = await this.hydrate(ctx, filas, ahora);
      return { ticket: vista!, orderResumed };
    });
  }

  /**
   * Verificación de empaque (RN-KIT-03).
   *
   * El checklist tiene que cubrir TODAS las líneas del pedido. Es la
   * comprobación que evita el fallo más caro y más frecuente del delivery:
   * mandar el pedido incompleto, que cuesta el pedido entero más el reparto
   * más la reputación.
   */
  async packOrder(
    tenantId: string,
    orderId: string,
    input: {
      checkedLineIds: string[];
      actorId?: string | undefined;
      traceId?: string | undefined;
    },
  ): Promise<{ brandId: string; brandName: string; lines: number }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const pedido = await this.loadOrderForKitchen(ctx, orderId);

      const tickets = await ctx.db
        .select({ status: schema.kitchenTickets.status })
        .from(schema.kitchenTickets)
        .where(eq(schema.kitchenTickets.orderId, orderId));

      const pendientes = tickets.filter(
        (t) => t.status !== 'ready' && t.status !== 'cancelled',
      );
      if (tickets.length > 0 && pendientes.length > 0) {
        throw new OrderNotReadyError(
          `Faltan ${pendientes.length} tickets por terminar: empacar ahora sería mandar comida a medio hacer.`,
          { pendingTickets: pendientes.length },
        );
      }

      const esperadas = pedido.lines.map((l) => l.id);
      const marcadas = new Set(input.checkedLineIds);
      const faltantes = esperadas.filter((id) => !marcadas.has(id));

      if (faltantes.length > 0) {
        throw new PackChecklistIncompleteError(
          `Quedan ${faltantes.length} líneas sin verificar. Empacar sin comprobarlas es como sale el pedido incompleto.`,
          { missingLineIds: faltantes },
        );
      }

      // RN-KIT-03: la etiqueta lleva la marca DEL PEDIDO. Se devuelve
      // explícitamente y el llamador la imprime; en un local multimarca,
      // etiquetar con la marca equivocada es un error visible para el cliente.
      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: orderId,
        eventType: 'kitchen.order_packed',
        payload: {
          orderId,
          orderNumber: pedido.orderNumber,
          brandId: pedido.brandId,
          brandName: pedido.brandName,
          lines: esperadas.length,
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'kitchen.order_packed',
        resourceType: 'order',
        resourceId: orderId,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { lines: esperadas.length, brandId: pedido.brandId },
      });

      return {
        brandId: pedido.brandId,
        brandName: pedido.brandName,
        lines: esperadas.length,
      };
    });
  }

  /**
   * Carga actual de la cocina (`GET /kitchen/load`). Es la base de la
   * saturación de F5, y ya hoy responde la pregunta que un encargado hace a
   * ojo: cuántos ítems hay en marcha y cuál es la estación atascada.
   */
  async load(
    tenantId: string,
    kitchenId: string,
    now = new Date(),
  ): Promise<{
    kitchenId: string;
    activeTickets: number;
    activeItems: number;
    lateTickets: number;
    byStation: Array<{
      stationId: string;
      stationName: string;
      tickets: number;
      items: number;
      oldestWaitingMinutes: number;
    }>;
  }> {
    // `queue` valida que la cocina sea del tenant y lanza 404 si no.
    const cola = await this.queue(tenantId, { kitchenId, now });

    const porEstacion = new Map<
      string,
      { stationName: string; tickets: number; items: number; oldest: number }
    >();
    let activeItems = 0;

    for (const t of cola) {
      const items = t.lines.reduce((suma, l) => suma + l.quantity, 0);
      activeItems += items;
      const actual = porEstacion.get(t.stationId) ?? {
        stationName: t.stationName,
        tickets: 0,
        items: 0,
        oldest: 0,
      };
      actual.tickets++;
      actual.items += items;
      actual.oldest = Math.max(actual.oldest, t.waitingMinutes);
      porEstacion.set(t.stationId, actual);
    }

    return {
      kitchenId,
      activeTickets: cola.length,
      activeItems,
      lateTickets: cola.filter((t) => t.late).length,
      byStation: [...porEstacion.entries()].map(([stationId, v]) => ({
        stationId,
        stationName: v.stationName,
        tickets: v.tickets,
        items: v.items,
        oldestWaitingMinutes: v.oldest,
      })),
    };
  }

  // ------------------------------------------------------------- Internos

  /**
   * Comprueba que la estación o la cocina consultadas pertenecen al tenant.
   *
   * La RLS ya impide LEER filas ajenas, así que sin esto no hay fuga de datos;
   * lo que hay es una respuesta ambigua. Un 404 explícito distingue «no existe
   * para ti» de «no hay trabajo», que en una pantalla de cocina son dos cosas
   * muy distintas: la primera es un error de configuración y la segunda, un
   * turno tranquilo.
   */
  private async assertOwnScope(
    ctx: TenantContext,
    query: { stationId?: string; kitchenId?: string },
  ): Promise<void> {
    if (query.stationId) {
      const { rowCount } = await ctx.client.query(
        'SELECT 1 FROM org_stations WHERE id = $1',
        [query.stationId],
      );
      if ((rowCount ?? 0) === 0) {
        throw new NotFoundError('Estación no encontrada.');
      }
    }
    if (query.kitchenId) {
      const { rowCount } = await ctx.client.query(
        'SELECT 1 FROM org_kitchens WHERE id = $1',
        [query.kitchenId],
      );
      if ((rowCount ?? 0) === 0) {
        throw new NotFoundError('Cocina no encontrada.');
      }
    }
  }

  private async transition(
    tenantId: string,
    ticketId: string,
    destino: TicketStatus,
    actor: { actorId?: string | undefined; traceId?: string | undefined },
  ): Promise<{
    ticket: TicketView;
    allReady: boolean;
    firstOfOrder: boolean;
  }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      // FOR UPDATE: dos cocineros tocando la misma pantalla a la vez se
      // serializan. Sin cerrojo, ambos leerían `pending` y el segundo pisaría
      // la marca de tiempo del primero.
      const { rows } = await ctx.client.query<{
        status: TicketStatus;
        order_id: string;
        row_version: number;
      }>(
        'SELECT status, order_id, row_version FROM kit_tickets WHERE id = $1 FOR UPDATE',
        [ticketId],
      );
      const actual = rows[0];
      if (!actual) throw new NotFoundError('Ticket no encontrado.');

      if (!TICKET_TRANSITIONS[actual.status].includes(destino)) {
        throw new TicketInvalidTransitionError(
          `Un ticket en "${actual.status}" no puede pasar a "${destino}".`,
          { from: actual.status, to: destino },
        );
      }

      const ahora = new Date();
      await ctx.db
        .update(schema.kitchenTickets)
        .set({
          status: destino,
          rowVersion: actual.row_version + 1,
          updatedAt: ahora,
          ...(destino === 'in_progress' ? { startedAt: ahora } : {}),
          ...(destino === 'ready' ? { readyAt: ahora } : {}),
        })
        .where(eq(schema.kitchenTickets.id, ticketId));

      // ¿Es el primero del pedido que arranca? ¿Es el último que termina?
      // Ambas preguntas se responden DENTRO de la misma transacción: hacerlo
      // fuera abriría una ventana en la que dos estaciones terminan a la vez y
      // ninguna se cree la última.
      const { rows: hermanos } = await ctx.client.query<{
        total: string;
        listos: string;
        arrancados: string;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status IN ('ready','cancelled'))::text AS listos,
                count(*) FILTER (WHERE status <> 'pending')::text AS arrancados
           FROM kit_tickets WHERE order_id = $1`,
        [actual.order_id],
      );
      const total = Number(hermanos[0]!.total);
      const listos = Number(hermanos[0]!.listos);
      const arrancados = Number(hermanos[0]!.arrancados);

      const allReady = destino === 'ready' && listos === total;
      const firstOfOrder = destino === 'in_progress' && arrancados === 1;

      if (allReady) {
        await enqueueEvent(ctx, {
          aggregateType: 'order',
          aggregateId: actual.order_id,
          eventType: 'kitchen.order_ready',
          payload: { orderId: actual.order_id, tickets: total },
          ...(actor.traceId !== undefined ? { traceId: actor.traceId } : {}),
        });
      } else if (firstOfOrder) {
        await enqueueEvent(ctx, {
          aggregateType: 'order',
          aggregateId: actual.order_id,
          eventType: 'kitchen.ticket_started',
          payload: { orderId: actual.order_id, ticketId },
          ...(actor.traceId !== undefined ? { traceId: actor.traceId } : {}),
        });
      }

      const filas = await ctx.db
        .select()
        .from(schema.kitchenTickets)
        .where(eq(schema.kitchenTickets.id, ticketId))
        .limit(1);
      const [vista] = await this.hydrate(ctx, filas, ahora);

      return { ticket: vista!, allReady, firstOfOrder };
    });
  }

  /** Completa los tickets con sus líneas y los nombres que ve el cocinero. */
  private async hydrate(
    ctx: TenantContext,
    filas: Array<typeof schema.kitchenTickets.$inferSelect>,
    now: Date,
  ): Promise<TicketView[]> {
    if (filas.length === 0) return [];

    const ids = filas.map((f) => f.id);
    // Los alérgenos se leen de `ord_order_lines` y NO se copian otra vez aquí:
    // esa fila ya es un snapshot inmutable del momento del pedido, así que
    // duplicarla solo abriría la puerta a que las dos copias discrepen. Una
    // unión por lote, no una consulta por línea.
    const lineas = await ctx.db
      .select({
        id: schema.kitchenTicketLines.id,
        ticketId: schema.kitchenTicketLines.ticketId,
        productName: schema.kitchenTicketLines.productName,
        quantity: schema.kitchenTicketLines.quantity,
        modifiersText: schema.kitchenTicketLines.modifiersText,
        notes: schema.kitchenTicketLines.notes,
        allergens: schema.orderLines.allergens,
      })
      .from(schema.kitchenTicketLines)
      .leftJoin(
        schema.orderLines,
        eq(schema.kitchenTicketLines.orderLineId, schema.orderLines.id),
      )
      .where(inArray(schema.kitchenTicketLines.ticketId, ids));

    const estaciones = await ctx.db
      .select({ id: schema.stations.id, name: schema.stations.name })
      .from(schema.stations)
      .where(
        inArray(schema.stations.id, [
          ...new Set(filas.map((f) => f.stationId)),
        ]),
      );
    const marcas = await ctx.db
      .select({ id: schema.brands.id, name: schema.brands.name })
      .from(schema.brands)
      .where(
        inArray(schema.brands.id, [...new Set(filas.map((f) => f.brandId))]),
      );

    // El canal vive en el pedido, no en el ticket: un ticket es una porción de
    // un pedido para una estación, y duplicar ahí el canal abriría la puerta a
    // que los dos discrepen. Una consulta más por lote, no por ticket.
    const pedidos = await ctx.db
      .select({ id: schema.orders.id, channel: schema.orders.channel })
      .from(schema.orders)
      .where(
        inArray(schema.orders.id, [...new Set(filas.map((f) => f.orderId))]),
      );

    const nombreEstacion = new Map(estaciones.map((e) => [e.id, e.name]));
    const nombreMarca = new Map(marcas.map((m) => [m.id, m.name]));
    const canalDe = new Map(pedidos.map((p) => [p.id, p.channel]));

    const porTicket = new Map<string, TicketLine[]>();
    for (const l of lineas) {
      const acumulado = porTicket.get(l.ticketId) ?? [];
      acumulado.push({
        id: l.id,
        productName: l.productName,
        quantity: l.quantity,
        modifiersText: l.modifiersText,
        notes: l.notes,
        // `null` se conserva tal cual: es «no se registró». Solo se normaliza
        // lo que sí hay, porque el `jsonb` puede traer cualquier cosa.
        allergens: l.allergens === null ? null : alergenosDe(l.allergens),
      });
      porTicket.set(l.ticketId, acumulado);
    }

    return filas.map((f) => ({
      id: f.id,
      orderId: f.orderId,
      orderNumber: f.orderNumber,
      stationId: f.stationId,
      stationName: nombreEstacion.get(f.stationId) ?? 'Estación',
      brandId: f.brandId,
      brandName: nombreMarca.get(f.brandId) ?? 'Marca',
      // Sin canal conocido se manda cadena vacía y la pantalla la pinta como
      // «desconocido»: inventar «web» escondería que no lo sabemos, y el pedido
      // de origen dudoso es justo el que hay que mirar.
      channel: canalDe.get(f.orderId) ?? '',
      status: f.status as TicketStatus,
      promisedAt: f.promisedAt?.toISOString() ?? null,
      startedAt: f.startedAt?.toISOString() ?? null,
      readyAt: f.readyAt?.toISOString() ?? null,
      createdAt: f.createdAt.toISOString(),
      waitingMinutes: Math.max(
        0,
        Math.round((now.getTime() - f.createdAt.getTime()) / 60_000),
      ),
      late: f.promisedAt !== null && f.promisedAt.getTime() < now.getTime(),
      rowVersion: f.rowVersion,
      lines: porTicket.get(f.id) ?? [],
    }));
  }

  /** Cabecera y líneas del pedido, con lo que cocina necesita de cada una. */
  private async loadOrderForKitchen(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{
    brandId: string;
    brandName: string;
    locationId: string;
    orderNumber: number;
    promisedAt: Date | null;
    lines: Array<{
      id: string;
      productName: string;
      quantity: number;
      modifiersText: string | null;
      notes: string | null;
      stationKind: string | null;
    }>;
  }> {
    const { rows: cabecera } = await ctx.client.query<{
      brand_id: string;
      brand_name: string;
      location_id: string;
      order_number: number;
      promised_at: Date | null;
    }>(
      `SELECT o.brand_id, b.name AS brand_name, o.location_id,
              o.order_number, o.promised_at
         FROM ord_orders o
         JOIN org_brands b ON b.id = o.brand_id AND b.tenant_id = o.tenant_id
        WHERE o.id = $1`,
      [orderId],
    );
    const pedido = cabecera[0];
    if (!pedido) throw new NotFoundError('Pedido no encontrado.');

    const { rows: lineas } = await ctx.client.query<{
      id: string;
      product_name: string;
      quantity: number;
      modifiers: Array<{ name?: string }>;
      notes: string | null;
      station_kind: string | null;
    }>(
      // Solo las líneas VIGENTES: una modificación sustituye líneas
      // (RN-ORD-07) y la cocina debe preparar lo último, no el histórico.
      `SELECT l.id, l.product_name, l.quantity, l.modifiers, l.notes,
              p.station_kind
         FROM ord_order_lines l
         LEFT JOIN cat_products p
           ON p.id = l.product_id AND p.tenant_id = l.tenant_id
        WHERE l.order_id = $1 AND l.is_adjustment = false
        ORDER BY l.created_at`,
      [orderId],
    );

    return {
      brandId: pedido.brand_id,
      brandName: pedido.brand_name,
      locationId: pedido.location_id,
      orderNumber: pedido.order_number,
      promisedAt: pedido.promised_at,
      lines: lineas.map((l) => ({
        id: l.id,
        productName: l.product_name,
        quantity: l.quantity,
        // Texto ya resuelto: el cocinero no interpreta ids a las 21:00 con
        // veinte pedidos encima.
        modifiersText:
          Array.isArray(l.modifiers) && l.modifiers.length > 0
            ? l.modifiers
                .map((m) => m.name ?? '')
                .filter(Boolean)
                .join(', ')
            : null,
        notes: l.notes,
        stationKind: l.station_kind,
      })),
    };
  }
}
