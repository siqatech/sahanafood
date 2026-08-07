import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Pool } from 'pg';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import {
  ConnectionService,
  IngestionService,
  MarketplaceSimulator,
  SIGNATURE_HEADER,
  DELIVERY_HEADER,
  SIMULATOR_PROVIDER,
} from '../modules/integrations/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * PRUEBA DE CAOS DE INGESTA (T4.15) — criterio de aceptación §11.1 de la
 * spec 05, el más duro de la fase:
 *
 *   «Cero pérdida de pedidos: todo webhook ack'd termina en pedido o en
 *    needs_review, incluso matando el worker durante la ingesta.»
 *
 * El worker no se "simula" muerto lanzando una excepción: eso probaría el
 * manejo de errores, que es otra cosa. Aquí se **mata su conexión desde
 * Postgres** con `pg_terminate_backend`, que es lo que de verdad ocurre cuando
 * el contenedor se reinicia, el despliegue reemplaza el pod o la red se corta a
 * mitad de una transacción. La transacción muere sin COMMIT y sin ROLLBACK
 * ordenado; si el diseño dependiera de que el proceso limpie tras de sí, aquí
 * se vería.
 *
 * El worker corre sobre su PROPIO pool, con `application_name` propio, para
 * poder matar exactamente sus conexiones y no las de la API.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const SECRETO = 'secreto-de-firma-para-la-prueba-de-caos';
const CANAL = 'simulador-caos';
const NOMBRE_WORKER = 'sahana-worker-caos';
const AHORA = new Date('2026-08-07T12:00:00Z');
const DROPOFF = { address: 'Av. Larco 123', lat: -12.12, lng: -77.02 };
/** Envíos de la ráfaga. Suficientes para que el asesinato caiga a media faena. */
const ENVIOS = 60;

suite('Caos de ingesta — cero pérdida de pedidos (spec 05 §11.1)', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  let workerPool: Pool;
  const created: string[] = [];

  let tenantId = '';
  let connections: ConnectionService;
  let ordering: OrderingService;
  /** Worker con pool propio: es el que se mata. */
  let worker: IngestionService;
  let conexion = { id: '', token: '' };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();

    connections = app.get(ConnectionService);
    ordering = app.get(OrderingService);

    const url = new URL(INTEGRATION_DB!);
    url.searchParams.set('application_name', NOMBRE_WORKER);
    workerPool = createPool(url.toString(), { max: 4 });
    // Matar un backend hace que su cliente emita 'error'. Sin este manejador,
    // node-pg lo convierte en una excepción no capturada y tumba el proceso de
    // pruebas antes de que se pueda comprobar nada.
    workerPool.on('error', () => undefined);
    worker = new IngestionService(workerPool, connections, ordering);

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);
    const t = await tenancy.provisionTenant({
      name: 'Caos Tenant',
      planCode: 'growth',
      owner: {
        email: 'caos@sahana.test',
        password: 'password-caos-1',
        fullName: 'Dueño Caos',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);

    const org = await withTenant(pool, tenantId, (ctx) =>
      seedDemoOrganization(ctx),
    );
    const cat = await withTenant(pool, tenantId, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: org.brandIds[0],
        locationId: org.locationId,
      }),
    );

    const c = await connections.create(tenantId, {
      provider: SIMULATOR_PROVIDER,
      channel: CANAL,
      brandId: org.brandIds[0],
      locationId: org.locationId,
      signingSecret: SECRETO,
    });
    conexion = { id: c.id, token: c.webhookToken };

    await connections.mapSku(tenantId, {
      connectionId: conexion.id,
      externalSku: 'SIM-COMBO',
      productId: cat.comboId,
    });
  });

  afterAll(async () => {
    await app?.close();
    await workerPool?.end().catch(() => undefined);
    await deleteTenants(pool, created);
    await pool.end();
  });

  const sql = async <T extends Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> =>
    withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<T>(text, params);
      return rows;
    });

  /** Mata las conexiones del worker desde el propio Postgres. */
  const matarWorker = async (): Promise<number> => {
    const { rows } = await pool.query<{ pid: number }>(
      `SELECT pg_terminate_backend(pid) AS ok, pid
         FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [NOMBRE_WORKER],
    );
    return rows.length;
  };

  it('todo webhook con ack termina en pedido o en la bandeja, aunque el worker muera', async () => {
    // ---------------------------------------------------------------- Ingesta
    const simulador = new MarketplaceSimulator({
      seed: 31_415,
      secret: SECRETO,
      knownSkus: ['SIM-COMBO'],
      dropoff: DROPOFF,
      now: AHORA,
    });
    const envios = simulador.burst(ENVIOS);

    /** Envíos que el proveedor considera ENTREGADOS: nuestro compromiso. */
    const conAck: string[] = [];
    for (const envio of envios) {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/integrations/webhooks/${conexion.token}`)
        .set('content-type', 'application/json')
        .set(SIGNATURE_HEADER, envio.headers[SIGNATURE_HEADER]!)
        .set(DELIVERY_HEADER, envio.deliveryId)
        .send(envio.rawBody);

      if (envio.expected === 'rejected') {
        expect(res.status).toBe(401);
      } else {
        expect(res.status).toBe(202);
        conAck.push(envio.deliveryId);
      }
    }
    expect(conAck.length).toBeGreaterThan(40);

    // ------------------------------------------------------- Caos: matar y matar
    let muertesEfectivas = 0;
    for (let ronda = 0; ronda < 6; ronda++) {
      // El worker arranca y NO se espera: se le deja avanzar unos milisegundos
      // y se le mata la conexión a media faena.
      const enVuelo = worker
        .processPending(ENVIOS)
        .then(() => 'terminó')
        .catch(() => 'muerto');

      await new Promise((r) => setTimeout(r, 15 + ronda * 10));
      const matados = await matarWorker();
      if (matados > 0) muertesEfectivas++;

      await enVuelo;
    }

    expect(
      muertesEfectivas,
      'no se llegó a matar ninguna conexión del worker: la prueba no ha probado nada',
    ).toBeGreaterThan(0);

    // ------------------------------------------------------- Recuperación
    // Un worker nuevo, como el que levantaría el orquestador tras el reinicio.
    const workerPool2 = createPool(INTEGRATION_DB!, { max: 4 });
    const worker2 = new IngestionService(workerPool2, connections, ordering);
    try {
      for (let i = 0; i < 20; i++) {
        const r = await worker2.processPending(ENVIOS);
        if (r.processed === 0) break;
      }
    } finally {
      await workerPool2.end();
    }

    // --------------------------------------------- Invariante de cero pérdida
    const estados = await sql<{
      status: string;
      order_id: string | null;
      delivery_id: string;
    }>('SELECT status, order_id, delivery_id FROM int_webhook_events');

    const porEntrega = new Map(estados.map((e) => [e.delivery_id, e]));

    const perdidos: string[] = [];
    for (const deliveryId of conAck) {
      const fila = porEntrega.get(deliveryId);
      if (!fila) {
        perdidos.push(`${deliveryId}: no quedó rastro del envío`);
        continue;
      }
      if (fila.status !== 'done' || !fila.order_id) {
        perdidos.push(
          `${deliveryId}: estado=${fila.status} pedido=${fila.order_id ?? 'ninguno'}`,
        );
      }
    }

    expect(
      perdidos,
      `Se perdieron ${perdidos.length} de ${conAck.length} webhooks con ack:\n${perdidos.join('\n')}`,
    ).toEqual([]);

    // Y cada uno apunta a un pedido que EXISTE: una FK huérfana contaría como
    // pérdida aunque el estado dijese "done".
    const huerfanos = await sql<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM int_webhook_events w
         LEFT JOIN ord_orders o ON o.id = w.order_id
        WHERE w.status = 'done' AND o.id IS NULL`,
    );
    expect(huerfanos[0]!.count).toBe('0');
  }, 120_000);

  it('el caos NO duplicó ningún pedido pese a los reprocesos', async () => {
    // Al morir a mitad, muchos envíos se reprocesaron. Si la idempotencia
    // dependiera del código y no del índice único, ahí habrían nacido los
    // pedidos duplicados: comida cocinada dos veces y cobrada dos veces.
    const duplicados = await sql<{ external_ref: string; veces: string }>(
      `SELECT external_ref, count(*)::text AS veces
         FROM ord_orders
        WHERE channel = $1 AND external_ref IS NOT NULL
        GROUP BY external_ref HAVING count(*) > 1`,
      [CANAL],
    );
    expect(
      duplicados,
      `Referencias duplicadas: ${duplicados.map((d) => `${d.external_ref}×${d.veces}`).join(', ')}`,
    ).toEqual([]);
  });

  it('la cola de muertos quedó vacía', async () => {
    const muertos = await sql<{ delivery_id: string; last_error: string }>(
      "SELECT delivery_id, last_error FROM int_webhook_events WHERE status = 'failed'",
    );
    expect(
      muertos,
      `Webhooks que no se pudieron ni apartar:\n${muertos
        .map((m) => `${m.delivery_id}: ${m.last_error}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('ningún envío quedó reclamado para siempre: sin cerrojos zombis', async () => {
    // El diseño no usa lease ni marca "processing": la reclamación es el propio
    // cerrojo de la transacción, que Postgres suelta solo al morir la conexión.
    // Esta comprobación fija esa propiedad: si alguien introdujera un estado
    // intermedio persistido, aquí quedarían filas atascadas.
    const pendientes = await sql<{ count: string }>(
      "SELECT count(*)::text AS count FROM int_webhook_events WHERE status = 'pending'",
    );
    expect(pendientes[0]!.count).toBe('0');
  });

  it('el desglose cuadra: cada pedido creado corresponde a un envío procesado', async () => {
    const resumen = await sql<{
      envios: string;
      pedidos: string;
      revision: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM int_webhook_events WHERE status = 'done') AS envios,
         (SELECT count(*)::text FROM ord_orders WHERE channel = $1) AS pedidos,
         (SELECT count(*)::text FROM ord_orders WHERE channel = $1 AND status = 'needs_review') AS revision`,
      [CANAL],
    );

    // Los reenvíos comparten pedido, así que hay MÁS envíos que pedidos; lo que
    // no puede ocurrir jamás es lo contrario.
    expect(Number(resumen[0]!.envios)).toBeGreaterThanOrEqual(
      Number(resumen[0]!.pedidos),
    );
    expect(Number(resumen[0]!.pedidos)).toBeGreaterThan(0);
    // La ráfaga incluye SKUs sin mapear y payloads rotos: si la bandeja está
    // vacía es que se descartaron en silencio.
    expect(
      Number(resumen[0]!.revision),
      'la bandeja de excepciones está vacía pese a haber enviado SKUs sin mapear',
    ).toBeGreaterThan(0);
  });
});
