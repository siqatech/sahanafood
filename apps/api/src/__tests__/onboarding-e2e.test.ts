import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { OnboardingService } from '../modules/onboarding/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * La checklist de salida en vivo (docs/26 §5).
 *
 * Lo que se prueba no es que la lista se pinte: es que **no pueda mentir**. Se
 * calcula con seis `EXISTS` sobre lo que ya existe, sin tabla de progreso, y la
 * razón es justamente esta — un estado guardado se desincroniza del mundo, y
 * una checklist que dice «hecho» cuando ya no lo está es peor que ninguna: deja
 * abrir el local convencido de que la facturación funciona.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Checklist de salida en vivo', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 6 });
  const created: string[] = [];

  let onboarding: OnboardingService;
  let tenantA = '';
  let tokenA = '';
  let tenantB = '';
  let tokenB = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    onboarding = app.get(OnboardingService);

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Arranque A',
      planCode: 'growth',
      owner: {
        email: 'arranque-a@sahana.test',
        password: 'password-arranque-a-1',
        fullName: 'Dueña Arranque A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Arranque B',
      planCode: 'growth',
      owner: {
        email: 'arranque-b@sahana.test',
        password: 'password-arranque-b-1',
        fullName: 'Dueño Arranque B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    tokenA = await entrar('arranque-a@sahana.test', 'password-arranque-a-1');
    tokenB = await entrar('arranque-b@sahana.test', 'password-arranque-b-1');
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  async function entrar(email: string, password: string): Promise<string> {
    const r = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return r.body.accessToken as string;
  }

  const http = () => request(app.getHttpServer());
  const como = (token: string) => (r: request.Test) =>
    r.set('authorization', `Bearer ${token}`);

  it('UN TENANT RECIÉN CREADO no tiene nada hecho, y lo dice', async () => {
    // Es el caso que más importa: el dueño que entra por primera vez. Una
    // checklist que arrancara a medias por un dato residual no orientaría a
    // nadie.
    const lista = await onboarding.checklist(tenantA);

    expect(lista.hechos).toBe(0);
    expect(lista.listoParaAbrir).toBe(false);
    expect(lista.pasos.every((p) => !p.hecho)).toBe(true);
    // Todos los pasos dicen POR QUÉ y DÓNDE: sin eso es una lista de deberes.
    for (const paso of lista.pasos) {
      expect(paso.porQue.length).toBeGreaterThan(20);
      expect(paso.donde.startsWith('/panel/')).toBe(true);
    }
  });

  it('EL OPCIONAL no cuenta para el total: 6 de 6 estando la receta sin hacer', async () => {
    // Si la receta contara, un negocio listo para abrir vería «6 de 7» y se
    // quedaría buscando qué le falta, cuando no le falta nada.
    const lista = await onboarding.checklist(tenantA);
    const opcionales = lista.pasos.filter((p) => p.opcional);

    expect(opcionales).toHaveLength(1);
    expect(opcionales[0]!.id).toBe('receta');
    expect(lista.obligatorios).toBe(lista.pasos.length - 1);
  });

  it('UN PASO SE MARCA SOLO cuando el dato existe de verdad', async () => {
    const antes = await onboarding.checklist(tenantA);
    expect(antes.pasos.find((p) => p.id === 'estructura')!.hecho).toBe(false);

    // Se crea la estructura mínima por la API de organización, no a mano.
    const a = como(tokenA);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Arranque S.A.C.', taxId: '20512345677' })
      .expect(201);
    await a(http().post('/api/v1/org/locations'))
      .send({
        companyId: empresa.body.id,
        name: 'Local de arranque',
        address: 'Av. Arequipa 100',
        lat: -12.09,
        lng: -77.03,
      })
      .expect(201);

    const despues = await onboarding.checklist(tenantA);
    expect(despues.pasos.find((p) => p.id === 'estructura')!.hecho).toBe(true);
    expect(despues.hechos).toBe(antes.hechos + 1);
  });

  it('SE DESHACE si el dato desaparece: por eso no se guarda el progreso', async () => {
    // La razón entera de calcularlo en vez de guardarlo. Con una tabla de
    // progreso, borrar el local dejaría la checklist diciendo que está hecho, y
    // el dueño abriría el local convencido de algo que ya no es cierto.
    const conLocal = await onboarding.checklist(tenantA);
    expect(conLocal.pasos.find((p) => p.id === 'estructura')!.hecho).toBe(true);

    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query('DELETE FROM org_locations');
    });

    const sinLocal = await onboarding.checklist(tenantA);
    expect(sinLocal.pasos.find((p) => p.id === 'estructura')!.hecho).toBe(
      false,
    );
  });

  it('por HTTP se devuelve la misma lista', async () => {
    const res = await como(tokenA)(
      http().get('/api/v1/onboarding/checklist'),
    ).expect(200);
    expect(res.body.obligatorios).toBeGreaterThan(0);
    expect(Array.isArray(res.body.pasos)).toBe(true);
  });

  it('sin token no se ve: 403', async () => {
    await http().get('/api/v1/onboarding/checklist').expect(403);
  });

  // ------------------------------------------- MODO PRÁCTICA (docs/26 §4)

  it('un tenant nuevo ESTÁ EN PRÁCTICA', async () => {
    const lista = await onboarding.checklist(tenantB);
    expect(lista.enPractica).toBe(true);
  });

  it('EMPEZAR EN SERIO borra las ventas y CONSERVA la configuración', async () => {
    // Es lo que hace útil practicar: se ensaya con la carta de verdad —cobrar
    // mal, anular, cerrar con descuadre— y se estrena limpio. Si al vaciar se
    // llevara también la carta, nadie practicaría.
    const b = como(tokenB);
    const empresa = await b(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Practica S.A.C.', taxId: '20512345699' })
      .expect(201);
    const marca = await b(http().post('/api/v1/org/brands'))
      .send({ companyId: empresa.body.id, name: 'Marca de práctica' })
      .expect(201);
    await b(http().post('/api/v1/org/locations'))
      .send({
        companyId: empresa.body.id,
        name: 'Local de práctica',
        address: 'Av. Práctica 1',
        lat: -12.11,
        lng: -77.05,
      })
      .expect(201);
    const plato = await b(http().post('/api/v1/catalog/products'))
      .send({ brandId: marca.body.id, sku: 'PRAC-1', name: 'Plato ensayado' })
      .expect(201);
    await b(http().post('/api/v1/catalog/prices'))
      .send({ productId: plato.body.id, priceMinor: 250_000 })
      .expect(201);

    // Una venta de práctica, escrita directa: lo que importa aquí es que se
    // borre, no cómo se creó.
    await withTenant(pool, tenantB, async ({ client }) => {
      await client.query(
        `INSERT INTO ord_orders
           (tenant_id, brand_id, location_id, order_number, channel, status,
            subtotal, discount_total, taxable_base, tax, total, currency)
         VALUES ($1, $2,
           (SELECT id FROM org_locations LIMIT 1),
           1, 'pos', 'delivered', 25, 0, 21.1864, 3.8136, 25, 'PEN')`,
        [tenantB, marca.body.id],
      );
    });

    const res = await b(http().post('/api/v1/onboarding/go-live'))
      .send({ reason: 'Terminamos de ensayar, abrimos el sábado' })
      .expect(201);
    expect(res.body.wentLiveAt).toBeTruthy();
    expect(res.body.borrados.ord_orders).toBe(1);

    // LO QUE IMPORTA: las ventas se fueron, la configuración se quedó.
    const quedo = await withTenant(pool, tenantB, async ({ client }) => {
      const { rows } = await client.query<{
        pedidos: string;
        productos: string;
        precios: string;
        locales: string;
        marcas: string;
      }>(
        `SELECT (SELECT count(*) FROM ord_orders)   AS pedidos,
                (SELECT count(*) FROM cat_products) AS productos,
                (SELECT count(*) FROM cat_prices)   AS precios,
                (SELECT count(*) FROM org_locations) AS locales,
                (SELECT count(*) FROM org_brands)   AS marcas`,
      );
      return rows[0]!;
    });
    expect(Number(quedo.pedidos)).toBe(0);
    expect(Number(quedo.productos)).toBe(1);
    expect(Number(quedo.precios)).toBe(1);
    expect(Number(quedo.locales)).toBe(1);
    expect(Number(quedo.marcas)).toBe(1);
  });

  it('LA AUDITORÍA sobrevive, y guarda el motivo escrito', async () => {
    // Un borrado que borrara su propia huella es justo el que no se puede
    // permitir. `audit_log` es append-only por construcción.
    const huella = await withTenant(pool, tenantB, async ({ client }) => {
      const { rows } = await client.query<{ reason: string | null }>(
        `SELECT reason FROM audit_log WHERE action = 'tenant.went_live'`,
      );
      return rows;
    });
    expect(huella).toHaveLength(1);
    expect(huella[0]!.reason).toContain('ensayar');
  });

  it('YA NO SE PUEDE otra vez: un negocio en serio no vacía sus ventas', async () => {
    // La protección entera. Sin esto, «borrar la práctica» sería un botón que
    // borra la facturación de un negocio con seis meses de historia.
    const lista = await onboarding.checklist(tenantB);
    expect(lista.enPractica).toBe(false);

    await como(tokenB)(http().post('/api/v1/onboarding/go-live'))
      .send({ reason: 'Otra vez, a ver si cuela' })
      .expect(422);
  });

  it('SIN MOTIVO no se ejecuta', async () => {
    await como(tokenA)(http().post('/api/v1/onboarding/go-live'))
      .send({ reason: '' })
      .expect(422);
    await como(tokenA)(http().post('/api/v1/onboarding/go-live'))
      .send({})
      .expect(422);
  });

  // ------------------------------------------------------ AISLAMIENTO

  it('AISLAMIENTO: lo que hace A no marca la checklist de B', async () => {
    // La comprobación obligatoria del endpoint nuevo. Aquí es más sutil que en
    // otros: no se devuelve ningún dato de A, solo un booleano — pero un
    // `EXISTS` sin filtrar por tenant haría que B viera su checklist completa
    // por el trabajo de A, y abriría el local sin haber emitido un comprobante
    // en su vida.
    const antesDeB = await onboarding.checklist(tenantB);

    const a = como(tokenA);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Solo de A S.A.C.', taxId: '20512345688' })
      .expect(201);
    await a(http().post('/api/v1/org/locations'))
      .send({
        companyId: empresa.body.id,
        name: 'Local solo de A',
        address: 'Av. Solo 1',
        lat: -12.1,
        lng: -77.04,
      })
      .expect(201);

    const deA = await onboarding.checklist(tenantA);
    expect(deA.pasos.find((p) => p.id === 'estructura')!.hecho).toBe(true);

    // Se compara ANTES contra DESPUÉS en vez de afirmar «B está a cero»: B
    // tiene su propia estructura de las pruebas de práctica, y atar esta
    // comprobación a un cero convertiría el aislamiento en una prueba del
    // orden de ejecución.
    const deB = await onboarding.checklist(tenantB);
    expect(deB.hechos).toBe(antesDeB.hechos);
    expect(deB.pasos.map((p) => p.hecho)).toEqual(
      antesDeB.pasos.map((p) => p.hecho),
    );

    // Y por HTTP con el token de B, que es el camino real.
    const res = await como(tokenB)(
      http().get('/api/v1/onboarding/checklist'),
    ).expect(200);
    expect(res.body.hechos).toBe(antesDeB.hechos);
  });
});
