import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import {
  OrganizationService,
  type ScheduleView,
} from '../modules/organization/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Alta y edición de la estructura del negocio (spec 03, salda parte de DT-10).
 *
 * Esta suite existe porque el sistema **no tenía forma de crear una marca**.
 * La spec 03 pide CRUD de empresas, marcas, locales, cocinas, estaciones, zonas
 * y horarios; solo estaba la mitad de lectura, y las únicas escrituras eran las
 * semillas demo con SQL directo. Un cliente nuevo no podía configurarse.
 *
 * Lo que se comprueba es lo que decide si un negocio puede vender: que la
 * estructura creada por la API sea la MISMA que consultan la cobertura y el
 * pedido — no una tabla paralela que parece bien.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Alta de la estructura del negocio', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

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

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Alta Tenant A',
      planCode: 'growth',
      owner: {
        email: 'alta-a@sahana.test',
        password: 'password-alta-a-1',
        fullName: 'Dueña Alta A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Alta Tenant B',
      planCode: 'growth',
      owner: {
        email: 'alta-b@sahana.test',
        password: 'password-alta-b-1',
        fullName: 'Dueño Alta B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    tokenA = await entrar('alta-a@sahana.test', 'password-alta-a-1');
    tokenB = await entrar('alta-b@sahana.test', 'password-alta-b-1');
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

  const como = (token: string) => (r: request.Test) =>
    r.set('authorization', `Bearer ${token}`);
  const http = () => request(app.getHttpServer());

  /** El polígono de Miraflores que usan las demás suites. */
  const MIRAFLORES: Array<[number, number]> = [
    [-77.05, -12.15],
    [-77.0, -12.15],
    [-77.0, -12.1],
    [-77.05, -12.1],
    [-77.05, -12.15],
  ];

  it('UN NEGOCIO COMPLETO desde cero, por API', async () => {
    const a = como(tokenA);

    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({
        legalName: 'Inversiones El Buen Sabor S.A.C.',
        taxId: '20512345678',
        address: 'Av. Larco 100, Miraflores',
      })
      .expect(201);
    expect(empresa.body.taxId).toBe('20512345678');

    const marca = await a(http().post('/api/v1/org/brands'))
      .send({ companyId: empresa.body.id, name: 'Pollería El Buen Sabor' })
      .expect(201);
    // El identificador se deriva del nombre y pierde las tildes: es lo que
    // acaba en una URL.
    expect(marca.body.slug).toBe('polleria-el-buen-sabor');

    const local = await a(http().post('/api/v1/org/locations'))
      .send({
        companyId: empresa.body.id,
        name: 'Miraflores',
        address: 'Av. Larco 100',
        lat: -12.125,
        lng: -77.02,
      })
      .expect(201);

    const cocina = await a(http().post('/api/v1/org/kitchens'))
      .send({ locationId: local.body.id, name: 'Cocina principal' })
      .expect(201);

    await a(http().post('/api/v1/org/brand-kitchens'))
      .send({ brandId: marca.body.id, kitchenId: cocina.body.id })
      .expect(201);

    await a(http().post('/api/v1/org/stations'))
      .send({ kitchenId: cocina.body.id, name: 'Parrilla', sortOrder: 1 })
      .expect(201);

    const zona = await a(http().post('/api/v1/org/zones'))
      .send({
        locationId: local.body.id,
        name: 'Miraflores centro',
        polygon: MIRAFLORES,
        deliveryFeeMinor: 50_000, // S/ 5.0000
        minOrderMinor: 250_000, // S/ 25.0000
        baseMinutes: 35,
      })
      .expect(201);
    // Importe como cadena decimal, nunca coma flotante.
    expect(zona.body.deliveryFee).toBe('5.0000');

    await a(http().post('/api/v1/org/schedules'))
      .send({
        locationId: local.body.id,
        weekly: [
          { weekday: 1, opensAt: '11:00', closesAt: '23:00' },
          { weekday: 5, opensAt: '11:00', closesAt: '02:00' },
        ],
      })
      .expect(201);

    // LA COMPROBACIÓN QUE IMPORTA: lo creado es lo que el resto del sistema
    // consulta. Una tabla paralela que parece bien no sirve de nada — la
    // cobertura decide si un pedido entra.
    const org = app.get(OrganizationService);
    // El punto va como tupla [lng, lat] —el orden de GeoJSON—, no como objeto.
    const cobertura = await org.findCoverage(
      tenantA,
      [-77.02, -12.125],
      marca.body.id,
    );
    expect(cobertura?.zoneId).toBe(zona.body.id);
    expect(cobertura?.locationId).toBe(local.body.id);

    // Y la marca produce en esa cocina: sin la unión M:N, un pedido no
    // encuentra dónde cocinarse y `submit` lo rechaza.
    const cocinas = await org.kitchensForBrand(tenantA, marca.body.id);
    expect(cocinas.map((c) => c.locationId)).toContain(local.body.id);
  });

  it('EL RECTÁNGULO ENVOLVENTE lo calcula el servidor', async () => {
    // No se acepta del cliente ni aunque lo mande: un bbox que no encierra al
    // polígono hace que la cobertura mienta —direcciones dentro de la zona que
    // se rechazan— y el error es invisible hasta que alguien reclama.
    const a = como(tokenA);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Bbox S.A.C.', taxId: '20599999999' })
      .expect(201);
    const local = await a(http().post('/api/v1/org/locations'))
      .send({ companyId: empresa.body.id, name: 'Bbox', address: 'x' })
      .expect(201);

    await a(http().post('/api/v1/org/zones'))
      .send({
        locationId: local.body.id,
        name: 'Zona bbox',
        polygon: MIRAFLORES,
        // Un envolvente absurdo, por si alguien lo mandara: se ignora.
        minLng: 0,
        minLat: 0,
        maxLng: 1,
        maxLat: 1,
      })
      .expect(201);

    const caja = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        min_lng: number;
        max_lat: number;
      }>(
        `SELECT min_lng, max_lat FROM org_zones
          WHERE location_id = $1 AND name = 'Zona bbox'`,
        [local.body.id],
      );
      return rows[0]!;
    });
    expect(caja.min_lng).toBeCloseTo(-77.05, 5);
    expect(caja.max_lat).toBeCloseTo(-12.1, 5);
  });

  it('VOLVER A APLICAR la misma configuración no duplica nada', async () => {
    // Una configuración se aplica varias veces —se corrige un dato, se añade un
    // local, se relanza el alta—. Una segunda pasada que duplica la marca deja
    // un negocio con dos cartas y ningún modo de saber cuál cobra.
    const a = como(tokenA);
    const datos = { legalName: 'Repetida S.A.C.', taxId: '20577777777' };

    const uno = await a(http().post('/api/v1/org/companies'))
      .send(datos)
      .expect(201);
    const dos = await a(http().post('/api/v1/org/companies'))
      .send({ ...datos, address: 'Dirección nueva' })
      .expect(201);
    expect(dos.body.id).toBe(uno.body.id);
    expect(dos.body.address).toBe('Dirección nueva');

    const m1 = await a(http().post('/api/v1/org/brands'))
      .send({ companyId: uno.body.id, name: 'Marca Repetida' })
      .expect(201);
    const m2 = await a(http().post('/api/v1/org/brands'))
      .send({ companyId: uno.body.id, name: 'Marca Repetida' })
      .expect(201);
    expect(m2.body.id).toBe(m1.body.id);

    const cuantas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM org_brands WHERE slug = 'marca-repetida'`,
      );
      return Number(rows[0]!.n);
    });
    expect(cuantas).toBe(1);
  });

  it('un RUC que no lo es se rechaza al crear la empresa, no al facturar', async () => {
    // Un RUC mal escrito que solo se valide en el comprobante se descubre el
    // día que el OSE rechaza la primera boleta, con el cliente delante.
    const r = await como(tokenA)(http().post('/api/v1/org/companies'))
      .send({ legalName: 'RUC Corto S.A.C.', taxId: '12345' })
      .expect(422);
    expect(r.body.detail).toContain('11 dígitos');
  });

  it('un polígono degenerado se rechaza con un motivo legible', async () => {
    const a = como(tokenA);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Polígono S.A.C.', taxId: '20566666666' })
      .expect(201);
    const local = await a(http().post('/api/v1/org/locations'))
      .send({ companyId: empresa.body.id, name: 'Poli', address: 'x' })
      .expect(201);

    await a(http().post('/api/v1/org/zones'))
      .send({
        locationId: local.body.id,
        name: 'Zona rota',
        polygon: [
          [-77, -12],
          [-77, -12],
        ],
      })
      .expect(422);
  });

  // ------------------------------------------------------ AISLAMIENTO

  it('EL HORARIO SE PUEDE LEER, que era lo que faltaba para poder cambiarlo', async () => {
    // `POST /schedules` existía desde T3.12 y REEMPLAZA la semana entera. Sin
    // una lectura, cualquier pantalla que quisiera cambiar el jueves tendría que
    // reescribir los otros seis días de memoria — que es como se cierra un local
    // un sábado sin que nadie se entere hasta que llama un cliente.
    const a = como(tokenA);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Horarios S.A.C.', taxId: '20512345678' })
      .expect(201);
    const local = await a(http().post('/api/v1/org/locations'))
      .send({ companyId: empresa.body.id, name: 'Con horario', address: 'x' })
      .expect(201);

    await a(http().post('/api/v1/org/schedules'))
      .send({
        locationId: local.body.id,
        weekly: [
          { weekday: 1, opensAt: '11:00', closesAt: '23:00' },
          // Cruza la medianoche: es lo normal en una pollería, y tiene que
          // volver tal cual o el viernes se guardaría al revés.
          { weekday: 5, opensAt: '18:00', closesAt: '02:00' },
        ],
        exceptions: [{ date: '2026-07-28', ranges: [] }],
      })
      .expect(201);

    const leido = await a(
      http().get(`/api/v1/org/schedules?location=${local.body.id}`),
    ).expect(200);

    expect(leido.body).toHaveLength(1);
    const h = (leido.body as ScheduleView[])[0]!;
    expect(h.brandId).toBeNull();
    expect(h.channel).toBeNull();
    expect(h.weekly).toEqual([
      { weekday: 1, opensAt: '11:00', closesAt: '23:00' },
      { weekday: 5, opensAt: '18:00', closesAt: '02:00' },
    ]);
    // El feriado sin franjas es «cerrado todo el día», y tiene que sobrevivir
    // a la ida y vuelta: perderlo abriría el local un 28 de julio.
    expect(h.exceptions).toEqual([{ date: '2026-07-28', ranges: [] }]);

    // Y volver a guardar REEMPLAZA, no acumula: es lo que obliga a que la
    // pantalla mande siempre la semana completa.
    await a(http().post('/api/v1/org/schedules'))
      .send({
        locationId: local.body.id,
        weekly: [{ weekday: 1, opensAt: '12:00', closesAt: '22:00' }],
      })
      .expect(201);
    const trasGuardar = await a(
      http().get(`/api/v1/org/schedules?location=${local.body.id}`),
    ).expect(200);
    expect((trasGuardar.body as ScheduleView[])[0]!.weekly).toEqual([
      { weekday: 1, opensAt: '12:00', closesAt: '22:00' },
    ]);
  });

  it('AISLAMIENTO: B no puede leer el horario de un local de A', async () => {
    // El local va en la consulta. Sin filtro por tenant, B sabría a qué hora
    // abre y cierra el competidor con una sola petición.
    const a = como(tokenA);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Privado S.A.C.', taxId: '20587654321' })
      .expect(201);
    const local = await a(http().post('/api/v1/org/locations'))
      .send({ companyId: empresa.body.id, name: 'Privado', address: 'x' })
      .expect(201);
    await a(http().post('/api/v1/org/schedules'))
      .send({
        locationId: local.body.id,
        weekly: [{ weekday: 1, opensAt: '11:00', closesAt: '23:00' }],
      })
      .expect(201);

    // 404 y no lista vacía: el local no existe PARA B, y decir «existe pero no
    // tiene horario» ya sería contar algo.
    await como(tokenB)(
      http().get(`/api/v1/org/schedules?location=${local.body.id}`),
    ).expect(404);
  });

  it('AISLAMIENTO: el tenant B no puede colgar nada de la empresa de A', async () => {
    // La comprobación obligatoria de todo endpoint nuevo. El `companyId` va en
    // el cuerpo, así que si la consulta no filtrara por tenant, B crearía
    // marcas dentro de la empresa de A — y las vería en su propia tienda.
    const empresa = await como(tokenA)(http().post('/api/v1/org/companies'))
      .send({ legalName: 'Aislada S.A.C.', taxId: '20555555555' })
      .expect(201);

    await como(tokenB)(http().post('/api/v1/org/brands'))
      .send({ companyId: empresa.body.id, name: 'Marca Intrusa' })
      .expect(404);

    await como(tokenB)(http().post('/api/v1/org/locations'))
      .send({ companyId: empresa.body.id, name: 'Local Intruso', address: 'x' })
      .expect(404);

    const intrusas = await withTenant(pool, tenantB, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM org_brands WHERE name = 'Marca Intrusa'`,
      );
      return Number(rows[0]!.n);
    });
    expect(intrusas).toBe(0);
  });

  it('AISLAMIENTO: dos tenants pueden usar el MISMO slug de marca', async () => {
    // La unicidad del slug es POR TENANT. Si fuera global, el segundo cliente
    // que se llamara «El Buen Sabor» no podría darse de alta.
    const crear = async (token: string, tenantId: string): Promise<string> => {
      const empresa = await como(token)(http().post('/api/v1/org/companies'))
        .send({
          legalName: `Homónima ${tenantId.slice(0, 8)} S.A.C.`,
          taxId: `205${tenantId.replace(/\D/g, '').slice(0, 8)}`,
        })
        .expect(201);
      const marca = await como(token)(http().post('/api/v1/org/brands'))
        .send({ companyId: empresa.body.id, name: 'El Buen Sabor' })
        .expect(201);
      return marca.body.id as string;
    };

    const deA = await crear(tokenA, tenantA);
    const deB = await crear(tokenB, tenantB);
    expect(deA).not.toBe(deB);
  });

  it('sin permiso de escritura no se crea nada', async () => {
    // 403 y no 401: el guardia responde lo mismo a «no traes token» y a «tu
    // token no alcanza». Distinguirlos le diría a quien prueba si el endpoint
    // existe y qué permiso le falta.
    await http()
      .post('/api/v1/org/companies')
      .send({ legalName: 'Sin Token S.A.C.', taxId: '20544444444' })
      .expect(403);
  });
});
