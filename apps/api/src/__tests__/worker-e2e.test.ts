import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AppModule } from '../app.module.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import {
  OrderingService,
  AcceptanceService,
  AUTO_REJECT_REASON,
} from '../modules/ordering/index.js';
import {
  relayOnce,
  pendingCount,
  oldestPendingAgeSeconds,
} from '../events/outbox.js';
import {
  createQueuePublisher,
  createRedis,
  DOMAIN_EVENTS_QUEUE,
} from '../events/queue.js';
import { PeriodicJob } from '../workers/periodic-job.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * El WORKER de verdad: relay del outbox contra BullMQ real y barrido de
 * aceptación, ejecutados por el mismo `PeriodicJob` que corre en producción.
 *
 * Antes de esto, ambos procesos estaban implementados y probados pero nadie los
 * disparaba fuera de las pruebas unitarias. Esta suite verifica el eslabón que
 * faltaba: que una vuelta del worker saque de verdad el evento del outbox y lo
 * ponga en la cola, y que los pedidos venzan solos.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Worker — relay a BullMQ y barrido periódico', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let redis: Redis;
  let queue: Queue;
  let publisher: ReturnType<typeof createQueuePublisher>;

  let tenantA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let acceptance: AcceptanceService;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ordering = app.get(OrderingService);
    acceptance = app.get(AcceptanceService);

    redis = createRedis(REDIS_URL);
    publisher = createQueuePublisher(redis);
    queue = new Queue(DOMAIN_EVENTS_QUEUE, { connection: redis });
    // Se parte de una cola limpia: los jobs de una corrida anterior harían
    // que las cuentas de esta prueba midiesen otra cosa.
    await queue.obliterate({ force: true });

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Worker Tenant',
      planCode: 'growth',
      owner: {
        email: 'worker-a@sahana.test',
        password: 'password-worker-1',
        fullName: 'Dueño Worker',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0];
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await publisher?.close();
    redis?.disconnect();
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const crear = (channel = 'pos') =>
    ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel,
      lines: [{ productId: cat.comboId, quantity: 1 }],
    });

  /** Una vuelta del relay, tal cual la ejecuta el worker en producción. */
  const relayJob = (): PeriodicJob =>
    new PeriodicJob({
      name: 'outbox-relay-prueba',
      intervalMs: 60_000,
      run: async () => {
        await relayOnce(pool, publisher.publish, 100);
      },
    });

  it('una vuelta del worker saca el evento del outbox y lo pone en la cola', async () => {
    const pedido = await crear();

    const pendientesAntes = await pendingCount(pool);
    expect(pendientesAntes).toBeGreaterThan(0);

    await relayJob().runOnce();

    // El outbox quedó marcado...
    const sinPublicar = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL',
      );
      return Number(rows[0]!.count);
    });
    expect(sinPublicar).toBe(0);

    // ...y el evento está de verdad en BullMQ, no solo "marcado como enviado".
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const delPedido = jobs.filter(
      (j) => (j.data as { aggregateId?: string }).aggregateId === pedido.id,
    );
    expect(
      delPedido.length,
      'el relay marcó el evento como publicado pero no llegó a la cola',
    ).toBeGreaterThan(0);
    expect(delPedido[0]!.data).toMatchObject({
      tenantId: tenantA,
      aggregateType: 'order',
      eventType: 'order.received',
    });
  });

  it('el jobId es el id del evento: republicar no duplica trabajo', async () => {
    // Si el relay muere entre publicar y marcar published_at, la siguiente
    // vuelta reintenta ese evento. BullMQ descarta un jobId repetido, así que
    // el consumidor no hace el trabajo dos veces.
    await crear();
    await relayJob().runOnce();

    const antes = await queue.getJobCounts('waiting', 'delayed', 'active');
    const total = (c: Record<string, number>) =>
      Object.values(c).reduce((a, b) => a + b, 0);

    // Se reenvía a mano el MISMO evento ya publicado.
    const evento = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        occurred_at: Date;
      }>(
        'SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, occurred_at FROM outbox ORDER BY occurred_at DESC LIMIT 1',
      );
      return rows[0]!;
    });

    await publisher.publish({
      id: evento.id,
      tenantId: evento.tenant_id,
      aggregateType: evento.aggregate_type,
      aggregateId: evento.aggregate_id,
      eventType: evento.event_type,
      payload: evento.payload,
      occurredAt: evento.occurred_at,
      attempts: 1,
      traceId: null,
    });

    const despues = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(
      total(despues),
      'republicar el mismo evento creó un segundo job: el consumidor lo haría dos veces',
    ).toBe(total(antes));
  });

  it('la traza viaja EN el mensaje y sobrevive el salto por la cola', async () => {
    // El contexto de OpenTelemetry no cruza Redis por sí solo; sin llevarlo en
    // el cuerpo, la traza se parte justo donde más falta hace seguirla.
    const pedido = await ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'traza',
      lines: [{ productId: cat.comboId, quantity: 1 }],
      traceId: 'traza-de-prueba-123',
    });
    await relayJob().runOnce();

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    const suyo = jobs.find(
      (j) => (j.data as { aggregateId?: string }).aggregateId === pedido.id,
    );
    expect(suyo).toBeTruthy();
    expect((suyo!.data as { traceId?: string }).traceId).toBe(
      'traza-de-prueba-123',
    );
  });

  it('un fallo al publicar deja el evento pendiente para la vuelta siguiente', async () => {
    const pedido = await crear('fallo-publicacion');

    const jobRoto = new PeriodicJob({
      name: 'relay-roto',
      intervalMs: 60_000,
      run: async () => {
        await relayOnce(
          pool,
          async () => {
            throw new Error('Redis no responde');
          },
          100,
        );
      },
    });
    // El PeriodicJob absorbe el error: el worker no muere por esto.
    await expect(jobRoto.runOnce()).resolves.toBeUndefined();

    // Y el evento sigue sin publicar: no se perdió al fallar.
    const pendiente = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL AND aggregate_id = $1',
        [pedido.id],
      );
      return Number(rows[0]!.count);
    });
    expect(pendiente).toBeGreaterThan(0);

    // La vuelta siguiente, con Redis sano, lo publica.
    await relayJob().runOnce();
    const tras = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL AND aggregate_id = $1',
        [pedido.id],
      );
      return Number(rows[0]!.count);
    });
    expect(tras).toBe(0);
  });

  it('las métricas de salud del outbox distinguen "sin trabajo" de "relay muerto"', async () => {
    await relayJob().runOnce();
    expect(await pendingCount(pool)).toBe(0);
    // Con la cola vacía la antigüedad es cero; con un relay caído crecería sin
    // parar, y esa es justamente la señal que dispara la alerta.
    expect(await oldestPendingAgeSeconds(pool)).toBe(0);

    await crear('metricas');
    expect(await pendingCount(pool)).toBeGreaterThan(0);
    expect(await oldestPendingAgeSeconds(pool)).toBeGreaterThanOrEqual(0);
    await relayJob().runOnce();
  });

  it('el barrido periódico rechaza SOLO un pedido que nadie aceptó', async () => {
    await acceptance.setPolicy(tenantA, {
      channel: 'vencimiento-worker',
      autoAccept: false,
      alertAfterMinutes: 1,
      autoRejectAfterMinutes: 2,
    });
    const pedido = await crear('vencimiento-worker');

    // El mismo trabajo que corre el worker, con el reloj adelantado.
    const creadoEn = new Date(
      (await ordering.getSummary(tenantA, pedido.id)).createdAt,
    );
    const dentroDeTresMinutos = new Date(creadoEn.getTime() + 3 * 60_000);

    const barrido = new PeriodicJob({
      name: 'acceptance-sweep-prueba',
      intervalMs: 60_000,
      run: async () => {
        await acceptance.sweepAllTenants(dentroDeTresMinutos);
      },
    });
    await barrido.runOnce();

    const final = await ordering.getSummary(tenantA, pedido.id);
    expect(final.status).toBe('rejected');

    const timeline = await ordering.getTimeline(tenantA, pedido.id);
    expect(timeline.find((e) => e.event === 'reject')?.reason).toBe(
      AUTO_REJECT_REASON,
    );

    // Y el rechazo automático también sale por la cola: el canal tiene que
    // enterarse de que ese pedido no se va a preparar.
    await relayJob().runOnce();
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(
      jobs.some(
        (j) =>
          (j.data as { aggregateId?: string }).aggregateId === pedido.id &&
          (j.data as { eventType?: string }).eventType === 'order.rejected',
      ),
      'el canal no se entera del rechazo automático',
    ).toBe(true);
  });

  it('dos vueltas seguidas del barrido no alertan dos veces del mismo pedido', async () => {
    // Con varias instancias del worker esto es el caso normal, no el raro.
    await acceptance.setPolicy(tenantA, {
      channel: 'doble-aviso',
      autoAccept: false,
      alertAfterMinutes: 1,
      autoRejectAfterMinutes: 30,
    });
    const pedido = await crear('doble-aviso');
    const creadoEn = new Date(
      (await ordering.getSummary(tenantA, pedido.id)).createdAt,
    );
    const enDosMinutos = new Date(creadoEn.getTime() + 2 * 60_000);

    const primera = await acceptance.sweepTenant(tenantA, enDosMinutos);
    const segunda = await acceptance.sweepTenant(tenantA, enDosMinutos);

    expect(primera.alerted).toBe(1);
    expect(
      segunda.alerted,
      'la segunda vuelta volvió a avisar: el equipo recibiría la alerta duplicada',
    ).toBe(0);

    await ordering
      .applyTransition(tenantA, pedido.id, 'reject', {
        actorType: 'system',
        reason: 'Limpieza de la prueba.',
      })
      .catch(() => undefined);
  });
});
