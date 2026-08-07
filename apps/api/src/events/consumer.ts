import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenant } from '../database/rls.js';
import { alreadyProcessed, markProcessed } from './outbox.js';
import { withSpan } from '../observability/tracing.js';
import {
  eventsConsumed,
  eventsConsumeErrors,
} from '../observability/metrics.js';
import type {
  DomainEventHandler,
  DomainEventMessage,
} from '../modules/kitchen/index.js';

/**
 * Mitad de CONSUMIDOR del patrón outbox/inbox (ADR-0007).
 *
 * El relay entrega at-least-once: el mismo evento puede llegar dos veces si el
 * proceso murió entre publicar y marcar. Aquí se convierte en
 * exactamente-una-vez EFECTIVO: el efecto y la marca en `inbox` se escriben en
 * la MISMA transacción de tenant. O pasan las dos cosas, o ninguna.
 *
 * La alternativa habitual —comprobar antes, aplicar después— tiene una ventana
 * entre las dos operaciones; con dos workers y un reintento, esa ventana
 * significa un pedido cocinado dos veces.
 */

export type EventOutcome = 'processed' | 'skipped' | 'ignored';

export interface ConsumeOptions {
  pool: Pool;
  consumer: string;
  handlers: Record<string, DomainEventHandler>;
}

const logger = new Logger('EventConsumer');

/**
 * Procesa un evento entregado por la cola. Devuelve qué hizo:
 *  · `processed` — se aplicó el efecto y quedó registrado.
 *  · `skipped`   — ya estaba en `inbox`: entrega repetida, nada que hacer.
 *  · `ignored`   — nadie escucha ese tipo de evento (normal y esperable).
 */
export async function consumeEvent(
  options: ConsumeOptions,
  event: DomainEventMessage,
): Promise<EventOutcome> {
  const handler = options.handlers[event.eventType];
  if (!handler) return 'ignored';

  try {
    const resultado = await withSpan(
      `consume ${event.eventType}`,
      {
        'sahana.event.id': event.eventId,
        'sahana.event.type': event.eventType,
        'sahana.consumer': options.consumer,
        'sahana.origin.trace_id': event.traceId ?? 'sin-traza',
      },
      () =>
        withTenant(options.pool, event.tenantId, async (ctx) => {
          if (
            await alreadyProcessed(ctx, options.consumer, event.eventId)
          ) {
            return 'skipped' as const;
          }
          await handler(ctx, event);
          await markProcessed(ctx, options.consumer, event.eventId);
          return 'processed' as const;
        }),
    );

    eventsConsumed.inc({
      consumer: options.consumer,
      event_type: event.eventType,
      outcome: resultado,
    });
    return resultado;
  } catch (error) {
    eventsConsumeErrors.inc({
      consumer: options.consumer,
      event_type: event.eventType,
    });
    logger.error(
      `Fallo consumiendo ${event.eventType} (${event.eventId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Se propaga a BullMQ, que reintenta con backoff. Tragarse el error dejaría
    // el pedido sin ticket y sin nadie que lo note.
    throw error;
  }
}
