import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
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

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
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
      demoB.zoneIds[0],
      demoB.zoneIds[1],
      demoB.scheduleId,
      ...demoB.stationIds,
      'Aislamiento Tenant B SECRETO',
      'iso-b@sahana.test',
    ];

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
