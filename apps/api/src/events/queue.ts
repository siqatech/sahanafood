import { Queue } from 'bullmq';
// ioredis exporta la clase como `default` en CJS; con `verbatimModuleSyntax`
// y NodeNext, el named import no es constructable.
import { Redis } from 'ioredis';
import type { OutboxRecord, Publish } from './outbox.js';

/**
 * Publicación de eventos de dominio a BullMQ (ADR-0007).
 *
 * El relay lee del outbox y llama aquí. Dos detalles que no son adorno:
 *
 * - **`jobId` = id del evento del outbox.** BullMQ descarta un job cuyo `jobId`
 *   ya existe, así que si el relay reintenta un evento que sí llegó a
 *   publicarse (murió entre publicar y marcar `published_at`), no se duplica el
 *   trabajo. Es la mitad de cola del exactamente-una-vez efectivo; la otra
 *   mitad es la tabla `inbox` del consumidor.
 * - **`maxRetriesPerRequest: null`.** Lo exige BullMQ para conexiones de
 *   bloqueo. Con el valor por defecto de ioredis, una desconexión momentánea de
 *   Redis lanza un error irrecuperable y el worker deja de consumir.
 */

export const DOMAIN_EVENTS_QUEUE = 'sahana.domain-events';

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export interface QueuePublisher {
  publish: Publish;
  close: () => Promise<void>;
}

export function createQueuePublisher(connection: Redis): QueuePublisher {
  const queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });

  const publish: Publish = async (event: OutboxRecord) => {
    await queue.add(
      event.eventType,
      {
        eventId: event.id,
        tenantId: event.tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        occurredAt: event.occurredAt.toISOString(),
        // La traza viaja EN el mensaje: el contexto de OpenTelemetry no cruza
        // la cola por sí solo, y sin esto el salto request → worker parte la
        // traza justo donde más falta hace seguirla.
        traceId: event.traceId,
      },
      {
        jobId: event.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        // Se conservan los últimos fallos para poder diagnosticar; los éxitos
        // se limpian solos para que Redis no crezca sin fin.
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    );
  };

  return {
    publish,
    close: async () => {
      await queue.close();
    },
  };
}
