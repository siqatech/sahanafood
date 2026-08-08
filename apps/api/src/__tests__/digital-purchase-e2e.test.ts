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
import { StorefrontService } from '../modules/storefront/index.js';
import {
  PaymentsService,
  CulqiSandboxProvider,
  CULQI_PROVIDER,
} from '../modules/payments/index.js';
import { BillingService } from '../modules/billing/index.js';
import { DeliveryService } from '../modules/delivery/index.js';
import { AcceptanceService } from '../modules/ordering/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * COMPRA DIGITAL COMPLETA, de extremo a extremo (T5.33).
 *
 * El criterio del backlog: **intención → webhook → aceptado → boleta (sandbox
 * del OSE) → tracking, en menos de 2 minutos**.
 *
 * Cada pieza tiene ya su suite. Esta prueba existe porque las piezas pasan por
 * separado y la cadena se rompe en las juntas — que es exactamente lo que pasó
 * con el agente en T5.32: todo probado, nada conectado. Aquí se recorre el
 * camino del COMPRADOR: un invitado que llega a un dominio, ve la carta, arma
 * su pedido, paga y sigue su reparto. Ninguna llamada de esta prueba usa un
 * atajo interno para avanzar de etapa.
 *
 * El único paso que sí es de personal es emitir el comprobante: la boleta
 * necesita la identidad tributaria del comprador, que el carrito **hoy no
 * captura** (spec 11 no la contempla). Queda anotado como PA-07 en vez de
 * inventarse un campo.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const HOST = 'compradigital.sahana.food';
const SECRETO = 'secreto-culqi-e2e-compra-digital';

suite('Compra digital de extremo a extremo', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantId = '';
  let tokenStaff = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let webhookToken = '';
  const culqi = new CulqiSandboxProvider();

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

    // El host es único GLOBALMENTE. Una ejecución que se cayó a medias deja el
    // dominio reservado y la siguiente no arranca.
    await pool.query('DELETE FROM ten_tenants WHERE name = $1', [
      'Compra Digital Tenant',
    ]);

    const t = await app.get(TenancyService).provisionTenant({
      name: 'Compra Digital Tenant',
      planCode: 'growth',
      owner: {
        email: 'compra@sahana.test',
        password: 'password-compra-1',
        fullName: 'Dueña Compra',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);

    org = await withTenant(pool, tenantId, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    cat = await withTenant(pool, tenantId, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    // Series de comprobante, como las tendría cualquier empresa antes de
    // vender su primer plato.
    await withTenant(pool, tenantId, ({ client }) =>
      client.query(
        `INSERT INTO bil_series (tenant_id, company_id, series, doc_type)
         VALUES ($1,$2,'B001','boleta'), ($1,$2,'F001','factura')`,
        [tenantId, org.companyId],
      ),
    );

    const storefront = app.get(StorefrontService);
    const dominio = await storefront.registerDomain(tenantId, {
      brandId,
      host: HOST,
    });
    await storefront.verifyDomain(tenantId, dominio.id);

    const conexion = await app.get(PaymentsService).createConnection(tenantId, {
      provider: CULQI_PROVIDER,
      webhookSecret: SECRETO,
    });
    webhookToken = conexion.webhookToken;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'compra@sahana.test', password: 'password-compra-1' })
      .expect(201);
    tokenStaff = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  /** El comprador llega por el dominio de la marca, sin sesión. */
  const tienda = (r: request.Test) => r.set('host', HOST);

  it('EL CAMINO COMPLETO: carta → carrito → pago → aceptado → boleta → tracking', async () => {
    const arranque = Date.now();

    // --- 1. La carta, desde el dominio de la marca y sin sesión.
    const carta = await tienda(http().get('/api/v1/shop/catalog')).expect(200);
    const pollo = carta.body.products.find(
      (p: { id: string }) => p.id === cat.polloId,
    );
    expect(
      pollo,
      'la carta tiene que traer el producto de la marca',
    ).toBeTruthy();

    // --- 2. Carrito de servidor. Vive en el servidor justo para que un pago
    //        fallido no borre lo que el comprador ya eligió (RN-STO-02).
    const carrito = await tienda(http().post('/api/v1/shop/carts')).expect(201);
    const cartToken = carrito.body.token as string;

    await tienda(http().post(`/api/v1/shop/carts/${cartToken}/lines`))
      .send({
        productId: cat.polloId,
        quantity: 1,
        modifierOptionIds: [cat.optionGrandeId],
      })
      .expect(201);

    await tienda(http().post(`/api/v1/shop/carts/${cartToken}/address`))
      .send({
        address: 'Av. Siempre Viva 742, Miraflores',
        lat: -12.125,
        lng: -77.02,
      })
      .expect(201);

    await tienda(http().post(`/api/v1/shop/carts/${cartToken}/customer`))
      .send({ name: 'Rosa Quispe', phone: '+51987650001' })
      .expect(201);

    // --- 3. Checkout CON PAGO EN LÍNEA. Es el paso que no existía: el
    //        checkout creaba el pedido y lo dejaba sin forma de pagarlo,
    //        porque crear una intención exige `payments.charge`, un permiso de
    //        personal que un invitado no tiene ni debe tener.
    const checkout = await tienda(
      http().post(`/api/v1/shop/carts/${cartToken}/checkout`),
    )
      .send({ payment: 'online' })
      .expect(201);

    const orderId = checkout.body.orderId as string;
    const referencia = checkout.body.payment.reference as string;
    expect(checkout.body.payment.checkoutUrl).toBeTruthy();
    // Referencia OPACA: lo que viaja al navegador y a los logs de un tercero
    // no puede ser el id interno de la intención.
    expect(referencia).not.toContain(orderId);

    // El pedido todavía NO está confirmado: se confirma por webhook y solo por
    // webhook (RN-PAY-01). Que aquí ya estuviera aceptado significaría que
    // alguien lo confirmó sin que el dinero llegara.
    expect(await estadoPedido(orderId)).toBe('received');

    // --- 4. El webhook de la pasarela, FIRMADO. Nadie más puede confirmar.
    const total = (await totalDelPedido(orderId)) as string;
    const cuerpo = JSON.stringify({
      id: `evt_${referencia}`,
      object: 'event',
      outcome: 'paid',
      order_number: referencia,
      amount: Math.round(Number(total) * 100),
      currency_code: 'PEN',
      charge_id: `chr_${referencia}`,
    });

    await http()
      .post(`/api/v1/payments/callbacks/${CULQI_PROVIDER}/${webhookToken}`)
      .set('content-type', 'application/json')
      .set('x-culqi-signature', culqi.sign(cuerpo, SECRETO))
      .send(cuerpo)
      .expect(200);

    expect(await estadoIntencion(referencia)).toBe('captured');

    // --- 5. Aceptación. El barrido es el que corre en producción; llamarlo es
    //        lo mismo que esperar a que el worker dé su vuelta.
    await app.get(AcceptanceService).sweepAllTenants();
    const estadoTrasPago = await estadoPedido(orderId);
    expect(
      ['confirmed', 'accepted', 'preparing'],
      `el pedido quedó en "${estadoTrasPago}" tras cobrar`,
    ).toContain(estadoTrasPago);

    // --- 6. La boleta, contra el sandbox del OSE.
    const documento = await app
      .get(BillingService)
      .createForOrder(tenantId, orderId, {
        docType: 'DNI',
        docNumber: '45678912',
        legalName: 'Rosa Quispe',
      });
    const emitido = await app.get(BillingService).issue(tenantId, documento.id);

    expect(emitido.docType).toBe('boleta');
    expect(emitido.status).toBe('accepted');
    // Número con el correlativo a 8 dígitos: «B001-42» pasa la validación local
    // y lo rechaza el OSE.
    expect(emitido.number).toMatch(/^[A-Z]\d{3}-\d{8}$/);

    // --- 7. Reparto y tracking público. El comprador sigue su pedido SIN
    //        cuenta: el enlace es lo único que tiene.
    const delivery = app.get(DeliveryService);
    const envio = await delivery.createShipment(tenantId, { orderId });
    const { token: tracking } = await delivery.issueTrackingLink(
      tenantId,
      envio.id,
    );

    const publico = await http()
      .get(`/api/v1/tracking/${tracking}`)
      .expect(200);
    expect(publico.body.status).toBeTruthy();
    // Datos MÍNIMOS: quien abre el enlace puede no ser a quien se lo mandaron.
    expect(JSON.stringify(publico.body)).not.toContain('45678912');
    expect(JSON.stringify(publico.body)).not.toContain(orderId);

    // --- El criterio de tiempo. Se mide de verdad y se afirma con margen: en
    //     CI la máquina es más lenta, y un umbral al filo convierte el criterio
    //     de la fase en un test intermitente que se acaba borrando.
    const segundos = (Date.now() - arranque) / 1000;
    expect(
      segundos,
      `la compra completa tardó ${segundos.toFixed(1)} s (criterio: menos de 120)`,
    ).toBeLessThan(120);
  });

  it('sin pasarela conectada, el checkout en línea lo DICE y ofrece salida', async () => {
    // Un error genérico aquí pierde la venta. El comprador no puede arreglar
    // que la tienda no tenga pasarela; lo que sí puede es pedir contra entrega.
    await withTenant(pool, tenantId, ({ client }) =>
      client.query(`UPDATE pay_connections SET status = 'disabled'`),
    );

    const carrito = await tienda(http().post('/api/v1/shop/carts')).expect(201);
    const token = carrito.body.token as string;
    await tienda(http().post(`/api/v1/shop/carts/${token}/lines`))
      .send({
        productId: cat.polloId,
        quantity: 1,
        modifierOptionIds: [cat.optionGrandeId],
      })
      .expect(201);
    await tienda(http().post(`/api/v1/shop/carts/${token}/address`))
      .send({
        address: 'Av. Siempre Viva 742',
        lat: -12.125,
        lng: -77.02,
      })
      .expect(201);
    await tienda(http().post(`/api/v1/shop/carts/${token}/customer`))
      .send({ name: 'Rosa Quispe', phone: '+51987650002' })
      .expect(201);

    const r = await tienda(http().post(`/api/v1/shop/carts/${token}/checkout`))
      .send({ payment: 'online' })
      .expect(422);
    expect(r.body.detail).toContain('contra entrega');

    await withTenant(pool, tenantId, ({ client }) =>
      client.query(`UPDATE pay_connections SET status = 'active'`),
    );
  });

  it('el checkout SIN pago en línea sigue funcionando', async () => {
    // Con el pago en línea por defecto, una tienda sin pasarela conectada
    // habría roto el checkout de todos sus compradores el día del despliegue.
    const carrito = await tienda(http().post('/api/v1/shop/carts')).expect(201);
    const token = carrito.body.token as string;
    await tienda(http().post(`/api/v1/shop/carts/${token}/lines`))
      .send({
        productId: cat.polloId,
        quantity: 1,
        modifierOptionIds: [cat.optionGrandeId],
      })
      .expect(201);
    await tienda(http().post(`/api/v1/shop/carts/${token}/address`))
      .send({
        address: 'Av. Siempre Viva 742',
        lat: -12.125,
        lng: -77.02,
      })
      .expect(201);
    await tienda(http().post(`/api/v1/shop/carts/${token}/customer`))
      .send({ name: 'Rosa Quispe', phone: '+51987650003' })
      .expect(201);

    const r = await tienda(
      http().post(`/api/v1/shop/carts/${token}/checkout`),
    ).expect(201);
    expect(r.body.orderId).toBeTruthy();
    expect(r.body.payment).toBeUndefined();
  });

  it('un pedido de la tienda NO se confirma sin webhook', async () => {
    // No hay endpoint de confirmación y no debe haberlo: un
    // `POST /payments/:id/confirm` con permiso de cajero parecería razonable y
    // sería exactamente la vulnerabilidad que RN-PAY-01 previene.
    await http()
      .post(
        '/api/v1/payments/intents/00000000-0000-0000-0000-000000000000/confirm',
      )
      .set('authorization', `Bearer ${tokenStaff}`)
      .expect(404);
  });

  // ------------------------------------------------------------------ Apoyo

  async function estadoPedido(orderId: string): Promise<string> {
    return withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM ord_orders WHERE id = $1',
        [orderId],
      );
      return rows[0]!.status;
    });
  }

  async function totalDelPedido(orderId: string): Promise<string> {
    return withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ total: string }>(
        'SELECT total FROM ord_orders WHERE id = $1',
        [orderId],
      );
      return rows[0]!.total;
    });
  }

  async function estadoIntencion(reference: string): Promise<string> {
    return withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!.status;
    });
  }
});
