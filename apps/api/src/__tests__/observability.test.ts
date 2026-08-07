import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AppModule } from '../app.module.js';
import { configureApp } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import {
  enqueueEvent,
  relayOnce,
  pendingCount,
  type OutboxRecord,
} from '../events/outbox.js';
import { withSpan, currentTraceId } from '../observability/tracing.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Observabilidad (T3.14).
 *
 * Gate declarado: «traza de request→outbox→worker visible». Se verifica con un
 * exportador EN MEMORIA en vez de un colector externo, de modo que la prueba
 * corre en CI sin infraestructura adicional y sigue comprobando lo que importa:
 * que el trace_id sobrevive al salto por la cola.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Observabilidad', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];
  let tenantId = '';
  let token = '';

  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    // Gestor de contexto asíncrono: sin él, el span creado por `startActiveSpan`
    // no es visible desde funciones anidadas tras un `await`, y `currentTraceId`
    // devolvería undefined. En producción lo registra NodeSDK automáticamente;
    // aquí se replica para que la prueba ejercite el mismo comportamiento.
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );

    // Proveedor de trazas en memoria: registra spans reales sin exportar fuera.
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);
    const t = await tenancy.provisionTenant({
      name: 'Obs Tenant',
      planCode: 'growth',
      owner: {
        email: 'obs@sahana.test',
        password: 'password-obs-123',
        fullName: 'Dueño Obs',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'obs@sahana.test', password: 'password-obs-123' })
      .expect(201);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());

  // ------------------------------------------------------------- Métricas

  it('GET /metrics expone el formato de Prometheus', async () => {
    const res = await http().get('/metrics').expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    // Métricas por defecto del proceso.
    expect(res.text).toContain('process_cpu_user_seconds_total');
    // Y las de negocio declaradas.
    expect(res.text).toContain('sahana_outbox_pending');
    expect(res.text).toContain('sahana_http_request_duration_seconds');
  });

  it('/metrics es accesible sin token (lo raspa Prometheus, no un usuario)', async () => {
    await http().get('/metrics').expect(200);
  });

  it('las peticiones alimentan el histograma de latencia', async () => {
    await http()
      .get('/api/v1/tenant')
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const res = await http().get('/metrics').expect(200);
    // El contador debe registrar la petición con su ruta y estado.
    expect(res.text).toMatch(
      /sahana_http_requests_total\{[^}]*status="200"[^}]*\}\s+\d+/,
    );
    expect(res.text).toContain('sahana_http_request_duration_seconds_bucket');
  });

  it('el gauge de outbox pendiente refleja el estado real', async () => {
    // Sin eventos pendientes al empezar.
    const antes = await pendingCount(pool);

    await withTenant(pool, tenantId, async (ctx) => {
      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: 'metrica-1',
        eventType: 'order.created',
        payload: {},
      });
    });

    const res = await http().get('/metrics').expect(200);
    // Las etiquetas por defecto (service="sahana-api") aparecen entre llaves.
    const match = /^sahana_outbox_pending(?:\{[^}]*\})?\s+(\d+)$/m.exec(
      res.text,
    );
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(antes + 1);

    // Y la antigüedad del más viejo se publica también.
    expect(res.text).toContain('sahana_outbox_oldest_pending_seconds');

    // Limpieza: publicar lo pendiente.
    await relayOnce(pool, async () => undefined);
  });

  it('publicar eventos incrementa el contador por tipo', async () => {
    await withTenant(pool, tenantId, async (ctx) => {
      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: 'metrica-2',
        eventType: 'order.accepted',
        payload: {},
      });
    });
    await relayOnce(pool, async () => undefined);

    const res = await http().get('/metrics').expect(200);
    expect(res.text).toMatch(
      /sahana_outbox_published_total\{[^}]*event_type="order\.accepted"[^}]*\}\s+\d+/,
    );
  });

  // ------------------------------- Traza request → outbox → worker (el gate)

  it('el trace_id VIAJA con el evento a través del outbox (gate T3.14)', async () => {
    let traceIdOrigen: string | undefined;

    // 1) "Request": se abre un span y, dentro, se produce el evento. El
    //    enqueueEvent toma el trace_id de la traza activa automáticamente.
    await withSpan(
      'request.simulado',
      { 'http.route': '/pedidos' },
      async () => {
        traceIdOrigen = currentTraceId();
        await withTenant(pool, tenantId, async (ctx) => {
          await enqueueEvent(ctx, {
            aggregateType: 'order',
            aggregateId: 'traza-1',
            eventType: 'order.accepted',
            payload: { total: 3590 },
          });
        });
      },
    );

    expect(
      traceIdOrigen,
      'No se generó trace_id: el proveedor de trazas no está activo.',
    ).toBeTruthy();

    // 2) El evento guardó ese trace_id en la BD — aquí es donde sobrevive al
    //    salto de proceso que rompería la propagación automática.
    const guardado = await withTenant(pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ trace_id: string | null }>(
        `SELECT trace_id FROM outbox WHERE aggregate_id = 'traza-1'`,
      );
      return rows[0]?.trace_id;
    });
    expect(guardado).toBe(traceIdOrigen);

    // 3) "Worker": el relay lo publica y el consumidor recibe el trace_id de
    //    origen, con lo que puede enlazar su trabajo con la petición original.
    let recibido: OutboxRecord | undefined;
    await relayOnce(pool, async (record) => {
      if (record.aggregateId === 'traza-1') recibido = record;
    });

    expect(recibido).toBeTruthy();
    expect(recibido!.traceId).toBe(traceIdOrigen);

    // 4) La cadena completa quedó registrada como spans.
    const spans = exporter.getFinishedSpans();
    const spanRequest = spans.find((s) => s.name === 'request.simulado');
    // Se busca por el agregado concreto: otras pruebas publican eventos del
    // mismo tipo y un find por nombre devolvería el span equivocado.
    const spanPublish = spans.find(
      (s) => s.attributes['sahana.aggregate.id'] === 'traza-1',
    );

    expect(spanRequest, 'Falta el span de la petición').toBeTruthy();
    expect(spanPublish, 'Falta el span de publicación del relay').toBeTruthy();
    // El span de publicación referencia la traza de origen: ese atributo es lo
    // que permite saltar de un lado a otro al diagnosticar.
    expect(spanPublish!.attributes['sahana.origin.trace_id']).toBe(
      traceIdOrigen,
    );
  });

  it('un fallo del relay marca el span como error y cuenta el fallo', async () => {
    await withTenant(pool, tenantId, async (ctx) => {
      await enqueueEvent(ctx, {
        aggregateType: 'order',
        aggregateId: 'traza-fallo',
        eventType: 'order.cancelled',
        payload: {},
      });
    });

    await expect(
      relayOnce(pool, async () => {
        throw new Error('fallo simulado del consumidor');
      }),
    ).rejects.toThrow(/fallo simulado/);

    const spans = exporter.getFinishedSpans();
    const spanFallido = spans.find(
      (s) => s.attributes['sahana.aggregate.id'] === 'traza-fallo',
    );
    expect(spanFallido, 'Falta el span de la publicación fallida').toBeTruthy();
    // status.code 2 = ERROR en la semántica de OpenTelemetry.
    expect(
      spanFallido!.status.code,
      'El span del fallo debería estar marcado como error',
    ).toBe(2);

    const res = await http().get('/metrics').expect(200);
    expect(res.text).toMatch(
      /^sahana_outbox_relay_errors_total(?:\{[^}]*\})?\s+[1-9]/m,
    );

    // El evento sigue pendiente: el fallo no lo dio por publicado.
    expect(await pendingCount(pool)).toBeGreaterThan(0);
    await relayOnce(pool, async () => undefined); // limpieza
  });

  // ------------------------------------------------------ trace_id en HTTP

  it('cada respuesta HTTP lleva su x-request-id correlacionable', async () => {
    const res = await http().get('/api/v1/health').expect(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.traceId).toBe(res.headers['x-request-id']);
  });

  it('respeta un x-request-id entrante para correlacionar entre servicios', async () => {
    const propio = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const res = await http()
      .get('/api/v1/health')
      .set('x-request-id', propio)
      .expect(200);
    expect(res.headers['x-request-id']).toBe(propio);
    expect(res.body.traceId).toBe(propio);
  });

  it('los errores también llevan trace_id en el Problem Details', async () => {
    const res = await http().get('/api/v1/tenant').expect(403);
    expect(res.body.traceId).toBeTruthy();
    expect(res.body.traceId).toBe(res.headers['x-request-id']);
  });
});
