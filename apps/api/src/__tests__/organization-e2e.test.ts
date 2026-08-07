import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { VersioningType, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import * as schema from '../database/schema/index.js';
import { TenancyService } from '../modules/tenancy/index.js';
import {
  OrganizationService,
  seedDemoOrganization,
} from '../modules/organization/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Pruebas del módulo Organization (spec 03).
 *
 * Cubre los cuatro casos que la spec exige explícitamente:
 * punto en frontera de polígono · horario cruzando medianoche ·
 * M:N con 2 marcas y 1 cocina (y viceversa) · aislamiento entre tenants.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Organization e2e', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 5 });
  const created: string[] = [];

  let tenantA = '';
  let tenantB = '';
  let tokenA = '';
  let demoA: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let demoB: Awaited<ReturnType<typeof seedDemoOrganization>>;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Org Tenant A',
      planCode: 'growth',
      owner: {
        email: 'org-a@sahana.test',
        password: 'password-org-a-1',
        fullName: 'Dueño Org A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Org Tenant B',
      planCode: 'growth',
      owner: {
        email: 'org-b@sahana.test',
        password: 'password-org-b-1',
        fullName: 'Dueño Org B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    demoA = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    demoB = await withTenant(pool, tenantB, (ctx) => seedDemoOrganization(ctx));

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'org-a@sahana.test', password: 'password-org-a-1' })
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

  // ------------------------------------------ Semilla de aceptación (spec 03)

  it('la semilla demo crea la estructura exigida por la spec', async () => {
    const res = await auth(http().get('/api/v1/organization')).expect(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.brands).toHaveLength(2);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.kitchens).toHaveLength(1);
    expect(demoA.stationIds).toHaveLength(3);
    expect(demoA.zoneIds).toHaveLength(2);
  });

  // ------------------------------------------------ M:N marca ⟷ cocina

  it('UNA cocina produce para DOS marcas (RN-ORG-01)', async () => {
    const org = app.get(OrganizationService);
    const marcas = await org.brandsForKitchen(tenantA, demoA.kitchenId);
    expect(marcas).toHaveLength(2);
    expect(marcas.map((m) => m.slug).sort()).toEqual([
      'buen-sabor',
      'wok-express',
    ]);
  });

  it('cada marca encuentra su cocina (el otro lado del M:N)', async () => {
    const org = app.get(OrganizationService);
    for (const brandId of demoA.brandIds) {
      const cocinas = await org.kitchensForBrand(tenantA, brandId);
      expect(cocinas).toHaveLength(1);
      expect(cocinas[0]!.id).toBe(demoA.kitchenId);
    }
  });

  it('UNA marca puede producirse en DOS cocinas', async () => {
    const org = app.get(OrganizationService);
    const segundaCocina = await withTenant(pool, tenantA, async (ctx) => {
      const [k] = await ctx.db
        .insert(schema.kitchens)
        .values({
          tenantId: tenantA,
          locationId: demoA.locationId,
          name: 'Cocina Satélite',
        })
        .returning({ id: schema.kitchens.id });
      await ctx.db.insert(schema.brandKitchens).values({
        tenantId: tenantA,
        brandId: demoA.brandIds[0],
        kitchenId: k!.id,
      });
      return k!.id;
    });

    const cocinas = await org.kitchensForBrand(tenantA, demoA.brandIds[0]);
    expect(cocinas.map((c) => c.id).sort()).toEqual(
      [demoA.kitchenId, segundaCocina].sort(),
    );

    // Limpieza para no afectar a otras pruebas.
    await withTenant(pool, tenantA, async (ctx) => {
      await ctx.client.query('DELETE FROM org_kitchens WHERE id = $1', [
        segundaCocina,
      ]);
    });
  });

  // ------------------------------------------------- Cobertura y FRONTERA

  it('un punto en el centro devuelve la zona MÁS BARATA del solapamiento', async () => {
    // (-77.02, -12.12) cae en ambas zonas; gana la céntrica (S/ 5.00).
    const res = await auth(
      http().get('/api/v1/coverage?lat=-12.12&lng=-77.02'),
    ).expect(200);

    expect(res.body.zoneName).toBe('Zona céntrica');
    expect(res.body.deliveryFee.minorUnits).toBe(50_000); // 5.0000 a escala 4
    expect(res.body.deliveryFee.currency).toBe('PEN');
    expect(res.body.baseMinutes).toBe(30);
  });

  it('un punto solo en la zona amplia devuelve esa zona', async () => {
    // lat -12.155 queda fuera de la céntrica pero dentro de la amplia.
    const res = await auth(
      http().get('/api/v1/coverage?lat=-12.155&lng=-77.02'),
    ).expect(200);
    expect(res.body.zoneName).toBe('Zona amplia');
    expect(res.body.deliveryFee.minorUnits).toBe(85_000); // 8.5000
  });

  it('PUNTO EN LA FRONTERA del polígono tiene cobertura (caso de la spec)', async () => {
    // Vértice exacto de la zona céntrica: [-77.04, -12.14].
    const vertice = await auth(
      http().get('/api/v1/coverage?lat=-12.14&lng=-77.04'),
    ).expect(200);
    expect(vertice.body.zoneName).toBe('Zona céntrica');

    // Punto sobre una arista (borde superior de la céntrica, lat -12.11).
    const arista = await auth(
      http().get('/api/v1/coverage?lat=-12.11&lng=-77.02'),
    ).expect(200);
    expect(arista.body.zoneName).toBe('Zona céntrica');

    // Frontera EXTERIOR de la zona amplia: también cubre.
    const bordeAmplia = await auth(
      http().get('/api/v1/coverage?lat=-12.16&lng=-77.05'),
    ).expect(200);
    expect(bordeAmplia.body.zoneName).toBe('Zona amplia');
  });

  it('fuera de toda zona responde 404 con Problem Details', async () => {
    const res = await auth(
      http().get('/api/v1/coverage?lat=-12.30&lng=-76.80'),
    ).expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.detail).toContain('cobertura');
  });

  it('valida los parámetros de entrada', async () => {
    await auth(http().get('/api/v1/coverage')).expect(422);
    await auth(http().get('/api/v1/coverage?lat=abc&lng=-77')).expect(422);
    // Fuera del rango geográfico válido.
    await auth(http().get('/api/v1/coverage?lat=95&lng=-77')).expect(422);
  });

  // --------------------------------------------------------- Horarios

  it('el local está abierto a mediodía de un martes', async () => {
    const org = app.get(OrganizationService);
    // 2026-08-11 (martes) 17:00Z = 12:00 en Lima.
    const r = await org.isOpen(tenantA, demoA.locationId, {
      at: new Date('2026-08-11T17:00:00Z'),
    });
    expect(r.open).toBe(true);
    expect(r.timezone).toBe('America/Lima');
    expect(r.localTime).toBe('2026-08-11 12:00');
  });

  it('HORARIO QUE CRUZA MEDIANOCHE: sábado 01:00 sigue abierto (caso de la spec)', async () => {
    const org = app.get(OrganizationService);
    // El viernes cierra a las 02:00 del sábado.
    // 2026-08-15 (sábado) 06:00Z = 01:00 del sábado en Lima.
    const abierto = await org.isOpen(tenantA, demoA.locationId, {
      at: new Date('2026-08-15T06:00:00Z'),
    });
    expect(abierto.localTime).toBe('2026-08-15 01:00');
    expect(abierto.open).toBe(true);

    // A las 03:00 del sábado ya cerró (y aún no abre hasta las 11:00).
    const cerrado = await org.isOpen(tenantA, demoA.locationId, {
      at: new Date('2026-08-15T08:00:00Z'), // 03:00 en Lima
    });
    expect(cerrado.localTime).toBe('2026-08-15 03:00');
    expect(cerrado.open).toBe(false);
  });

  it('la excepción de feriado cierra el día', async () => {
    const org = app.get(OrganizationService);
    // 2026-07-28 (Fiestas Patrias) 17:00Z = 12:00 en Lima.
    const r = await org.isOpen(tenantA, demoA.locationId, {
      at: new Date('2026-07-28T17:00:00Z'),
    });
    expect(r.open).toBe(false);
  });

  it('un local inexistente responde 404', async () => {
    await auth(
      http().get(
        '/api/v1/organization/open?location=00000000-0000-0000-0000-000000000000',
      ),
    ).expect(404);
  });

  // ------------------------------------------------------- AISLAMIENTO

  it('la estructura de un tenant no incluye datos del otro', async () => {
    const res = await auth(http().get('/api/v1/organization')).expect(200);
    const ids = [
      ...res.body.companies.map((c: { id: string }) => c.id),
      ...res.body.brands.map((b: { id: string }) => b.id),
      ...res.body.locations.map((l: { id: string }) => l.id),
      ...res.body.kitchens.map((k: { id: string }) => k.id),
    ];
    expect(ids).toContain(demoA.companyId);
    // Ni un solo id del tenant B.
    expect(ids).not.toContain(demoB.companyId);
    expect(ids).not.toContain(demoB.kitchenId);
    expect(ids).not.toContain(demoB.locationId);
  });

  it('la cobertura del tenant A nunca devuelve una zona del tenant B', async () => {
    // Ambos tenants tienen zonas con la MISMA geometría: si hubiera fuga, el
    // resultado podría venir del otro tenant sin que se note por el nombre.
    const res = await auth(
      http().get('/api/v1/coverage?lat=-12.12&lng=-77.02'),
    ).expect(200);
    expect(demoA.zoneIds).toContain(res.body.zoneId);
    expect(demoB.zoneIds).not.toContain(res.body.zoneId);
  });

  it('el M:N de un tenant no ve cocinas del otro', async () => {
    const org = app.get(OrganizationService);
    // Preguntar por una marca del tenant B DESDE el contexto del tenant A.
    const cocinas = await org.kitchensForBrand(tenantA, demoB.brandIds[0]);
    expect(cocinas).toEqual([]);
  });

  // --------------------------------- FKs compuestas (docs/09 §4)

  it('la BD impide relacionar entidades de tenants distintos', async () => {
    // Intentar unir una marca del tenant A con una cocina del tenant B.
    // La RLS ya lo filtraría; la FK compuesta lo hace estructuralmente imposible.
    await expect(
      withTenant(pool, tenantA, async (ctx) => {
        await ctx.client.query(
          `INSERT INTO org_brand_kitchens (tenant_id, brand_id, kitchen_id)
           VALUES ($1, $2, $3)`,
          [tenantA, demoA.brandIds[0], demoB.kitchenId],
        );
      }),
    ).rejects.toThrow();
  });

  it('una marca no puede colgar de una empresa de otro tenant', async () => {
    await expect(
      withTenant(pool, tenantA, async (ctx) => {
        await ctx.client.query(
          `INSERT INTO org_brands (tenant_id, company_id, name, slug)
           VALUES ($1, $2, 'Marca Pirata', 'pirata')`,
          [tenantA, demoB.companyId],
        );
      }),
    ).rejects.toThrow();
  });

  // ------------------------------------------------- Reglas de integridad

  it('la tarifa de envío no puede ser negativa', async () => {
    await expect(
      withTenant(pool, tenantA, async (ctx) => {
        await ctx.client.query(
          `INSERT INTO org_zones
             (tenant_id, location_id, name, polygon, min_lng, min_lat, max_lng, max_lat, delivery_fee)
           VALUES ($1, $2, 'Zona inválida', '[[0,0],[0,1],[1,1]]'::jsonb, 0, 0, 1, 1, -5)`,
          [tenantA, demoA.locationId],
        );
      }),
    ).rejects.toThrow(/zone_fee_no_negativa/);
  });

  it('el slug de marca es único dentro del tenant, pero no entre tenants', async () => {
    // Duplicar dentro del mismo tenant falla...
    await expect(
      withTenant(pool, tenantA, async (ctx) => {
        await ctx.db.insert(schema.brands).values({
          tenantId: tenantA,
          companyId: demoA.companyId,
          name: 'Otra',
          slug: 'buen-sabor',
        });
      }),
    ).rejects.toThrow();

    // ...pero el tenant B ya tiene el mismo slug sin conflicto (lo creó la semilla).
    const slugsB = await withTenant(pool, tenantB, async (ctx) =>
      ctx.db.select({ slug: schema.brands.slug }).from(schema.brands),
    );
    expect(slugsB.map((b) => b.slug)).toContain('buen-sabor');
  });
});
