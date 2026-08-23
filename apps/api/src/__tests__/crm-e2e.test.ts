import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { CrmService } from '../modules/crm/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Clientes (spec 14, la parte de F5).
 *
 * Las dos cosas que esta suite vigila y que no se ven mirando la pantalla:
 *
 *  · **Que el gasto no mienta.** Se suma solo lo entregado y con `Money`. Un
 *    cancelado sumado infla justo al cliente que más cancela, que es al que NO
 *    hay que mandarle una promoción.
 *  · **Que anonimizar sea anonimizar** (RN-CRM-02): que la PII desaparezca de
 *    verdad y que el pedido siga ahí con su importe, porque tiene cinco años de
 *    retención fiscal.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Clientes', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 6 });
  const created: string[] = [];
  let crm: CrmService;

  let tenantA = '';
  let tokenA = '';
  let tenantB = '';
  let tokenB = '';
  let marcaA = '';
  let localA = '';

  const TELEFONO = '+51987650001';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    crm = app.get(CrmService);

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'Clientes A',
      planCode: 'growth',
      owner: {
        email: 'clientes-a@sahana.test',
        password: 'password-clientes-a-1',
        fullName: 'Dueña Clientes A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'Clientes B',
      planCode: 'growth',
      owner: {
        email: 'clientes-b@sahana.test',
        password: 'password-clientes-b-1',
        fullName: 'Dueño Clientes B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    tokenA = await entrar('clientes-a@sahana.test', 'password-clientes-a-1');
    tokenB = await entrar('clientes-b@sahana.test', 'password-clientes-b-1');

    const estructura = await montarNegocio(tokenA, '20512345701', 'Clientela');
    marcaA = estructura.brandId;
    localA = estructura.locationId;

    // Tres pedidos del MISMO teléfono con nombres distintos, como llegan de
    // canales distintos. Y uno cancelado, que no debe contar como gasto.
    await pedido(tenantA, {
      numero: 1,
      nombre: 'Juan Perez',
      canal: 'web',
      total: '50.00',
      estado: 'delivered',
    });
    await pedido(tenantA, {
      numero: 2,
      nombre: 'juan',
      canal: 'whatsapp',
      total: '30.00',
      estado: 'delivered',
    });
    await pedido(tenantA, {
      numero: 3,
      nombre: 'Juan Pérez Q.',
      canal: 'rappi',
      total: '999.00',
      estado: 'cancelled',
    });
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

  async function montarNegocio(
    token: string,
    ruc: string,
    nombre: string,
  ): Promise<{ brandId: string; locationId: string }> {
    const a = como(token);
    const empresa = await a(http().post('/api/v1/org/companies'))
      .send({ legalName: `${nombre} S.A.C.`, taxId: ruc })
      .expect(201);
    const marca = await a(http().post('/api/v1/org/brands'))
      .send({ companyId: empresa.body.id, name: nombre })
      .expect(201);
    const local = await a(http().post('/api/v1/org/locations'))
      .send({
        companyId: empresa.body.id,
        name: `Local ${nombre}`,
        address: 'Av. Clientela 100',
        lat: -12.12,
        lng: -77.03,
      })
      .expect(201);
    return { brandId: marca.body.id, locationId: local.body.id };
  }

  /** Un pedido escrito directo: lo que se prueba es la lectura, no el alta. */
  async function pedido(
    tenant: string,
    p: {
      numero: number;
      nombre: string;
      canal: string;
      /**
       * Como CADENA decimal, igual que en la base: `total: number` es
       * exactamente lo que la regla de ESLint impide, y tiene razón también en
       * una prueba — es donde se cuela la costumbre.
       */
      total: string;
      estado: string;
      telefono?: string;
      marca?: string;
      local?: string;
    },
  ): Promise<void> {
    await withTenant(pool, tenant, async ({ client }) => {
      await client.query(
        `INSERT INTO ord_orders
           (tenant_id, brand_id, location_id, order_number, channel, status,
            customer_name, customer_phone, delivery_address,
            subtotal, discount_total, taxable_base, tax, total, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Av. Secreta 123',
                 $9, 0, $9, 0, $9, 'PEN')`,
        [
          tenant,
          p.marca ?? marcaA,
          p.local ?? localA,
          p.numero,
          p.canal,
          p.estado,
          p.nombre,
          p.telefono ?? TELEFONO,
          p.total,
        ],
      );
    });
  }

  it('UN CLIENTE, no tres: se unifica por teléfono', async () => {
    // El mismo señor es «Juan Perez» en la web, «juan» en WhatsApp y «Juan
    // Pérez Q.» en el marketplace. El nombre no sirve de clave; el teléfono sí.
    const lista = await crm.listar(tenantA, {});
    const juan = lista.filter((c) => c.phone === TELEFONO);
    expect(juan).toHaveLength(1);
    expect(juan[0]!.orders).toBe(3);
    expect(juan[0]!.channels).toEqual(['rappi', 'web', 'whatsapp']);
  });

  it('EL GASTO cuenta solo lo entregado', async () => {
    // Sumar el cancelado de S/ 999 pondría a este cliente el primero de la
    // lista, que es exactamente al revés de lo que interesa.
    const [juan] = await crm.listar(tenantA, { search: TELEFONO });
    expect(juan!.totalSpent).toBe('80.0000');
    // Y el promedio se calcula sobre los entregados, no sobre los tres.
    expect(juan!.averageTicket).toBe('40.0000');
  });

  it('el NOMBRE es el más reciente que él mismo escribió', async () => {
    const [juan] = await crm.listar(tenantA, { search: TELEFONO });
    expect(juan!.name).toBe('Juan Pérez Q.');
  });

  it('LA FICHA trae el historial, del último al primero', async () => {
    const ficha = await crm.ficha(tenantA, TELEFONO);
    expect(ficha.historial).toHaveLength(3);
    const numeros = ficha.historial.map((p) => p.orderNumber);
    expect(numeros).toEqual([...numeros].sort((a, b) => b - a));
  });

  it('un teléfono PARCIAL no abre la ficha de otro', async () => {
    // La búsqueda es por «contiene»; enseñar la ficha del primero que casa
    // mezclaría dos personas en una pantalla con su historial de compras.
    await expect(crm.ficha(tenantA, '+5198765')).rejects.toThrow();
  });

  it('por HTTP se lista y se abre la ficha', async () => {
    const lista = await como(tokenA)(
      http().get('/api/v1/crm/customers'),
    ).expect(200);
    expect(lista.body.length).toBeGreaterThan(0);

    const ficha = await como(tokenA)(
      http().get(`/api/v1/crm/customers/${encodeURIComponent(TELEFONO)}`),
    ).expect(200);
    expect(ficha.body.phone).toBe(TELEFONO);
  });

  // ------------------------------------------- RN-CRM-02: anonimización

  it('ANONIMIZAR borra la PII y CONSERVA el registro comercial', async () => {
    // La regla entera: un pedido tiene cinco años de retención fiscal, así que
    // borrarlo para atender una solicitud de datos personales cambiaría un
    // problema legal por otro peor.
    const otro = '+51987650009';
    await pedido(tenantA, {
      numero: 90,
      nombre: 'Rosa Anónima',
      canal: 'web',
      total: '120.00',
      estado: 'delivered',
      telefono: otro,
    });

    const res = await como(tokenA)(
      http().post(
        `/api/v1/crm/customers/${encodeURIComponent(otro)}/anonymize`,
      ),
    )
      .send({ reason: 'El cliente pidió la baja de sus datos' })
      .expect(201);
    expect(res.body.pedidos).toBe(1);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        customer_name: string | null;
        customer_phone: string | null;
        delivery_address: string | null;
        total: string;
        status: string;
      }>(
        `SELECT customer_name, customer_phone, delivery_address, total::text, status
           FROM ord_orders WHERE order_number = 90`,
      );
      return rows[0]!;
    });

    // Lo que identifica, fuera.
    expect(fila.customer_name).toBeNull();
    expect(fila.delivery_address).toBeNull();
    expect(fila.customer_phone).not.toBe(otro);
    // Lo comercial, intacto: el cuadre con SUNAT sigue cuadrando.
    expect(Number(fila.total)).toBe(120);
    expect(fila.status).toBe('delivered');
  });

  it('EL HISTÓRICO guarda el motivo pero NO el teléfono', async () => {
    // Escribir el teléfono ahí sería dejar el dato personal en la única tabla
    // que no se puede borrar — es decir, no anonimizar nada.
    const filas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        reason: string | null;
        data: Record<string, unknown>;
      }>(
        `SELECT reason, data FROM audit_log
          WHERE action = 'crm.customer_anonymized'`,
      );
      return rows;
    });
    expect(filas).toHaveLength(1);
    expect(filas[0]!.reason).toContain('baja de sus datos');
    expect(JSON.stringify(filas[0]!.data)).not.toContain('987650009');
  });

  it('SIN MOTIVO no se anonimiza', async () => {
    await como(tokenA)(
      http().post(
        `/api/v1/crm/customers/${encodeURIComponent(TELEFONO)}/anonymize`,
      ),
    )
      .send({ reason: '' })
      .expect(422);
  });

  // ------------------------------------------------------ AISLAMIENTO

  it('AISLAMIENTO: B no ve los clientes de A ni los puede anonimizar', async () => {
    // La comprobación obligatoria, y aquí lo que se filtraría son teléfonos y
    // nombres de los clientes del competidor: la lista de contactos entera.
    const deB = await como(tokenB)(
      http().get(`/api/v1/crm/customers?q=${encodeURIComponent(TELEFONO)}`),
    ).expect(200);
    expect(deB.body).toHaveLength(0);

    await como(tokenB)(
      http().get(`/api/v1/crm/customers/${encodeURIComponent(TELEFONO)}`),
    ).expect(404);

    await como(tokenB)(
      http().post(
        `/api/v1/crm/customers/${encodeURIComponent(TELEFONO)}/anonymize`,
      ),
    )
      .send({ reason: 'A ver si borro los clientes del vecino' })
      .expect(404);

    // Y el cliente de A sigue con su nombre.
    const sigue = await crm.ficha(tenantA, TELEFONO);
    expect(sigue.name).toBe('Juan Pérez Q.');
  });

  it('sin token no se ve la lista de clientes', async () => {
    await http().get('/api/v1/crm/customers').expect(403);
  });
});
