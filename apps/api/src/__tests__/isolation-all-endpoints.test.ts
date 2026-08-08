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
import {
  ConnectionService,
  SIMULATOR_PROVIDER,
} from '../modules/integrations/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import { PaymentsService, CULQI_PROVIDER } from '../modules/payments/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';
import {
  assertEndpointIsolation,
  type IsolationCase,
} from './isolation-harness.js';

/**
 * Suite BLOQUEANTE de aislamiento aplicada a TODOS los endpoints (T3.13).
 *
 * Al añadir un endpoint nuevo, se añade aquí su caso. El harness comprueba, sin
 * necesidad de aserciones a medida, que la respuesta del tenant A no contiene
 * ningún dato del tenant B a ninguna profundidad del JSON.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

/**
 * Día de negocio en el que SOLO el tenant B tiene facturación.
 *
 * Fijo y en el pasado: así el caso de `/analytics/reconciliation` no depende de
 * la hora a la que se ejecute la suite ni de lo que las pruebas anteriores
 * hayan hecho con los comprobantes del día de hoy.
 */
const DIA_SOLO_DE_B = '2026-01-15';

suite('Aislamiento — todos los endpoints', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];

  let tokenA = '';
  let tokenB = '';
  let secretsOfB: string[] = [];
  let demoA: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let catA: Awaited<ReturnType<typeof seedDemoCatalog>>;
  /** Pedido del tenant A, para probar endpoints que operan sobre uno concreto. */
  let pedidoDeA = '';
  /** Insumo y almacén del tenant B: A no debe poder leerlos ni ajustarlos. */
  let insumoDeB = '';
  let almacenDeB = '';
  /** Comprobante del tenant B: A no debe poder leerlo, reenviarlo ni anularlo. */
  let documentoDeB = '';
  /** Pedido del tenant B, para endpoints que operan sobre uno concreto. */
  let pedidoDeB = '';
  /**
   * Intención de cobro del tenant B. Si se filtrara, A vería cuánto cobra su
   * competencia y —peor— tendría la referencia con la que vuelve el webhook.
   */
  let intencionDeB = '';
  /** Enlace público de pago de B: quien lo tenga puede cobrar en su nombre. */
  let enlaceDeB = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Aislamiento Tenant A',
      planCode: 'growth',
      owner: {
        email: 'iso-a@sahana.test',
        password: 'password-iso-a-1',
        fullName: 'Dueño Iso A',
      },
    });
    created.push(a.tenantId);

    const b = await tenancy.provisionTenant({
      name: 'Aislamiento Tenant B SECRETO',
      planCode: 'starter',
      owner: {
        email: 'iso-b@sahana.test',
        password: 'password-iso-b-1',
        fullName: 'Dueño Iso B',
      },
    });
    created.push(b.tenantId);

    demoA = await withTenant(pool, a.tenantId, (ctx) =>
      seedDemoOrganization(ctx),
    );
    const demoB = await withTenant(pool, b.tenantId, (ctx) =>
      seedDemoOrganization(ctx),
    );

    catA = await withTenant(pool, a.tenantId, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: demoA.brandIds[0],
        locationId: demoA.locationId,
      }),
    );
    const catB = await withTenant(pool, b.tenantId, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: demoB.brandIds[0],
        locationId: demoB.locationId,
      }),
    );

    // Inventario de B, con stock real: sin stock, un endpoint que devuelve
    // vacío parecería aislado aunque no lo estuviera.
    insumoDeB = await withTenant(pool, b.tenantId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO inv_items (tenant_id, name, unit, unit_cost)
         VALUES ($1,'Insumo SECRETO de B','g',0.05) RETURNING id`,
        [b.tenantId],
      );
      await client.query(
        `INSERT INTO inv_stock (tenant_id, warehouse_id, item_id, quantity)
         VALUES ($1,$2,$3,4321)`,
        [b.tenantId, demoB.warehouseId, rows[0]!.id],
      );
      return rows[0]!.id;
    });
    almacenDeB = demoB.warehouseId;

    // Comprobante emitido de B, con su serie y su correlativo: si algún día se
    // filtrara, el tenant A vería la facturación de un competidor.
    documentoDeB = await withTenant(pool, b.tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO bil_series (tenant_id, company_id, series, doc_type)
         VALUES ($1,$2,'B900','boleta')`,
        [b.tenantId, demoB.companyId],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO bil_documents
           (tenant_id, company_id, doc_type, status,
            series_id, series, correlative, number,
            subtotal, taxable_base, tax, total, customer_name)
         SELECT $1, $2, 'boleta', 'accepted', s.id, 'B900', 7, 'B900-00000007',
                '84.7458','84.7458','15.2542','100.0000','Cliente SECRETO de B'
           FROM bil_series s
          WHERE s.tenant_id = $1 AND s.series = 'B900'
         RETURNING id`,
        [b.tenantId, demoB.companyId],
      );
      return rows[0]!.id;
    });

    // Facturación de B en un día CERRADO del pasado. Es lo que da contenido al
    // caso de `/analytics/reconciliation`: A no facturó nada ese día, B sí, y
    // ninguna prueba posterior lo toca (las que emiten notas de crédito o
    // reintentan van contra `documentoDeB`, que es de hoy).
    //
    // La hora es de tarde en Lima a propósito: a las 18:00 UTC son las 13:00 en
    // Lima, así que el día de negocio es el mismo mire quien lo mire. Con una
    // hora de madrugada, UTC y Lima caerían en días distintos y la prueba
    // volvería a depender de en qué zona se hace la cuenta.
    // Va en la MISMA serie B900: solo puede haber una serie activa por tipo de
    // comprobante (índice `idx_bil_series_activa`), que es la regla que impide
    // dos correlativos en paralelo para el mismo tipo.
    await withTenant(pool, b.tenantId, ({ client }) =>
      client.query(
        `INSERT INTO bil_documents
           (tenant_id, company_id, doc_type, status,
            series_id, series, correlative, number,
            subtotal, taxable_base, tax, total, customer_name, issued_at)
         SELECT $1, $2, 'boleta', 'accepted', s.id, 'B900', 8, 'B900-00000008',
                '84.7458','84.7458','15.2542','100.0000','Cliente SECRETO de B',
                $3::timestamptz
           FROM bil_series s
          WHERE s.tenant_id = $1 AND s.series = 'B900'`,
        [b.tenantId, demoB.companyId, `${DIA_SOLO_DE_B}T18:00:00Z`],
      ),
    );

    // Conexiones de integración: el token de webhook de B identifica su canal y
    // permitiría dirigirle pedidos, así que cuenta como secreto suyo.
    const connections = app.get(ConnectionService);
    await connections.create(a.tenantId, {
      provider: SIMULATOR_PROVIDER,
      channel: 'simulador',
      brandId: demoA.brandIds[0],
      locationId: demoA.locationId,
      signingSecret: 'secreto-de-firma-del-tenant-a-iso',
    });
    const conexionB = await connections.create(b.tenantId, {
      provider: SIMULATOR_PROVIDER,
      channel: 'simulador',
      brandId: demoB.brandIds[0],
      locationId: demoB.locationId,
      signingSecret: 'secreto-de-firma-del-tenant-b-iso',
    });

    // Todo lo que identifica al tenant B y jamás debe salir en la respuesta de A.
    secretsOfB = [
      b.tenantId,
      b.ownerUserId,
      demoB.companyId,
      demoB.brandIds[0],
      demoB.brandIds[1],
      demoB.locationId,
      demoB.kitchenId,
      demoB.warehouseId,
      insumoDeB,
      'Insumo SECRETO de B',
      documentoDeB,
      'B900-00000007',
      'Cliente SECRETO de B',
      demoB.zoneIds[0],
      demoB.zoneIds[1],
      demoB.scheduleId,
      ...demoB.stationIds,
      'Aislamiento Tenant B SECRETO',
      'iso-b@sahana.test',
      // Catálogo del tenant B: productos, categorías y modificadores.
      catB.categoryId,
      catB.polloId,
      catB.soloPosId,
      catB.comboId,
      catB.groupTamanoId,
      catB.groupExtrasId,
      catB.optionGrandeId,
      catB.optionQuesoId,
      // Integraciones del tenant B.
      conexionB.id,
      conexionB.webhookToken,
      'secreto-de-firma-del-tenant-b-iso',
    ];

    const pedido = await app.get(OrderingService).submit(a.tenantId, {
      brandId: demoA.brandIds[0],
      locationId: demoA.locationId,
      channel: 'pos',
      lines: [{ productId: catA.comboId, quantity: 1 }],
    });
    pedidoDeA = pedido.id;

    const pedidoB = await app.get(OrderingService).submit(b.tenantId, {
      brandId: demoB.brandIds[0],
      locationId: demoB.locationId,
      channel: 'pos',
      lines: [{ productId: catB.comboId, quantity: 1 }],
    });
    pedidoDeB = pedidoB.id;
    secretsOfB.push(pedidoDeB);

    // Cobro de B contra ese pedido. La `reference` entra como secreto porque
    // es con lo que vuelve el webhook de la pasarela: quien la tenga puede
    // intentar avisos contra un cobro ajeno, y aunque la firma lo pare, no
    // tiene por qué llegar a saberla.
    const pasarelaDeB = await app
      .get(PaymentsService)
      .createConnection(b.tenantId, {
        provider: CULQI_PROVIDER,
        webhookSecret: 'secreto-de-la-pasarela-del-tenant-b',
      });
    const cobroDeB = await app.get(PaymentsService).createIntent(b.tenantId, {
      orderId: pedidoDeB,
      provider: CULQI_PROVIDER,
    });
    intencionDeB = cobroDeB.id;

    const linkDeB = await app
      .get(PaymentsService)
      .createPaymentLink(b.tenantId, {
        orderId: pedidoDeB,
        provider: CULQI_PROVIDER,
      });
    enlaceDeB = linkDeB.token;

    secretsOfB.push(
      enlaceDeB,
      linkDeB.intentId,
      intencionDeB,
      cobroDeB.reference,
      pasarelaDeB.id,
      pasarelaDeB.webhookToken,
      'secreto-de-la-pasarela-del-tenant-b',
    );

    // B necesita DATOS de analítica y mensajería: dos respuestas de ceros
    // idénticas no demuestran aislamiento, solo que ambos tenants están
    // vacíos. Con datos solo en B, cualquier fuga se ve.
    await withTenant(pool, b.tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO ana_daily_sales
           (tenant_id, business_date, brand_id, location_id, channel,
            orders, gross_revenue)
         VALUES ($1, current_date, $2, $3, 'pos', 7, 1234.5600)`,
        [b.tenantId, demoB.brandIds[0], demoB.locationId],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO wa_contacts (tenant_id, phone) VALUES ($1,'+51900000009')
         RETURNING id`,
        [b.tenantId],
      );
      await client.query(
        `INSERT INTO wa_messages
           (tenant_id, contact_id, order_id, direction, kind, template_name, status)
         VALUES ($1,$2,$3,'outbound','template','pedido_confirmado','sent')`,
        [b.tenantId, rows[0]!.id, pedidoDeB],
      );
    });

    const loginA = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'iso-a@sahana.test', password: 'password-iso-a-1' })
      .expect(201);
    tokenA = loginA.body.accessToken;

    const loginB = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'iso-b@sahana.test', password: 'password-iso-b-1' })
      .expect(201);
    tokenB = loginB.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  /** Caso base con los tokens y secretos ya resueltos. */
  const caseFor = (
    name: string,
    build: IsolationCase['request'],
    extra: Partial<IsolationCase> = {},
  ): IsolationCase => ({
    name,
    request: build,
    tokenA,
    tokenB,
    secretsOfB,
    ...extra,
  });

  it('GET /tenant', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /tenant', (r) => r.get('/api/v1/tenant')),
    );
  });

  it('GET /tenant/limits', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /tenant/limits', (r) => r.get('/api/v1/tenant/limits')),
    );
  });

  it('GET /tenant/flags', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /tenant/flags', (r) => r.get('/api/v1/tenant/flags')),
    );
  });

  it('GET /audit', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /audit', (r) => r.get('/api/v1/audit')),
    );
  });

  it('GET /audit con filtros', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /audit?entity=tenant', (r) =>
        r.get('/api/v1/audit?entity=tenant'),
      ),
    );
  });

  it('GET /organization', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /organization', (r) => r.get('/api/v1/organization')),
    );
  });

  it('GET /organization/open', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /organization/open', (r) =>
        r.get(`/api/v1/organization/open?location=${demoA.locationId}`),
      ),
    );
  });

  it('GET /coverage', async () => {
    // Ambos tenants tienen zonas con la MISMA geometría: si hubiera fuga, la
    // respuesta de A podría traer la zona de B sin que se note a simple vista.
    await assertEndpointIsolation(
      app,
      caseFor('GET /coverage', (r) =>
        r.get('/api/v1/coverage?lat=-12.12&lng=-77.02'),
      ),
    );
  });

  it('GET /devices', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /devices', (r) => r.get('/api/v1/devices')),
    );
  });

  it('GET /auth/me', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /auth/me', (r) => r.get('/api/v1/auth/me')),
    );
  });

  it('GET /health es público y no expone datos de tenant', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /health', (r) => r.get('/api/v1/health'), {
        isPublic: true,
      }),
    );
  });

  it('POST /devices/pairing-codes', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /devices/pairing-codes',
        (r) => r.post('/api/v1/devices/pairing-codes').send({}),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /orders', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /orders', (r) => r.get('/api/v1/orders')),
    );
  });

  it('PATCH /orders/:id (pedido de A)', async () => {
    // El pedido pertenece a A: para B no existe. Se comprueba además que la
    // respuesta a B no revele NADA del pedido ajeno, ni siquiera su versión.
    await assertEndpointIsolation(
      app,
      caseFor(
        'PATCH /orders/:id',
        (r) =>
          r
            .patch(`/api/v1/orders/${pedidoDeA}`)
            .set('if-match', '1')
            .send({ lines: [{ productId: catA.comboId, quantity: 1 }] }),
        { expectedStatusForA: [200] },
      ),
    );
  });

  it('GET /orders/exceptions', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /orders/exceptions', (r) =>
        r.get('/api/v1/orders/exceptions'),
      ),
    );
  });

  it('GET /integrations/connections', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /integrations/connections', (r) =>
        r.get('/api/v1/integrations/connections'),
      ),
    );
  });

  it('GET /integrations/dead-letters', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /integrations/dead-letters', (r) =>
        r.get('/api/v1/integrations/dead-letters'),
      ),
    );
  });

  it('GET /ordering/acceptance-policies', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /ordering/acceptance-policies', (r) =>
        r.get('/api/v1/ordering/acceptance-policies'),
      ),
    );
  });

  it('POST /orders/sync (POS offline)', async () => {
    // El ULID de cliente es del tenant que lo manda: si el endpoint no filtrara,
    // B podría sincronizar pedidos contra la marca y el local de A.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /orders/sync',
        (r) =>
          r.post('/api/v1/orders/sync').send({
            orders: [
              {
                clientId: `01JISO${Date.now()}${Math.floor(Math.random() * 1000)}`,
                brandId: demoA.brandIds[0],
                locationId: demoA.locationId,
                channel: 'pos',
                lines: [
                  {
                    productId: catA.comboId,
                    productName: 'Combo familiar',
                    quantity: 1,
                    unitPriceMinor: 380_000,
                    lineTotalMinor: 380_000,
                  },
                ],
                totalMinor: 380_000,
              },
            ],
          }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /cash-sessions', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /cash-sessions', (r) => r.get('/api/v1/cash-sessions')),
    );
  });

  it('POST /cash-sessions', async () => {
    // Cada tenant abre en SU local; si el endpoint no filtrara, A vería la
    // sesión de B o podría abrir caja en un local ajeno.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /cash-sessions',
        (r) =>
          r
            .post('/api/v1/cash-sessions')
            .send({ locationId: demoA.locationId, openingFloatMinor: 0 }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('GET /kitchen/queue', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /kitchen/queue', (r) =>
        r.get(`/api/v1/kitchen/queue?kitchen=${demoA.kitchenId}`),
      ),
    );
  });

  it('GET /kitchen/load', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /kitchen/load', (r) =>
        r.get(`/api/v1/kitchen/load?kitchen=${demoA.kitchenId}`),
      ),
    );
  });

  it('GET /inventory/stock', async () => {
    // El stock de B revelaría qué insumos maneja y en qué volumen: es
    // información de negocio, no un dato técnico.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/stock', (r) => r.get('/api/v1/inventory/stock')),
    );
  });

  it('GET /inventory/stock filtrando por el almacén de B', async () => {
    // El caso que de verdad importa: A pide EXPLÍCITAMENTE el almacén ajeno.
    // Debe volver vacío, nunca el stock de B.
    await assertEndpointIsolation(
      app,
      caseFor('GET /inventory/stock?warehouse=<B>', (r) =>
        r.get(`/api/v1/inventory/stock?warehouse=${almacenDeB}`),
      ),
    );
  });

  it('POST /inventory/movements sobre el almacén de B', async () => {
    // Ajustar el inventario de otro tenant sería peor que leerlo: no filtra
    // datos, los corrompe.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /inventory/movements',
        (r) =>
          r.post('/api/v1/inventory/movements').send({
            warehouseId: almacenDeB,
            itemId: insumoDeB,
            quantity: '-1.0000',
            reason: 'Intento de ajuste cruzado',
          }),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /documents', async () => {
    // Los comprobantes de B llevan su RUC, sus importes y sus correlativos:
    // es lo más sensible que guarda el sistema.
    await assertEndpointIsolation(
      app,
      caseFor('GET /documents', (r) => r.get('/api/v1/documents')),
    );
  });

  it('GET /documents/:id de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /documents/:id',
        (r) => r.get(`/api/v1/documents/${documentoDeB}`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /documents/:id/retry sobre el comprobante de B', async () => {
    // Reenviar el comprobante de otro tenant no filtra datos: los DECLARA a
    // SUNAT en su nombre.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /documents/:id/retry',
        (r) => r.post(`/api/v1/documents/${documentoDeB}/retry`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('POST /documents/:id/credit-note sobre el comprobante de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /documents/:id/credit-note',
        (r) =>
          r
            .post(`/api/v1/documents/${documentoDeB}/credit-note`)
            .send({ reason: 'Intento de anulación cruzada' }),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /analytics/profitability', async () => {
    // La rentabilidad de B es su información más sensible: dice qué marcas le
    // funcionan y por qué canal.
    await assertEndpointIsolation(
      app,
      caseFor('GET /analytics/profitability', (r) =>
        r.get('/api/v1/analytics/profitability'),
      ),
    );
  });

  it('GET /analytics/reconciliation', async () => {
    // Se pide un día CONCRETO, y uno en el que solo B tiene facturación.
    //
    // Sin fecha fija, el caso preguntaba por «hoy» y dependía de dos cosas
    // frágiles: la hora a la que corre la suite y lo que las pruebas anteriores
    // le hubieran hecho al comprobante de B (`retry`, `credit-note`). Cuando el
    // resultado salía vacío para los dos tenants, el detector veía dos
    // respuestas idénticas y cantaba fuga donde no la había — y, peor, el caso
    // no comprobaba nada: un endpoint que devuelve ceros a todo el mundo no
    // puede filtrar mal.
    //
    // Con `DIA_SOLO_DE_B`, A responde ceros y B responde su facturación. Si
    // algún día coinciden, esta vez sí significa que algo se está cruzando.
    await assertEndpointIsolation(
      app,
      caseFor('GET /analytics/reconciliation', (r) =>
        r.get(`/api/v1/analytics/reconciliation?date=${DIA_SOLO_DE_B}`),
      ),
    );
  });

  it('GET /messaging/kpi', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /messaging/kpi', (r) => r.get('/api/v1/messaging/kpi')),
    );
  });

  it('GET /messaging/orders/:id/stats del pedido de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /messaging/orders/:id/stats',
        (r) => r.get(`/api/v1/messaging/orders/${pedidoDeB}/stats`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /catalog/resolved', async () => {
    // Ambos tenants tienen catálogos con la MISMA estructura y nombres: si
    // hubiera fuga, no se notaría por el contenido, solo por los ids.
    await assertEndpointIsolation(
      app,
      caseFor('GET /catalog/resolved', (r) =>
        r.get(
          `/api/v1/catalog/resolved?brand=${demoA.brandIds[0]}&channel=web`,
        ),
      ),
    );
  });

  it('GET /catalog/versions', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /catalog/versions', (r) =>
        r.get(
          `/api/v1/catalog/versions?brand=${demoA.brandIds[0]}&channel=web`,
        ),
      ),
    );
  });

  it('POST /catalog/publish', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /catalog/publish',
        (r) =>
          r
            .post('/api/v1/catalog/publish')
            .send({ brandId: demoA.brandIds[0], channel: 'web' }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  it('POST /catalog/products/:id/pause', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /catalog/products/:id/pause',
        (r) =>
          r
            .post(`/api/v1/catalog/products/${catA.polloId}/pause`)
            .send({ channels: ['rappi'] }),
        { expectedStatusForA: [201] },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Prueba del propio detector. Un harness de seguridad que no puede fallar no
  // demuestra nada: podría estar pasando por un error en su lógica de búsqueda
  // en vez de por ausencia real de fugas. Aquí se le presenta una fuga
  // simulada —se declara como "secreto de B" un valor que SÍ está en la
  // respuesta de A— y se exige que la detecte.
  // -------------------------------------------------------------------------
  it('GET /payments/intents/:id de la intención de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'GET /payments/intents/:id',
        (r) => r.get(`/api/v1/payments/intents/${intencionDeB}`),
        { expectedStatusForA: [404] },
      ),
    );
  });

  it('GET /payments/orders/:orderId/intents del pedido de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor('GET /payments/orders/:orderId/intents', (r) =>
        r.get(`/api/v1/payments/orders/${pedidoDeB}/intents`),
      ),
    );
  });

  it('POST /payments/intents sobre el pedido de B', async () => {
    // El más peligroso de los tres: si colara, A podría generar un cobro contra
    // un pedido ajeno y desviar el dinero a SU pasarela.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/intents',
        (r) =>
          r
            .post('/api/v1/payments/intents')
            .send({ orderId: pedidoDeB, provider: CULQI_PROVIDER }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('POST /payments/links sobre el pedido de B', async () => {
    // Si colara, A generaría un cobro contra un pedido ajeno y desviaría el
    // dinero a SU pasarela — con un enlace que además puede mandar por WhatsApp.
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/links',
        (r) =>
          r
            .post('/api/v1/payments/links')
            .send({ orderId: pedidoDeB, provider: CULQI_PROVIDER }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('POST /payments/intents/:id/refund sobre el cobro de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/intents/:id/refund',
        (r) =>
          r
            .post(`/api/v1/payments/intents/${intencionDeB}/refund`)
            .send({ reason: 'Intento de devolver plata ajena' }),
        { expectedStatusForA: [404, 422] },
      ),
    );
  });

  it('POST /payments/links/:token/revoke del enlace de B', async () => {
    await assertEndpointIsolation(
      app,
      caseFor(
        'POST /payments/links/:token/revoke',
        (r) => r.post(`/api/v1/payments/links/${enlaceDeB}/revoke`),
        { expectedStatusForA: [404, 204] },
      ),
    );
  });

  it('el harness DETECTA una fuga simulada (prueba del detector)', async () => {
    const conFugaDeliberada: IsolationCase = {
      name: 'GET /organization (fuga simulada)',
      request: (r) => r.get('/api/v1/organization'),
      tokenA,
      secretsOfB: [demoA.kitchenId], // en realidad es de A: debe saltar
    };

    let detectada = false;
    try {
      await assertEndpointIsolation(app, conFugaDeliberada);
    } catch (error) {
      detectada = true;
      expect((error as Error).message).toContain('FUGA DE AISLAMIENTO');
    }
    expect(
      detectada,
      'El harness NO detectó una fuga deliberada: su lógica de búsqueda está rota ' +
        'y las demás pruebas de aislamiento no significan nada.',
    ).toBe(true);
  });

  it('el harness detecta fugas ANIDADAS en profundidad', async () => {
    // El id de una cocina vive dentro de organization.kitchens[].id — anidado
    // dos niveles. Un detector que solo mirase las claves de primer nivel no lo
    // vería.
    const anidada: IsolationCase = {
      name: 'GET /organization (fuga anidada)',
      request: (r) => r.get('/api/v1/organization'),
      tokenA,
      secretsOfB: [demoA.stationIds[0]!, demoA.companyId],
    };

    let detectada = false;
    try {
      await assertEndpointIsolation(app, anidada);
    } catch {
      detectada = true;
    }
    // companyId aparece anidado en brands[].companyId → debe detectarse.
    expect(detectada).toBe(true);
  });
});
