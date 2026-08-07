import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '../../../database/rls.js';
import {
  OrderingService,
  OrderInvalidTransitionError,
} from '../../ordering/index.js';
import { KitchenService } from './kitchen.service.js';
import { kitchenTicketLatency } from '../../../observability/metrics.js';

/**
 * Reacciones de Cocina a los eventos de dominio (ADR-0007).
 *
 * Aquí se cierra el ciclo que hasta ahora quedaba abierto: el pedido se acepta,
 * el evento sale del outbox, el worker lo entrega y COCINA SE ENTERA. Sin este
 * consumidor, `order.accepted` era un evento que nadie escuchaba.
 *
 * Los handlers reciben el `TenantContext` del consumidor para que su efecto y
 * la marca de `inbox` se escriban en la MISMA transacción: o hay ticket y queda
 * registrado como procesado, o no ocurre ninguna de las dos cosas. Esa es la
 * mitad de consumidor del exactamente-una-vez efectivo.
 */

export interface DomainEventMessage {
  eventId: string;
  tenantId: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  traceId?: string | null;
}

export type DomainEventHandler = (
  ctx: TenantContext,
  event: DomainEventMessage,
) => Promise<void>;

/** Nombre del consumidor en la tabla `inbox`. Cambiarlo reprocesa todo. */
export const KITCHEN_CONSUMER = 'kitchen';

@Injectable()
export class KitchenEventHandlers {
  private readonly logger = new Logger(KitchenEventHandlers.name);

  constructor(
    private readonly kitchen: KitchenService,
    private readonly ordering: OrderingService,
  ) {}

  /** Mapa evento → handler que el worker monta en el consumidor de la cola. */
  handlers(): Record<string, DomainEventHandler> {
    return {
      'order.accepted': async (ctx, event) => {
        const resultado = await this.kitchen.createTicketsForOrder(
          event.tenantId,
          event.aggregateId,
          {
            ctx,
            ...(event.traceId ? { traceId: event.traceId } : {}),
          },
        );
        if (resultado.alreadyExisted) {
          this.logger.debug(
            `Los tickets del pedido ${event.aggregateId} ya existían: entrega repetida.`,
          );
          return;
        }

        // SLO de la spec 07: aceptado → visible en cocina en menos de 5 s. Se
        // mide desde `accepted_at`, que es el instante que le importa al
        // negocio, y no desde que el worker recogió el evento — eso escondería
        // precisamente el retraso de la cola, que es donde suele estar.
        const { rows } = await ctx.client.query<{ segundos: string | null }>(
          `SELECT EXTRACT(EPOCH FROM (now() - accepted_at))::text AS segundos
             FROM ord_orders WHERE id = $1`,
          [event.aggregateId],
        );
        const segundos = Number(rows[0]?.segundos ?? 0);
        if (Number.isFinite(segundos) && segundos >= 0) {
          kitchenTicketLatency.observe(segundos);
        }
      },

      // Cocina empezó: el pedido entra en preparación (spec 05 §4).
      'kitchen.ticket_started': async (_ctx, event) => {
        await this.transitionOrder(event, 'start_preparing');
      },

      // Todos los tickets listos → el pedido está listo (RN-KIT-02).
      'kitchen.order_ready': async (_ctx, event) => {
        await this.transitionOrder(event, 'finish_preparing');
      },

      'kitchen.order_packed': async (_ctx, event) => {
        await this.transitionOrder(event, 'pack');
      },
    };
  }

  /**
   * Transiciona el pedido en SU PROPIA transacción.
   *
   * No comparte la del consumidor a propósito: `applyTransition` valida contra
   * la máquina de estados y necesita su cerrojo `FOR UPDATE` sobre el pedido.
   * Como contrapartida, una entrega repetida podría intentar la misma
   * transición dos veces — y por eso una transición ya aplicada se trata como
   * trabajo hecho y no como error. Es exactamente el caso que la máquina de
   * estados está para detectar.
   */
  private async transitionOrder(
    event: DomainEventMessage,
    transicion: 'start_preparing' | 'finish_preparing' | 'pack',
  ): Promise<void> {
    try {
      await this.ordering.applyTransition(
        event.tenantId,
        event.aggregateId,
        transicion,
        {
          actorType: 'system',
          ...(event.traceId ? { traceId: event.traceId } : {}),
        },
      );
    } catch (error) {
      if (error instanceof OrderInvalidTransitionError) {
        this.logger.debug(
          `El pedido ${event.aggregateId} ya no admite "${transicion}": entrega repetida o alguien se adelantó.`,
        );
        return;
      }
      throw error;
    }
  }
}
