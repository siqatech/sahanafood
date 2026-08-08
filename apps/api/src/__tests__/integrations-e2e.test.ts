import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
  signSimulatorPayload,
  SIMULATOR_PROVIDER,
} from '../modules/integrations/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Plataforma de integraciones contra el SIMULADOR (spec 13, T4.14).
 *
 * Todo lo que se prueba aquí es lo que rompe una integración real: firmas
 * inválidas, reintentos, SKUs que no existen, payloads truncados y credenciales
 * que no deben cruzarse entre tenants.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const SECRETO_A = 'secreto-de-firma-del-tenant-a';
const SECRETO_B = 'secreto-de-firma-del-tenant-b';
const CANAL = 'simulador';
const AHORA = new Date('2026-08-07T12:00:00Z');
/** Dentro de la zona céntrica de la semilla demo (mínimo S/ 20). */
const DROPOFF = { address: 'Av. Larco 123', lat: -12.12, lng: -77.02 };

suite('Integraciones e2e — simulador de marketplace', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tenantB = '';
  let tokenA = '';
  let ingestion: IngestionService;
  let connections: ConnectionService;
  let ordering: OrderingService;

  let conexionA = { id: '', token: '' };
  let conexionB = { id: '', token: '' };
  let catA: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let orgA: Awaited<ReturnType<typeof seedDemoOrganization>>;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();

    ingestion = app.get(IngestionService);
    connections = app.get(ConnectionService);
    ordering = app.get(OrderingService);

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Int Tenant A',
      planCode: 'growth',
      owner: {
        email: 'int-a@sahana.test',
        password: 'password-int-a-1',
        fullName: 'Dueño Int A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Int Tenant B',
      planCode: 'growth',
      owner: {
        email: 'int-b@sahana.test',
        password: 'password-int-b-1',
        fullName: 'Dueño Int B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    orgA = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    catA = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: orgA.brandIds[0],
        locationId: orgA.locationId,
      }),
    );
    const orgB = await withTenant(pool, tenantB, (ctx) =>
      seedDemoOrganization(ctx),
    );
    const catB = await withTenant(pool, tenantB, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: orgB.brandIds[0],
        locationId: orgB.locationId,
      }),
    );

    const cA = await connections.create(tenantA, {
      provider: SIMULATOR_PROVIDER,
      channel: CANAL,
      brandId: orgA.brandIds[0],
      locationId: orgA.locationId,
      signingSecret: SECRETO_A,
    });
    conexionA = { id: cA.id, token: cA.webhookToken };

    const cB = await connections.create(tenantB, {
      provider: SIMULATOR_PROVIDER,
      channel: CANAL,
      brandId: orgB.brandIds[0],
      locationId: orgB.locationId,
      signingSecret: SECRETO_B,
    });
    conexionB = { id: cB.id, token: cB.webhookToken };

    // Mapeo de catálogo: el combo no tiene modificadores obligatorios, así que
    // un pedido de una sola línea es válido sin más datos.
    await connections.mapSku(tenantA, {
      connectionId: conexionA.id,
      externalSku: 'SIM-COMBO',
      productId: catA.comboId,
    });
    await connections.mapSku(tenantA, {
      connectionId: conexionA.id,
      externalSku: 'SIM-POLLO',
      productId: catA.polloId,
    });
    await connections.mapSku(tenantA, {
      connectionId: conexionA.id,
      externalSku: 'SIM-GRANDE',
      modifierOptionId: catA.optionGrandeId,
    });
    await connections.mapSku(tenantB, {
      connectionId: conexionB.id,
      externalSku: 'SIM-COMBO',
      productId: catB.comboId,
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'int-a@sahana.test', password: 'password-int-a-1' })
      .expect(201);
    tokenA = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`);

  /**
   * Consulta directa a la BD CON contexto de tenant. Usar el pool a pelo
   * devolvería cero filas siempre —la RLS no encuentra `app.tenant_id`— y la
   * prueba pasaría por el motivo equivocado.
   */
  const sql = async <T extends Record<string, unknown>>(
    tenantId: string,
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> =>
    withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<T>(text, params);
      return rows;
    });

  /** Envía un cuerpo crudo al webhook, firmándolo con el secreto indicado. */
  const enviar = (
    token: string,
    rawBody: string,
    opciones: { secret?: string; deliveryId?: string; firma?: string } = {},
  ) => {
    const req = http()
      .post(`/api/v1/integrations/webhooks/${token}`)
      .set('content-type', 'application/json')
      .set(
        SIGNATURE_HEADER,
        opciones.firma ??
          signSimulatorPayload(rawBody, opciones.secret ?? SECRETO_A),
      );
    if (opciones.deliveryId) req.set(DELIVERY_HEADER, opciones.deliveryId);
    // `.send(string)` conserva los bytes exactos; pasar un objeto haría que
    // supertest lo re-serializase y la firma dejaría de coincidir.
    return req.send(rawBody);
  };

  const pedidoCrudo = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      event: 'order.created',
      order_id: `SIM-${Math.random().toString(36).slice(2, 10)}`,
      customer: { name: 'Cliente Marketplace', phone: '+51999111222' },
      dropoff: {
        address: DROPOFF.address,
        latitude: DROPOFF.lat,
        longitude: DROPOFF.lng,
      },
      items: [{ sku: 'SIM-COMBO', qty: 1 }],
      ...over,
    });

  // ------------------------------------------------------------- Ack (RN-INT-01)

  it('acepta un webhook firmado y responde 202 antes de crear el pedido', async () => {
    const raw = pedidoCrudo();
    const res = await enviar(conexionA.token, raw).expect(202);

    expect(res.body.status).toBe('accepted');
    expect(res.body.eventId).toBeTruthy();
    expect(res.body.duplicateDelivery).toBe(false);

    // Aún NO hay pedido: el ack promete, el worker cumple.
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;
    const antes = await ordering.list(tenantA, { channel: CANAL });
    expect(antes.some((o) => o.id === res.body.eventId)).toBe(false);

    await ingestion.processPending();

    const despues = await ordering.list(tenantA, { channel: CANAL });
    expect(despues.length).toBeGreaterThan(0);
    const rows = await sql<{ status: string; order_id: string }>(
      tenantA,
      'SELECT status, order_id FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.order_id).toBeTruthy();
  });

  it('el ack responde en menos de 250 ms (RN-INT-01)', async () => {
    // El presupuesto no es decorativo: pasado el timeout del proveedor, este
    // reintenta, y cada reintento es un duplicado más que deduplicar.
    const raw = pedidoCrudo();
    const t0 = process.hrtime.bigint();
    await enviar(conexionA.token, raw).expect(202);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms, `el ack tardó ${ms.toFixed(0)} ms`).toBeLessThan(250);
  });

  // ------------------------------------------------------------- Seguridad

  it('una firma inválida se rechaza con 401 y NO se encola nada', async () => {
    const raw = pedidoCrudo();
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;

    await enviar(conexionA.token, raw, { secret: 'secreto-equivocado' }).expect(
      401,
    );

    const rows = await sql(
      tenantA,
      'SELECT 1 FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    expect(
      rows.length,
      'un payload sin firmar llegó a la zona de aterrizaje: la bandeja de excepciones sería un buzón abierto',
    ).toBe(0);
  });

  it('el cuerpo alterado tras firmar se rechaza', async () => {
    const raw = pedidoCrudo({ items: [{ sku: 'SIM-COMBO', qty: 1 }] });
    const firmaLegitima = signSimulatorPayload(raw, SECRETO_A);
    const alterado = raw.replace('"qty":1', '"qty":9');
    await enviar(conexionA.token, alterado, { firma: firmaLegitima }).expect(
      401,
    );
  });

  it('un token de webhook desconocido devuelve 404', async () => {
    await enviar('token-que-no-existe', pedidoCrudo()).expect(404);
  });

  it('AISLAMIENTO: el secreto del tenant A no vale para la conexión de B', async () => {
    // La clave de cifrado se deriva por tenant, así que ni siquiera con acceso
    // a la fila de B se podría firmar en su nombre con el secreto de A.
    const raw = pedidoCrudo();
    await enviar(conexionB.token, raw, { secret: SECRETO_A }).expect(401);
    await enviar(conexionB.token, raw, { secret: SECRETO_B }).expect(202);
  });

  it('el secreto de firma NUNCA sale por la API', async () => {
    const res = await auth(
      http().get('/api/v1/integrations/connections'),
    ).expect(200);
    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).not.toContain(SECRETO_A);
    expect(cuerpo).not.toContain(SECRETO_B);
    expect(res.body[0].credentials).toEqual({ signing_secret: '***' });
  });

  it('la conexión pausada devuelve 503 para que el canal reintente', async () => {
    await connections.setStatus(tenantA, conexionA.id, 'paused');
    await enviar(conexionA.token, pedidoCrudo()).expect(503);
    await connections.setStatus(tenantA, conexionA.id, 'active');
    await enviar(conexionA.token, pedidoCrudo()).expect(202);
  });

  // ------------------------------------------------------------- Dedupe

  it('el MISMO envío repetido no se procesa dos veces', async () => {
    const raw = pedidoCrudo();
    const delivery = `DLV-IDEM-${Date.now()}`;

    const uno = await enviar(conexionA.token, raw, {
      deliveryId: delivery,
    }).expect(202);
    const dos = await enviar(conexionA.token, raw, {
      deliveryId: delivery,
    }).expect(202);

    expect(dos.body.duplicateDelivery).toBe(true);
    expect(dos.body.eventId).toBe(uno.body.eventId);
  });

  it('un REENVÍO del mismo pedido (otra entrega) crea UN solo pedido', async () => {
    // Es el caso real: el proveedor no recibió nuestro ack a tiempo y reintenta
    // con un id de entrega nuevo. Deduplicar aquí es lo que evita cobrar dos
    // veces y cocinar dos veces.
    const raw = pedidoCrudo();
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;

    await enviar(conexionA.token, raw, { deliveryId: 'DLV-R1' }).expect(202);
    await enviar(conexionA.token, raw, { deliveryId: 'DLV-R2' }).expect(202);
    await ingestion.processPending();

    const rows = await sql<{ count: string }>(
      tenantA,
      'SELECT count(*)::text AS count FROM ord_orders WHERE external_ref = $1',
      [ref],
    );
    expect(
      Number(rows[0]!.count),
      'el reenvío creó un segundo pedido: se cocinaría y cobraría dos veces',
    ).toBe(1);
  });

  // -------------------------------------------------- Excepciones (RN-INT-02)

  it('un SKU sin mapear NO se descarta: va a la bandeja de excepciones', async () => {
    const raw = pedidoCrudo({
      items: [{ sku: 'SKU-QUE-NADIE-MAPEO', qty: 1 }],
    });
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;

    await enviar(conexionA.token, raw).expect(202);
    const resultado = await ingestion.processPending();
    expect(resultado.toReview).toBeGreaterThan(0);

    const excepciones = await ordering.listExceptions(tenantA);
    const apartado = excepciones.find((o) => o.channel === CANAL);
    expect(apartado, 'el pedido con SKU sin mapear se perdió').toBeTruthy();

    const rows = await sql<{ status: string; order_id: string }>(
      tenantA,
      'SELECT status, order_id FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.order_id).toBeTruthy();
  });

  it('un MODIFICADOR OBLIGATORIO sin elegir va a la bandeja, no a la cola de muertos', async () => {
    // `SIM-POLLO` mapea a un producto con un grupo obligatorio («Tamaño»,
    // mínimo 1). Un marketplace que no manda la opción produce un pedido
    // inválido — y eso es un problema del CONTENIDO, que jamás va a mejorar
    // por reintentar.
    //
    // Lo destapó la prueba de carga de T4.30: 133 envíos acabaron en `failed`
    // tras cinco intentos idénticos. La causa era sutil: `ModifierError` vive
    // en `@sahana/domain` y NO hereda de `DomainError`, la jerarquía de la
    // API, así que se escapaba por la rama de los fallos transitorios. El
    // resultado violaba RN-INT-02 y el criterio de T4.13: un webhook aceptado
    // solo puede acabar en pedido o en `needs_review`, nunca en la cola de
    // muertos.
    const raw = pedidoCrudo({ items: [{ sku: 'SIM-POLLO', qty: 1 }] });
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;

    await enviar(conexionA.token, raw).expect(202);
    const resultado = await ingestion.processPending();
    expect(resultado.toReview).toBeGreaterThan(0);
    expect(resultado.failed, 'se trató como fallo transitorio').toBe(0);

    const rows = await sql<{
      status: string;
      attempts: number;
      order_id: string;
    }>(
      tenantA,
      'SELECT status, attempts, order_id FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.order_id).toBeTruthy();
    // Un solo intento: reintentar un payload inválido es trabajo tirado.
    expect(rows[0]!.attempts).toBe(1);

    const timeline = await ordering.getTimeline(tenantA, rows[0]!.order_id);
    expect(timeline[0]!.reason).toContain('Tamaño');
  });

  it('la bandeja conserva el payload crudo para poder resolverla', async () => {
    const raw = pedidoCrudo({ items: [{ sku: 'OTRO-SKU-ROTO', qty: 2 }] });
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;
    await enviar(conexionA.token, raw).expect(202);
    await ingestion.processPending();

    const rows = await sql<{ order_id: string }>(
      tenantA,
      'SELECT order_id FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    const timeline = await ordering.getTimeline(tenantA, rows[0]!.order_id);
    expect(timeline[0]!.event).toBe('mapping_failed');
    expect(timeline[0]!.reason).toContain('OTRO-SKU-ROTO');

    const eventos = await sql<{ data: { rawPayload: unknown } }>(
      tenantA,
      'SELECT data FROM ord_order_events WHERE order_id = $1',
      [rows[0]!.order_id],
    );
    expect(eventos[0]!.data.rawPayload).toMatchObject({ order_id: ref });
  });

  it('un payload que ni siquiera es JSON acaba en la bandeja, no en un log', async () => {
    const roto = '{"event":"order.created","order_id":"SIM-TRUNCA';
    await enviar(conexionA.token, roto, {
      deliveryId: 'DLV-TRUNCADO',
    }).expect(202);
    await ingestion.processPending();

    const rows = await sql<{ status: string; order_id: string }>(
      tenantA,
      'SELECT status, order_id FROM int_webhook_events WHERE delivery_id = $1',
      ['DLV-TRUNCADO'],
    );
    expect(rows[0]!.status).toBe('done');
    expect(
      rows[0]!.order_id,
      'un payload truncado se perdió: el cliente pagó y nadie se entera',
    ).toBeTruthy();
  });

  it('un pedido fuera de cobertura se aparta en vez de descartarse', async () => {
    const raw = pedidoCrudo({
      dropoff: { address: 'Puno', latitude: -15.84, longitude: -70.02 },
    });
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;
    await enviar(conexionA.token, raw).expect(202);
    await ingestion.processPending();

    const rows = await sql<{ status: string; order_id: string }>(
      tenantA,
      'SELECT status, order_id FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    expect(rows[0]!.status).toBe('done');
    const timeline = await ordering.getTimeline(tenantA, rows[0]!.order_id);
    expect(timeline[0]!.reason).toContain('validación');
  });

  it('la cola de muertos está vacía: nada quedó sin apartar', async () => {
    const res = await auth(
      http().get('/api/v1/integrations/dead-letters'),
    ).expect(200);
    expect(
      res.body,
      `hay ${res.body.length} webhooks que no se pudieron ni apartar`,
    ).toEqual([]);
  });

  // -------------------------------------------------- Modificadores mapeados

  it('mapea también los modificadores externos', async () => {
    const raw = pedidoCrudo({
      items: [{ sku: 'SIM-POLLO', qty: 1, options: ['SIM-GRANDE'] }],
    });
    const ref = (JSON.parse(raw) as { order_id: string }).order_id;
    await enviar(conexionA.token, raw).expect(202);
    await ingestion.processPending();

    const rows = await sql<{ order_id: string }>(
      tenantA,
      'SELECT order_id FROM int_webhook_events WHERE external_ref = $1',
      [ref],
    );
    const pedido = await ordering.getSummary(tenantA, rows[0]!.order_id);
    expect(pedido.status).toBe('received');
    // Pollo base 30 + Grande 5 = 35, más envío de la zona céntrica (5).
    expect(pedido.total.minorUnits).toBe(400_000);
  });

  // -------------------------------------------------- Cortacircuitos

  it('el cortacircuitos se abre tras fallos seguidos y se cierra con un éxito', async () => {
    for (let i = 0; i < 5; i++) {
      await connections.recordAttempt(tenantA, conexionA.id, 'failure');
    }
    expect(await connections.canCall(tenantA, conexionA.id)).toBe(false);

    const estado = await connections.recordAttempt(
      tenantA,
      conexionA.id,
      'success',
    );
    expect(estado).toBe('closed');
    expect(await connections.canCall(tenantA, conexionA.id)).toBe(true);
  });

  it('un conector abierto no afecta al de otro tenant (bulkhead RN-INT-03)', async () => {
    for (let i = 0; i < 5; i++) {
      await connections.recordAttempt(tenantA, conexionA.id, 'failure');
    }
    expect(await connections.canCall(tenantA, conexionA.id)).toBe(false);
    expect(await connections.canCall(tenantB, conexionB.id)).toBe(true);
    await connections.recordAttempt(tenantA, conexionA.id, 'success');
  });

  // -------------------------------------------------- Ráfaga del simulador

  it('ráfaga del simulador: todo envío firmado acaba en pedido o en bandeja', async () => {
    const simulador = new MarketplaceSimulator({
      seed: 2026,
      secret: SECRETO_A,
      knownSkus: ['SIM-COMBO'],
      dropoff: DROPOFF,
      now: AHORA,
    });
    const envios = simulador.burst(40);

    let aceptados = 0;
    for (const envio of envios) {
      const res = await enviar(conexionA.token, envio.rawBody, {
        deliveryId: envio.deliveryId,
        firma: envio.headers[SIGNATURE_HEADER]!,
      });
      if (envio.expected === 'rejected') {
        expect(res.status, `escenario ${envio.scenario}`).toBe(401);
      } else {
        expect(res.status, `escenario ${envio.scenario}`).toBe(202);
        aceptados++;
      }
    }
    expect(aceptados).toBeGreaterThan(0);

    // Se drena hasta vaciar; el bucle acotado evita colgar la suite si algo
    // dejara envíos pendientes para siempre.
    for (let i = 0; i < 10; i++) {
      const r = await ingestion.processPending(50);
      if (r.processed === 0) break;
    }

    const rows = await sql<{
      pendientes: string;
      fallidos: string;
      sin_pedido: string;
    }>(
      tenantA,
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pendientes,
              count(*) FILTER (WHERE status = 'failed')::text  AS fallidos,
              count(*) FILTER (WHERE status = 'done' AND order_id IS NULL)::text AS sin_pedido
         FROM int_webhook_events`,
    );
    expect(rows[0]!.pendientes).toBe('0');
    expect(rows[0]!.fallidos, 'hubo envíos en la cola de muertos').toBe('0');
    expect(rows[0]!.sin_pedido).toBe('0');

    // Y ningún reenvío duplicó un pedido.
    const dup = await sql<{ count: string }>(
      tenantA,
      `SELECT count(*)::text AS count FROM (
         SELECT external_ref FROM ord_orders
          WHERE channel = $1 AND external_ref IS NOT NULL
          GROUP BY external_ref HAVING count(*) > 1
       ) t`,
      [CANAL],
    );
    expect(dup[0]!.count).toBe('0');
  });
});
