import { Injectable, Logger } from '@nestjs/common';
import { MessagingService } from './messaging.service.js';
import type { DomainEventHandler } from '../../kitchen/index.js';

/**
 * Avisos de estado disparados por eventos (spec 12, ADR-0007).
 *
 * Se enganchan a los eventos y NO a la transacción del pedido, y eso es la
 * regla del módulo: un timeout de Meta no puede dejar un pedido sin aceptar.
 * La comida sale igual aunque el aviso no llegue.
 *
 * Por el mismo motivo un fallo de envío no relanza el evento: se registra y se
 * sigue. Reintentar en bucle un número que no existe en WhatsApp llenaría la
 * cola de trabajos condenados, y el `inbox` marcaría el evento como pendiente
 * para siempre.
 */
export const MESSAGING_CONSUMER = 'messaging';

@Injectable()
export class MessagingEventHandlers {
  private readonly logger = new Logger(MessagingEventHandlers.name);

  constructor(private readonly messaging: MessagingService) {}

  handlers(): Record<string, DomainEventHandler> {
    const avisar =
      (estado: string): DomainEventHandler =>
      async (ctx, event) => {
        try {
          const r = await this.messaging.notifyOrderState(
            event.tenantId,
            event.aggregateId,
            estado,
            { ctx, ...(event.traceId ? { traceId: event.traceId } : {}) },
          );
          if (!r.sent) {
            this.logger.debug(
              `Sin aviso de "${estado}" para ${event.aggregateId}: ${r.reason}`,
            );
          }
        } catch (error) {
          // Se traga a propósito. Este handler comparte transacción con la
          // marca de `inbox`: dejar subir el error desharía la marca y el
          // evento volvería una y otra vez por un aviso que nunca va a salir.
          this.logger.error(
            `Fallo avisando "${estado}" del pedido ${event.aggregateId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      };

    return {
      'order.accepted': avisar('accepted'),
      'order.preparing': avisar('preparing'),
      'order.dispatched': avisar('dispatched'),
      'order.delivered': avisar('delivered'),
      'order.rejected': avisar('rejected'),
      'order.cancelled': avisar('cancelled'),
    };
  }
}
