import type { Pool } from 'pg';
import { withSystem, type TenantContext } from '../database/rls.js';
import * as schema from '../database/schema/index.js';

/**
 * Productor y relay del patrón Outbox/Inbox (ADR-0007).
 *
 * Producir: `enqueueEvent` inserta en `outbox` usando la MISMA transacción y
 * conexión del cambio de estado (el `TenantContext` de `withTenant`). Si la
 * transacción hace rollback, el evento no existe: nunca hay evento sin efecto
 * ni efecto sin evento.
 *
 * Publicar: `relayOnce` reclama un lote con FOR UPDATE SKIP LOCKED, lo publica
 * (BullMQ inyectado) y marca `published_at`. At-least-once. Los consumidores
 * deduplican por `inbox` (ver `alreadyProcessed`/`markProcessed`) para lograr
 * exactamente-una-vez efectivo.
 */

export interface DomainEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxRecord {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

/** Inserta un evento en el outbox dentro de la transacción de negocio. */
export async function enqueueEvent(
  ctx: TenantContext,
  event: DomainEventInput,
): Promise<void> {
  await ctx.db.insert(schema.outbox).values({
    tenantId: ctx.tenantId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
  });
}

/** Función de publicación (a BullMQ en producción; inyectable para pruebas). */
export type Publish = (event: OutboxRecord) => Promise<void>;

/**
 * Reclama y publica un lote de eventos no publicados. Cada evento se publica y
 * se marca `published_at` en la MISMA transacción de sistema, de modo que si el
 * proceso muere entre publicar y marcar, el evento sigue pendiente y se
 * re-publica (at-least-once). Devuelve el número de eventos publicados.
 */
export async function relayOnce(
  pool: Pool,
  publish: Publish,
  batchSize = 100,
): Promise<number> {
  return withSystem(pool, async ({ client }) => {
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
      attempts: number;
    }>(
      `SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, attempts
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY occurred_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batchSize],
    );

    for (const row of rows) {
      const record: OutboxRecord = {
        id: row.id,
        tenantId: row.tenant_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
      };
      // Si `publish` lanza, la transacción hace rollback: published_at sigue
      // NULL y el evento se reintenta en la siguiente vuelta.
      await publish(record);
      await client.query(
        'UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1',
        [row.id],
      );
    }
    return rows.length;
  });
}

/** Cuenta de eventos pendientes de publicar (métrica de salud del relay). */
export async function pendingCount(pool: Pool): Promise<number> {
  return withSystem(pool, async ({ client }) => {
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL',
    );
    return Number(rows[0]?.count ?? 0);
  });
}

/**
 * Dedup del consumidor (inbox). Se llama DENTRO de la transacción tenant del
 * efecto: si ya está registrado, el consumidor omite el efecto (idempotencia).
 */
export async function alreadyProcessed(
  ctx: TenantContext,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const { rowCount } = await ctx.client.query(
    'SELECT 1 FROM inbox WHERE tenant_id = $1 AND consumer = $2 AND event_id = $3',
    [ctx.tenantId, consumer, eventId],
  );
  return (rowCount ?? 0) > 0;
}

/** Registra el procesamiento en inbox (misma transacción que el efecto). */
export async function markProcessed(
  ctx: TenantContext,
  consumer: string,
  eventId: string,
): Promise<void> {
  await ctx.db
    .insert(schema.inbox)
    .values({ tenantId: ctx.tenantId, consumer, eventId })
    .onConflictDoNothing();
}
