import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Money } from '@sahana/domain';
import { AppModule } from '../app.module.js';
import { configureApp } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { CatalogService, seedDemoCatalog } from '../modules/catalog/index.js';
import { pendingCount, relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Catálogo (spec 04). Casos que la spec exige explícitamente:
 * resolución de precio en los 3 niveles · pausa propagada por evento ·
 * combo con modificadores · aislamiento.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Catalog e2e', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let orgA: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let catA: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let brandId = '';

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
      name: 'Cat Tenant A',
      planCode: 'growth',
      owner: {
        email: 'cat-a@sahana.test',
        password: 'password-cat-a-1',
        fullName: 'Dueño Cat A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    orgA = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = orgA.brandIds[0];
    catA = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: orgA.locationId }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cat-a@sahana.test', password: 'password-cat-a-1' })
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

  // ------------------------------- Resolución de precio en 3 niveles (RN-CAT-01)

  it('canal sin precio propio usa el PRECIO BASE', async () => {
    const res = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=pos`),
    ).expect(200);

    const pollo = res.body.products.find(
      (p: { id: string }) => p.id === catA.polloId,
    );
    expect(pollo.price.minorUnits).toBe(Money.parse('30.00').minorUnits);
  });

  it('el precio de CANAL gana al base', async () => {
    const res = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);

    const pollo = res.body.products.find(
      (p: { id: string }) => p.id === catA.polloId,
    );
    expect(pollo.price.minorUnits).toBe(Money.parse('32.00').minorUnits);
  });

  it('el precio de (CANAL, LOCAL) gana a los dos anteriores', async () => {
    const res = await auth(
      http().get(
        `/api/v1/catalog/resolved?brand=${brandId}&channel=web&location=${orgA.locationId}`,
      ),
    ).expect(200);

    const pollo = res.body.products.find(
      (p: { id: string }) => p.id === catA.polloId,
    );
    expect(pollo.price.minorUnits).toBe(Money.parse('35.00').minorUnits);
    expect(pollo.price.currency).toBe('PEN');
  });

  it('SIN PRECIO PARA EL CANAL, el producto es INVISIBLE ahí (RN-CAT-01)', async () => {
    // "Promo mostrador" solo tiene precio en POS.
    const enPos = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=pos`),
    ).expect(200);
    expect(
      enPos.body.products.some((p: { id: string }) => p.id === catA.soloPosId),
    ).toBe(true);

    const enWeb = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);
    expect(
      enWeb.body.products.some((p: { id: string }) => p.id === catA.soloPosId),
    ).toBe(false);
  });

  it('el servicio resuelve el precio individualmente igual que el catálogo', async () => {
    const catalog = app.get(CatalogService);
    const enWeb = await catalog.resolveProductPrice(tenantA, catA.polloId, {
      channel: 'web',
    });
    expect(enWeb?.toDecimalString()).toBe('32.0000');

    const inexistente = await catalog.resolveProductPrice(
      tenantA,
      catA.soloPosId,
      { channel: 'web' },
    );
    expect(inexistente).toBeUndefined();
  });

  // ----------------------------------------------- Modificadores y combos

  it('el catálogo entrega los grupos de modificadores con sus opciones', async () => {
    const res = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);

    const pollo = res.body.products.find(
      (p: { id: string }) => p.id === catA.polloId,
    );
    expect(pollo.modifierGroups).toHaveLength(2);

    const tamano = pollo.modifierGroups.find(
      (g: { id: string }) => g.id === catA.groupTamanoId,
    );
    expect(tamano.minSelections).toBe(1); // obligatorio
    expect(tamano.maxSelections).toBe(1);
    const grande = tamano.options.find(
      (o: { id: string }) => o.id === catA.optionGrandeId,
    );
    expect(grande.priceDeltaMinor).toBe(Money.parse('5.00').minorUnits);

    const extras = pollo.modifierGroups.find(
      (g: { id: string }) => g.id === catA.groupExtrasId,
    );
    expect(extras.minSelections).toBe(0); // opcional
    // Un modificador con precio NEGATIVO (quitar ingrediente).
    const sinPapas = extras.options.find(
      (o: { name: string }) => o.name === 'Sin papas',
    );
    expect(sinPapas.priceDeltaMinor).toBe(Money.parse('-2.00').minorUnits);
    // Y una opción agotada, que llega marcada para que la UI la muestre gris.
    const trufa = extras.options.find((o: { name: string }) =>
      o.name.includes('Trufa'),
    );
    expect(trufa.available).toBe(false);
  });

  it('el combo aparece marcado y con precio propio', async () => {
    const res = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);
    const combo = res.body.products.find(
      (p: { id: string }) => p.id === catA.comboId,
    );
    expect(combo.isCombo).toBe(true);
    expect(combo.price.minorUnits).toBe(Money.parse('38.00').minorUnits);
  });

  // ------------------------------------------------ Pausa (RN-CAT-03)

  it('pausar un producto lo saca del catálogo y EMITE EVENTO por el outbox', async () => {
    const antes = await pendingCount(pool);

    await auth(
      http()
        .post(`/api/v1/catalog/products/${catA.polloId}/pause`)
        .send({ channels: ['web'], reason: 'Sin pollo' }),
    ).expect(201);

    // Fuera del catálogo de web...
    const web = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);
    expect(
      web.body.products.some((p: { id: string }) => p.id === catA.polloId),
    ).toBe(false);

    // ...pero sigue disponible en POS: la pausa es por canal.
    const pos = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=pos`),
    ).expect(200);
    expect(
      pos.body.products.some((p: { id: string }) => p.id === catA.polloId),
    ).toBe(true);

    // El evento de propagación quedó en el outbox, en la misma transacción.
    expect(await pendingCount(pool)).toBe(antes + 1);
    let evento:
      { eventType: string; payload: Record<string, unknown> } | undefined;
    await relayOnce(pool, async (record) => {
      if (record.aggregateId === catA.polloId) evento = record;
    });
    expect(evento?.eventType).toBe('catalog.availability_changed');
    expect(evento?.payload['paused']).toBe(true);
    expect(evento?.payload['channels']).toEqual(['web']);
  });

  it('reactivar lo devuelve al catálogo y emite el evento inverso', async () => {
    await auth(
      http()
        .post(`/api/v1/catalog/products/${catA.polloId}/resume`)
        .send({ channels: ['web'] }),
    ).expect(201);

    const web = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);
    expect(
      web.body.products.some((p: { id: string }) => p.id === catA.polloId),
    ).toBe(true);

    let evento: { payload: Record<string, unknown> } | undefined;
    await relayOnce(pool, async (record) => {
      if (record.aggregateId === catA.polloId) evento = record;
    });
    expect(evento?.payload['paused']).toBe(false);
  });

  it('UNA PAUSA CADUCADA SE AUTOLEVANTA sin intervención', async () => {
    // Pausa que ya expiró: nadie tiene que acordarse de reactivar en hora punta.
    await withTenant(pool, tenantA, async (ctx) => {
      await ctx.client.query(
        `INSERT INTO cat_product_pauses (tenant_id, product_id, channel, until)
         VALUES ($1, $2, 'web', now() - interval '1 hour')
         ON CONFLICT (tenant_id, product_id, channel) DO UPDATE
           SET until = EXCLUDED.until`,
        [tenantA, catA.comboId],
      );
    });

    const web = await auth(
      http().get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`),
    ).expect(200);
    expect(
      web.body.products.some((p: { id: string }) => p.id === catA.comboId),
    ).toBe(true);
  });

  it('la pausa comodín afecta a todos los canales', async () => {
    await auth(
      http()
        .post(`/api/v1/catalog/products/${catA.comboId}/pause`)
        .send({ channels: ['*'] }),
    ).expect(201);

    for (const canal of ['web', 'pos', 'rappi']) {
      const res = await auth(
        http().get(
          `/api/v1/catalog/resolved?brand=${brandId}&channel=${canal}`,
        ),
      ).expect(200);
      expect(
        res.body.products.some((p: { id: string }) => p.id === catA.comboId),
      ).toBe(false);
    }

    await auth(
      http()
        .post(`/api/v1/catalog/products/${catA.comboId}/resume`)
        .send({ channels: ['*'] }),
    ).expect(201);
    await relayOnce(pool, async () => undefined);
  });

  it('pausar un producto inexistente responde 404', async () => {
    await auth(
      http()
        .post(
          '/api/v1/catalog/products/00000000-0000-0000-0000-000000000000/pause',
        )
        .send({ channels: ['web'] }),
    ).expect(404);
  });

  it('valida la entrada', async () => {
    await auth(
      http().post(`/api/v1/catalog/products/${catA.polloId}/pause`).send({}),
    ).expect(422);
    await auth(
      http()
        .post(`/api/v1/catalog/products/${catA.polloId}/pause`)
        .send({ channels: [] }),
    ).expect(422);
    await auth(http().get('/api/v1/catalog/resolved')).expect(422);
  });

  // ------------------------------------------------------- Permisos

  it('leer el catálogo exige catalog.read; escribir exige catalog.write', async () => {
    // El contador tiene reports.read pero no catalog.write.
    await withTenant(pool, tenantA, async (ctx) => {
      const { AuthService } = await import('../modules/identity/index.js');
      const hash = await AuthService.hashPassword('password-contador-1');
      const { eq } = await import('drizzle-orm');
      const schema = await import('../database/schema/index.js');
      const [u] = await ctx.db
        .insert(schema.users)
        .values({
          tenantId: tenantA,
          email: 'contador-cat@sahana.test',
          passwordHash: hash,
          fullName: 'Contador',
        })
        .returning({ id: schema.users.id });
      const [rol] = await ctx.db
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(eq(schema.roles.code, 'accountant'))
        .limit(1);
      await ctx.db.insert(schema.userRoles).values({
        tenantId: tenantA,
        userId: u!.id,
        roleId: rol!.id,
        scopeType: 'tenant',
        scopeId: null,
      });
    });

    const login = await http()
      .post('/api/v1/auth/login')
      .send({
        email: 'contador-cat@sahana.test',
        password: 'password-contador-1',
      })
      .expect(201);
    const tokenContador = login.body.accessToken;

    // No puede leer catálogo (el contador no tiene catalog.read).
    await http()
      .get(`/api/v1/catalog/resolved?brand=${brandId}&channel=web`)
      .set('authorization', `Bearer ${tokenContador}`)
      .expect(403);

    // Ni pausar.
    await http()
      .post(`/api/v1/catalog/products/${catA.polloId}/pause`)
      .set('authorization', `Bearer ${tokenContador}`)
      .send({ channels: ['web'] })
      .expect(403);
  });
});
