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
import { OrderingService } from '../modules/ordering/index.js';
import { CashService } from '../modules/cash/index.js';
import { DeliveryService } from '../modules/delivery/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Delivery propio (spec 09, T5.15–T5.17).
 *
 * Lo que se prueba es lo que la spec marca y lo que cuesta dinero:
 *
 * · **Asignación con 3 repartidores y cargas distintas** (RN-DLV-01).
 * · **La liquidación cuadra con los cobros contra entrega** (RN-DLV-02) —el
 *   caso donde es fácil contar el mismo billete dos veces.
 * · **Entrega fallida → estado + motivo + reintento** (RN-DLV-03), sin que el
 *   pedido se cancele.
 * · **Tracking público sin autenticación y con datos mínimos**: el criterio de
 *   aceptación de la spec.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Delivery propio', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let ownerId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let delivery: DeliveryService;
  let cash: CashService;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    ordering = app.get(OrderingService);
    delivery = app.get(DeliveryService);
    cash = app.get(CashService);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Reparto Tenant',
      planCode: 'growth',
      owner: {
        email: 'dlv-a@sahana.test',
        password: 'password-dlv-a-1',
        fullName: 'Dueña Reparto',
      },
    });
    tenantA = a.tenantId;
    ownerId = a.ownerUserId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: org.brandIds[0]!,
        locationId: org.locationId,
      }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'dlv-a@sahana.test', password: 'password-dlv-a-1' })
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

  const vender = async (): Promise<string> => {
    const pedido = await ordering.submit(tenantA, {
      brandId: org.brandIds[0]!,
      locationId: org.locationId,
      channel: 'web',
      lines: [
        {
          productId: cat.polloId,
          quantity: 1,
          modifierOptionIds: [cat.optionGrandeId],
        },
      ],
    });
    return pedido.id;
  };

  const nuevoRepartidor = async (
    fullName: string,
    zoneIds?: string[],
  ): Promise<string> => {
    const { id } = await delivery.createCourier(tenantA, {
      locationId: org.locationId,
      fullName,
      ...(zoneIds ? { zoneIds } : {}),
    });
    await delivery.setCourierStatus(tenantA, id, 'available');
    return id;
  };

  // ------------------------------------------------------------- Asignación

  it('LA PRUEBA DE LA SPEC: 3 repartidores con cargas distintas', async () => {
    const luis = await nuevoRepartidor('Luis Quispe');
    const rosa = await nuevoRepartidor('Rosa Mamani');
    const ivan = await nuevoRepartidor('Iván Ríos');

    // Se le carga trabajo a Luis (2) e Iván (1); Rosa queda libre.
    for (const courierId of [luis, luis, ivan]) {
      const envio = await delivery.createShipment(tenantA, {
        orderId: await vender(),
      });
      await delivery.assign(tenantA, envio.id, courierId);
    }

    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
    });
    const ranking = await auth(
      http().get(`/api/v1/delivery/shipments/${envio.id}/suggestions`),
    ).expect(200);

    expect(ranking.body[0].courierId).toBe(rosa);
    expect(ranking.body.map((r: { name: string }) => r.name)).toEqual([
      'Rosa',
      'Iván',
      'Luis',
    ]);
    // El motivo va escrito: una recomendación sin explicación no se sigue.
    expect(ranking.body[0].reason).toContain('sin envíos activos');
    expect(ranking.body[2].reason).toContain('2 envíos en curso');
  });

  it('un pedido no puede tener dos envíos vivos', async () => {
    // Dos envíos activos del mismo pedido son dos motos yendo a la misma puerta.
    const orderId = await vender();
    await delivery.createShipment(tenantA, { orderId });
    await expect(delivery.createShipment(tenantA, { orderId })).rejects.toThrow(
      /ya tiene un envío/i,
    );
  });

  // ---------------------------------------------------------------- Estados

  it('el camino feliz: asignar, recoger, entregar', async () => {
    const courierId = await nuevoRepartidor('Ana Torres');
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
    });

    await auth(http().post(`/api/v1/delivery/shipments/${envio.id}/assign`))
      .send({ courierId })
      .expect(201);
    await auth(
      http().post(`/api/v1/delivery/shipments/${envio.id}/pickup`),
    ).expect(201);
    const entregado = await auth(
      http().post(`/api/v1/delivery/shipments/${envio.id}/deliver`),
    )
      .send({ evidence: { recibidoPor: 'La vecina' } })
      .expect(201);

    expect(entregado.body.status).toBe('delivered');
    expect(entregado.body.courierName).toBe('Ana Torres');
  });

  it('NO SE PUEDE ENTREGAR SIN HABER RECOGIDO', async () => {
    // Con cobro contra entrega, saltarse el paso da por cobrado un pedido que
    // sigue en el mostrador.
    const courierId = await nuevoRepartidor('Beto Salas');
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
    });
    await delivery.assign(tenantA, envio.id, courierId);

    const r = await auth(
      http().post(`/api/v1/delivery/shipments/${envio.id}/deliver`),
    )
      .send({})
      .expect(409);
    expect(r.body.code).toBe('SHIPMENT_INVALID_TRANSITION');
  });

  it('FALLIDA → motivo + reintento, y el envío suelta al repartidor', async () => {
    const primero = await nuevoRepartidor('Caro Vega');
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
    });
    await delivery.assign(tenantA, envio.id, primero);
    await delivery.pickUp(tenantA, envio.id);

    // Sin motivo no se puede fallar: la bandeja de fallos sería una lista de
    // pedidos rotos sin nada que hacer con ellos.
    await auth(http().post(`/api/v1/delivery/shipments/${envio.id}/fail`))
      .send({})
      .expect(422);

    const fallido = await auth(
      http().post(`/api/v1/delivery/shipments/${envio.id}/fail`),
    )
      .send({ reason: 'El cliente no estaba en casa' })
      .expect(201);
    expect(fallido.body.status).toBe('failed');
    expect(fallido.body.failReason).toBe('El cliente no estaba en casa');
    expect(fallido.body.attempts).toBe(1);

    const reintentado = await auth(
      http().post(`/api/v1/delivery/shipments/${envio.id}/retry`),
    ).expect(201);
    // Vuelve a la cola DE VERDAD: sin repartidor. Si quedara pegado a quien ya
    // falló, el reintento sería el mismo intento otra vez.
    expect(reintentado.body.status).toBe('pending');
    expect(reintentado.body.courierId).toBeNull();

    // Y el PEDIDO sigue vivo: un reparto fallido no cancela una venta.
    const pedido = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT o.status FROM ord_orders o JOIN dlv_shipments s ON s.order_id = o.id WHERE s.id = $1',
        [envio.id],
      );
      return rows[0]!;
    });
    expect([
      'received',
      'accepted',
      'preparing',
      'ready',
      'packed',
      'dispatched',
    ]).toContain(pedido.status);
  });

  it('reparto de marketplace: solo se registra el handoff (RN-DLV-04)', async () => {
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
      externalCourier: 'Rappi',
    });
    // Nace asignado: no hay nada que asignar, solo quién se lo llevó.
    expect(envio.status).toBe('assigned');
    expect(envio.externalCourier).toBe('Rappi');
    expect(envio.courierId).toBeNull();
  });

  // -------------------------------------------------- Cobro contra entrega

  it('LA LIQUIDACIÓN CUADRA con los cobros contra entrega (RN-DLV-02)', async () => {
    const courierId = await nuevoRepartidor('Dani Flores');

    // Tres entregas contra reembolso: 30, 20 y 50 soles.
    const importes = [300_000, 200_000, 500_000];
    for (const cod of importes) {
      const envio = await delivery.createShipment(tenantA, {
        orderId: await vender(),
        codAmountMinor: cod,
      });
      await delivery.assign(tenantA, envio.id, courierId);
      await delivery.pickUp(tenantA, envio.id);
      await delivery.deliver(tenantA, envio.id, { codCollected: true });
    }

    // Una cuarta entregada SIN cobrar: no debe entrar en la liquidación.
    const sinCobrar = await delivery.createShipment(tenantA, {
      orderId: await vender(),
      codAmountMinor: 999_000,
    });
    await delivery.assign(tenantA, sinCobrar.id, courierId);
    await delivery.pickUp(tenantA, sinCobrar.id);
    await delivery.deliver(tenantA, sinCobrar.id, { codCollected: false });

    const saldos = await auth(
      http().get('/api/v1/delivery/couriers/balances'),
    ).expect(200);
    const suyo = saldos.body.find(
      (b: { courierId: string }) => b.courierId === courierId,
    );
    expect(suyo.pendingShipments).toBe(3);
    expect(suyo.pendingAmount).toBe('100.0000');

    // Se abre caja y se liquida contra ella.
    const sesion = await cash.open(tenantA, {
      locationId: org.locationId,
      openedBy: ownerId,
      openingFloatMinor: 0,
    });

    const liquidacion = await auth(
      http().post(`/api/v1/delivery/couriers/${courierId}/settle`),
    )
      .send({ sessionId: sesion.id })
      .expect(201);
    expect(liquidacion.body.shipments).toBe(3);
    expect(liquidacion.body.amount).toBe('100.0000');

    // El efectivo aparece en la caja, y como `cash_in`: la VENTA ya se contó al
    // facturar el pedido. Contarla otra vez aquí duplicaría los ingresos del
    // día, que es el error clásico del cobro contra entrega.
    const resumen = await cash.summary(tenantA, sesion.id);
    expect(resumen.byKind.cash_in.minorUnits).toBe(1_000_000);
    expect(resumen.byKind.sale.minorUnits).toBe(0);

    // Liquidar dos veces no duplica: ya no queda nada pendiente.
    const otraVez = await auth(
      http().post(`/api/v1/delivery/couriers/${courierId}/settle`),
    )
      .send({ sessionId: sesion.id })
      .expect(201);
    expect(otraVez.body.shipments).toBe(0);
    expect(otraVez.body.amount).toBe('0.0000');

    const despues = await cash.summary(tenantA, sesion.id);
    expect(despues.byKind.cash_in.minorUnits).toBe(1_000_000);
  });

  // --------------------------------------------------- Tracking público

  it('EL TRACKING PÚBLICO no pide sesión y enseña lo MÍNIMO', async () => {
    const courierId = await nuevoRepartidor('Elena Paredes');
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
      codAmountMinor: 450_000,
    });
    await delivery.assign(tenantA, envio.id, courierId);
    await delivery.pickUp(tenantA, envio.id);

    const enlace = await auth(
      http().post(`/api/v1/delivery/shipments/${envio.id}/tracking-link`),
    ).expect(201);

    // SIN cabecera de autorización: quien compra no tiene cuenta.
    const seguimiento = await http()
      .get(`/api/v1/tracking/${enlace.body.token}`)
      .expect(200);

    expect(seguimiento.body.status).toBe('picked_up');
    // Nombre de PILA y nada más.
    expect(seguimiento.body.courierFirstName).toBe('Elena');
    expect(seguimiento.body.brandName).toBeTruthy();

    // Este enlace se reenvía por WhatsApp y acaba en capturas de pantalla: cada
    // campo de más es un dato personal publicado para siempre.
    const cuerpo = JSON.stringify(seguimiento.body);
    expect(cuerpo).not.toContain('Paredes');
    expect(cuerpo).not.toContain(envio.id);
    expect(cuerpo).not.toContain(tenantA);
    expect(cuerpo).not.toContain('45');
    expect(seguimiento.body.courierPhone).toBeUndefined();
    expect(seguimiento.body.address).toBeUndefined();
  });

  it('el nombre del repartidor solo se enseña mientras va en camino', async () => {
    const courierId = await nuevoRepartidor('Fabio Luna');
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
    });
    const enlace = await delivery.issueTrackingLink(tenantA, envio.id);

    // Antes de asignar no hay a quién nombrar.
    const antes = await http()
      .get(`/api/v1/tracking/${enlace.token}`)
      .expect(200);
    expect(antes.body.courierFirstName).toBeNull();

    await delivery.assign(tenantA, envio.id, courierId);
    await delivery.pickUp(tenantA, envio.id);
    await delivery.deliver(tenantA, envio.id);

    // Después de entregar ya no hace falta.
    const despues = await http()
      .get(`/api/v1/tracking/${enlace.token}`)
      .expect(200);
    expect(despues.body.status).toBe('delivered');
    expect(despues.body.courierFirstName).toBeNull();
  });

  it('un token de seguimiento inventado no abre nada', async () => {
    await http().get('/api/v1/tracking/token-que-no-existe').expect(404);
  });

  it('un token de PAGO no sirve para seguimiento', async () => {
    // Un token filtrado en un sitio no puede abrir todos los demás: el
    // propósito se comprueba al resolver (ADR-0017).
    const envio = await delivery.createShipment(tenantA, {
      orderId: await vender(),
    });
    const enlace = await delivery.issueTrackingLink(tenantA, envio.id);
    await http().get(`/api/v1/payments/links/${enlace.token}`).expect(404);
  });
});
