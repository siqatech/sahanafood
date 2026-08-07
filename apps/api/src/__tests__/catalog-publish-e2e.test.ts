import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Money, applyCatalogDiff } from '@sahana/domain';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import {
  seedDemoCatalog,
  CatalogPublicationService,
} from '../modules/catalog/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import * as schema from '../database/schema/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Publicación versionada del catálogo (spec 04, T4.06).
 *
 * Los dos criterios de aceptación de la spec son la columna vertebral de esta
 * suite: la versión publicada es INMUTABLE y descargable, y **publicar no
 * bloquea ventas en curso**.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Catálogo versionado', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let publication: CatalogPublicationService;
  let ordering: OrderingService;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    publication = app.get(CatalogPublicationService);
    ordering = app.get(OrderingService);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Publicación Tenant',
      planCode: 'growth',
      owner: {
        email: 'pub-a@sahana.test',
        password: 'password-pub-a-1',
        fullName: 'Dueño Publicación',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0];
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'pub-a@sahana.test', password: 'password-pub-a-1' })
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

  /** Cambia el precio base del pollo, que es lo que mueve el catálogo. */
  const cambiarPrecioPollo = (precio: string) =>
    withTenant(pool, tenantA, async ({ client }) => {
      await client.query(
        `UPDATE cat_prices SET price = $1
          WHERE product_id = $2 AND channel IS NULL AND location_id IS NULL`,
        [precio, cat.polloId],
      );
    });

  // ------------------------------------------------------------ Publicar

  it('la primera publicación es la versión 1 y trae los productos del canal', async () => {
    const res = await auth(
      http()
        .post('/api/v1/catalog/publish')
        .send({ brandId, channel: 'pos' }),
    ).expect(201);

    expect(res.body.version).toBe(1);
    expect(res.body.productCount).toBeGreaterThan(0);
    expect(res.body.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('republicar SIN cambios devuelve la misma versión, no crea otra', async () => {
    // Pulsar «publicar» tres veces por nerviosismo no puede hacer que la PWA
    // se descargue tres catálogos idénticos.
    const primera = await publication.publish(tenantA, {
      brandId,
      channel: 'republicar',
    });
    const segunda = await publication.publish(tenantA, {
      brandId,
      channel: 'republicar',
    });

    expect(segunda.version).toBe(primera.version);
    expect(segunda.reused).toBe(true);

    const versiones = await publication.listVersions(tenantA, {
      brandId,
      channel: 'republicar',
    });
    expect(versiones).toHaveLength(1);
  });

  it('un cambio real de precio sí genera una versión nueva', async () => {
    const v1 = await publication.publish(tenantA, {
      brandId,
      channel: 'cambio-precio',
    });
    await cambiarPrecioPollo('31.0000');
    const v2 = await publication.publish(tenantA, {
      brandId,
      channel: 'cambio-precio',
    });

    expect(v2.version).toBe(v1.version + 1);
    expect(v2.checksum).not.toBe(v1.checksum);
    await cambiarPrecioPollo('30.0000');
  });

  // --------------------------------------------------------- Inmutabilidad

  it('una versión publicada NO se puede reescribir ni borrar', async () => {
    // Es la referencia para responder «qué se ofrecía el martes a las 20:00»
    // cuando un cliente reclame. Lo impide la base, no una revisión de código.
    const v = await publication.publish(tenantA, {
      brandId,
      channel: 'inmutable',
    });

    await expect(
      withTenant(pool, tenantA, async ({ client }) => {
        await client.query(
          "UPDATE cat_catalog_versions SET checksum = 'falsificado' WHERE id = $1",
          [v.id],
        );
      }),
    ).rejects.toThrow(/permission denied|permiso denegado/i);

    await expect(
      withTenant(pool, tenantA, async ({ client }) => {
        await client.query('DELETE FROM cat_catalog_versions WHERE id = $1', [
          v.id,
        ]);
      }),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });

  it('cambiar el catálogo NO altera una versión ya publicada', async () => {
    const v1 = await publication.publish(tenantA, {
      brandId,
      channel: 'congelado',
    });
    const descargada1 = await publication.getVersion(tenantA, {
      brandId,
      channel: 'congelado',
      version: v1.version,
    });
    const polloAntes = descargada1.snapshot.products.find(
      (p) => p.id === cat.polloId,
    );
    expect(polloAntes!.priceMinor).toBe(Money.parse('30.00').minorUnits);

    await cambiarPrecioPollo('99.0000');
    const descargadaDeNuevo = await publication.getVersion(tenantA, {
      brandId,
      channel: 'congelado',
      version: v1.version,
    });
    expect(
      descargadaDeNuevo.snapshot.products.find((p) => p.id === cat.polloId)!
        .priceMinor,
      'la versión publicada cambió al tocar el catálogo vivo: el POS offline no podría fiarse de nada',
    ).toBe(Money.parse('30.00').minorUnits);

    await cambiarPrecioPollo('30.0000');
  });

  // ------------------------------------------------------------- Descarga

  it('descarga la última versión sin indicar número', async () => {
    await publication.publish(tenantA, { brandId, channel: 'descarga' });
    await cambiarPrecioPollo('33.0000');
    const v2 = await publication.publish(tenantA, {
      brandId,
      channel: 'descarga',
    });

    const res = await auth(
      http().get('/api/v1/catalog/versions/download?brand=' + brandId + '&channel=descarga'),
    ).expect(200);

    expect(res.body.version).toBe(v2.version);
    expect(res.body.snapshot.products.length).toBeGreaterThan(0);
    await cambiarPrecioPollo('30.0000');
  });

  it('pedir una versión inexistente responde 404', async () => {
    await auth(
      http().get(
        `/api/v1/catalog/versions/download?brand=${brandId}&channel=pos&version=9999`,
      ),
    ).expect(404);
  });

  it('un canal sin publicar responde 404 en vez de un catálogo vacío', async () => {
    // Devolver `{products: []}` haría que el POS creyera que no hay nada que
    // vender, en vez de que nadie ha publicado todavía.
    await auth(
      http().get(
        `/api/v1/catalog/versions/download?brand=${brandId}&channel=canal-virgen`,
      ),
    ).expect(404);
  });

  // ------------------------------------------------------------ Diferencias

  it('el diff entre dos versiones reconstruye exactamente la segunda', async () => {
    // Es la propiedad que hace útil el diff: el POS que lo aplica termina con
    // el mismo catálogo que el servidor, sin descargarlo entero.
    const v1 = await publication.publish(tenantA, { brandId, channel: 'diff' });
    await cambiarPrecioPollo('37.0000');
    const v2 = await publication.publish(tenantA, { brandId, channel: 'diff' });

    const res = await auth(
      http().get(
        `/api/v1/catalog/versions/diff?brand=${brandId}&channel=diff&from=${v1.version}&to=${v2.version}`,
      ),
    ).expect(200);

    expect(res.body.identical).toBe(false);
    expect(res.body.changed).toHaveLength(1);
    expect(res.body.changed[0].changes[0]).toMatchObject({
      field: 'priceMinor',
      from: Money.parse('30.00').minorUnits,
      to: Money.parse('37.00').minorUnits,
    });

    const base = await publication.getVersion(tenantA, {
      brandId,
      channel: 'diff',
      version: v1.version,
    });
    const destino = await publication.getVersion(tenantA, {
      brandId,
      channel: 'diff',
      version: v2.version,
    });

    const reconstruido = applyCatalogDiff(base.snapshot, res.body);
    const clave = (ps: Array<{ id: string; priceMinor: number }>) =>
      [...ps]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => `${p.id}:${p.priceMinor}`)
        .join('|');
    expect(clave(reconstruido.products)).toBe(clave(destino.snapshot.products));

    await cambiarPrecioPollo('30.0000');
  });

  it('el diff detecta un producto que dejó de venderse en el canal', async () => {
    const v1 = await publication.publish(tenantA, {
      brandId,
      channel: 'retirada',
    });
    // Se pausa el pollo en ese canal: desaparece del catálogo resuelto.
    await auth(
      http()
        .post(`/api/v1/catalog/products/${cat.polloId}/pause`)
        .send({ channels: ['retirada'] }),
    ).expect(201);

    const v2 = await publication.publish(tenantA, {
      brandId,
      channel: 'retirada',
    });
    const d = await publication.diff(tenantA, {
      brandId,
      channel: 'retirada',
      from: v1.version,
      to: v2.version,
    });

    expect(d.removed.map((p) => p.id)).toContain(cat.polloId);
  });

  // ------------------------- Publicar NO bloquea ventas (criterio de la spec)

  it('PUBLICAR NO BLOQUEA VENTAS: pedidos concurrentes durante la publicación', async () => {
    // El criterio de aceptación de la spec 04, verificado como ocurre en la
    // vida real: se publica mientras entran pedidos. Si la publicación tomara
    // cerrojos sobre productos o precios, algún submit se quedaría esperando o
    // fallaría, y sería en hora punta.
    const pedidos = Array.from({ length: 12 }, () =>
      ordering.submit(tenantA, {
        brandId,
        locationId: org.locationId,
        channel: 'pos',
        lines: [{ productId: cat.comboId, quantity: 1 }],
      }),
    );
    const publicaciones = [
      publication.publish(tenantA, { brandId, channel: 'pos' }),
      publication.publish(tenantA, { brandId, channel: 'concurrente-1' }),
      publication.publish(tenantA, { brandId, channel: 'concurrente-2' }),
    ];

    const resultados = await Promise.allSettled([...pedidos, ...publicaciones]);
    const fallidos = resultados.filter((r) => r.status === 'rejected');

    expect(
      fallidos.map((f) => (f as PromiseRejectedResult).reason?.message),
      'publicar interfirió con las ventas en curso',
    ).toEqual([]);
  }, 30_000);

  it('la publicación deja traza en auditoría y evento por el outbox', async () => {
    const v = await publication.publish(tenantA, {
      brandId,
      channel: 'trazado',
      actorId: org.companyId, // un uuid cualquiera como actor
      notes: 'Publicación de prueba',
    });

    const filas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ event_type: string }>(
        "SELECT event_type FROM outbox WHERE aggregate_type = 'catalog' AND payload->>'channel' = 'trazado'",
      );
      return rows;
    });
    expect(filas.map((f) => f.event_type)).toContain('catalog.published');

    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ resource_id: string }>(
        "SELECT resource_id FROM audit_log WHERE action = 'catalog.published'",
      );
      return rows;
    });
    expect(auditoria.map((a) => a.resource_id)).toContain(v.id);
  });

  it('la versión guardada lleva el número de productos que dice', async () => {
    const v = await publication.publish(tenantA, {
      brandId,
      channel: 'conteo',
    });
    const descargada = await publication.getVersion(tenantA, {
      brandId,
      channel: 'conteo',
      version: v.version,
    });
    expect(descargada.snapshot.products).toHaveLength(v.productCount);
  });

  it('cada canal lleva su propio correlativo', async () => {
    // «La versión 7 de la web de Marca A» tiene que ser una referencia que una
    // persona pueda decir por teléfono sin ambigüedad.
    const web = await publication.publish(tenantA, {
      brandId,
      channel: 'correlativo-web',
    });
    const app2 = await publication.publish(tenantA, {
      brandId,
      channel: 'correlativo-app',
    });
    expect(web.version).toBe(1);
    expect(app2.version).toBe(1);
  });

  it('la marca del otro tenant no aparece en las versiones propias', async () => {
    const versiones = await withTenant(pool, tenantA, async (ctx) => {
      const filas = await ctx.db.select().from(schema.catalogVersions);
      return filas;
    });
    expect(versiones.every((v) => v.tenantId === tenantA)).toBe(true);
  });
});
