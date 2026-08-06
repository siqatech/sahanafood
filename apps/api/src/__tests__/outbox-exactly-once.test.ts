import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import * as schema from '../database/schema/index.js';
import {
  enqueueEvent,
  relayOnce,
  pendingCount,
  alreadyProcessed,
  markProcessed,
  type OutboxRecord,
} from '../events/outbox.js';
import { INTEGRATION_DB, createTestTenant, deleteTenants } from './helpers.js';

/**
 * Gate de la Fase 3 (T3.11, ADR-0007): un evento sobrevive al "kill" del relay
 * y produce su efecto EXACTAMENTE UNA VEZ.
 *
 * Escenario: el relay publica el evento (el consumidor aplica su efecto) pero el
 * proceso muere ANTES de marcar `published_at` → rollback → el evento sigue
 * pendiente y se re-publica (at-least-once). El consumidor, al deduplicar por
 * `inbox`, omite el segundo efecto → exactamente-una-vez efectivo.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Outbox/Inbox — exactamente-una-vez bajo kill del relay', () => {
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  let tenantId = '';
  const CONSUMER = 'test-consumer';

  beforeAll(async () => {
    tenantId = await createTestTenant(pool, 'OUTBOX');
  });

  afterAll(async () => {
    await deleteTenants(pool, [tenantId]);
    await pool.end();
  });

  /** Consumidor idempotente: aplica un efecto (una fila de auditoría) una vez. */
  async function handle(record: OutboxRecord): Promise<void> {
    await withTenant(pool, record.tenantId, async (ctx) => {
      if (await alreadyProcessed(ctx, CONSUMER, record.id)) {
        return; // ya procesado: no repetir el efecto
      }
      await ctx.db.insert(schema.auditLog).values({
        tenantId: record.tenantId,
        actorType: 'system',
        action: 'test.effect',
        resourceType: record.aggregateType,
        resourceId: record.aggregateId,
        data: { eventId: record.id },
      });
      await markProcessed(ctx, CONSUMER, record.id);
    });
  }

  async function effectCount(aggregateId: string): Promise<number> {
    return withTenant(pool, tenantId, async (ctx) => {
      const r = await ctx.db.execute(
        sql`SELECT count(*)::int AS c FROM audit_log WHERE action = 'test.effect' AND resource_id = ${aggregateId}`,
      );
      return (r.rows[0] as { c: number }).c;
    });
  }

  it('el efecto se aplica exactamente una vez pese al reintento', async () => {
    const aggregateId = 'order-123';

    // Productor: evento en el outbox dentro de la transacción de negocio.
    await withTenant(pool, tenantId, async (ctx) => {
      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId,
        eventType: 'order.accepted',
        payload: { total: 3590 },
      });
    });

    expect(await pendingCount(pool)).toBe(1);

    // Intento 1: publica (consumidor aplica efecto) y luego "muere" → rollback.
    await expect(
      relayOnce(pool, async (record) => {
        await handle(record);
        throw new Error('kill del relay antes de marcar published_at');
      }),
    ).rejects.toThrow(/kill del relay/);

    // El efecto ya ocurrió, pero el evento sigue pendiente (published_at NULL).
    expect(await effectCount(aggregateId)).toBe(1);
    expect(await pendingCount(pool)).toBe(1);

    // Intento 2: re-publica; el consumidor deduplica; marca published_at.
    const published = await relayOnce(pool, async (record) => {
      await handle(record);
    });
    expect(published).toBe(1);

    // Exactamente una vez: el efecto NO se duplicó.
    expect(await effectCount(aggregateId)).toBe(1);
    expect(await pendingCount(pool)).toBe(0);
  });
});
