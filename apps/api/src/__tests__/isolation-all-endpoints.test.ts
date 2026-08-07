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
