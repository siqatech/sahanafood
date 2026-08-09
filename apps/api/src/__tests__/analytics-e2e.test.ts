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
import { BillingService } from '../modules/billing/index.js';
import {
  AnalyticsService,
  AnalyticsEventHandlers,
  ANALYTICS_CONSUMER,
} from '../modules/analytics/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Analítica: rentabilidad por marca y canal (spec 16, T4.29).
 *
 * La prueba que manda es la de CONCILIACIÓN. La spec lo dice sin matices: todo
 * número monetario del panel debe cuadrar con Billing, y una divergencia es un
 * **bug crítico**. Un panel que dice S/ 12 000 y una declaración que dice
 * S/ 11 400 no es un problema de redondeo: es que alguien va a tomar una
 * decisión con un número inventado.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Analítica — rentabilidad y conciliación', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 20 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let marcaDosId = '';
  let companyId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let catDos: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let analytics: AnalyticsService;
  let billing: BillingService;
  let handlers: Record<string, unknown>;

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
    analytics = app.get(AnalyticsService);
    billing = app.get(BillingService);
    handlers = app.get(AnalyticsEventHandlers).handlers() as Record<
      string,
      unknown
    >;

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Analítica Tenant',
      planCode: 'growth',
      owner: {
        email: 'ana-a@sahana.test',
        password: 'password-ana-a-1',
        fullName: 'Dueño Analítica',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    marcaDosId = org.brandIds[1]!;
    companyId = org.companyId;
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );
    // La segunda marca necesita su propio catálogo: es lo que hace que la
    // prueba de rentabilidad POR MARCA no sea una comparación consigo misma.
    catDos = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId: marcaDosId, locationId: org.locationId }),
    );

    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `INSERT INTO bil_series (tenant_id, company_id, series, doc_type)
         VALUES ($1,$2,'B001','boleta')`,
        [tenantA, companyId],
      ),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ana-a@sahana.test', password: 'password-ana-a-1' })
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

  const vender = async (
    canal = 'pos',
    marca = brandId,
  ): Promise<{ id: string; totalMinor: number }> => {
    // Cada marca tiene SU catálogo: un producto de la marca A no se vende bajo
    // la marca B, que es justamente lo que separa dos marcas en la misma
    // cocina.
    const catalogo = marca === brandId ? cat : catDos;
    const pedido = await ordering.submit(tenantA, {
      brandId: marca,
      locationId: org.locationId,
      channel: canal,
      lines: [
        {
          productId: catalogo.polloId,
          quantity: 1,
          modifierOptionIds: [catalogo.optionGrandeId],
        },
      ],
    });
    await ordering.applyTransition(tenantA, pedido.id, 'accept', {
      actorType: 'system',
    });
    return { id: pedido.id, totalMinor: pedido.total.minorUnits };
  };

  /** Drena el outbox por el camino real hacia el consumidor de analítica. */
  const drenar = async (): Promise<void> => {
    for (let vuelta = 0; vuelta < 6; vuelta++) {
      const entregados: Array<Record<string, unknown>> = [];
      await relayOnce(
        pool,
        async (evento) => {
          entregados.push({
            eventId: evento.id,
            tenantId: evento.tenantId,
            aggregateId: evento.aggregateId,
            eventType: evento.eventType,
            payload: evento.payload,
            traceId: evento.traceId,
          });
        },
        200,
      );
      if (entregados.length === 0) break;
      for (const mensaje of entregados) {
        await consumeEvent(
          { pool, consumer: ANALYTICS_CONSUMER, handlers: handlers as never },
          mensaje as never,
        );
      }
    }
  };

  const hoy = () => new Date();

  // -------------------------------------------------------------------------

  it('la proyección se alimenta por EVENTOS, no consultando pedidos', async () => {
    // Un `GROUP BY` sobre `ord_orders` a las 20:30 de un viernes compite por
    // las mismas filas que están cerrando pedidos.
    const antes = await analytics.profitability(tenantA, {
      from: new Date(Date.now() - 86_400_000),
      to: hoy(),
    });
    const pedidosAntes = antes.reduce((acc, f) => acc + f.orders, 0);

    await vender();
    // Sin drenar el outbox, la proyección NO se mueve: es la prueba de que no
    // lee las tablas transaccionales.
    const sinDrenar = await analytics.profitability(tenantA, {
      from: new Date(Date.now() - 86_400_000),
      to: hoy(),
    });
    expect(sinDrenar.reduce((acc, f) => acc + f.orders, 0)).toBe(pedidosAntes);

    await drenar();
    const despues = await analytics.profitability(tenantA, {
      from: new Date(Date.now() - 86_400_000),
      to: hoy(),
    });
    expect(despues.reduce((acc, f) => acc + f.orders, 0)).toBe(
      pedidosAntes + 1,
    );
  });

  it('separa por marca Y por canal: la pregunta de una dark kitchen', async () => {
    // Cuatro marcas en la misma cocina, y saber cuál gana dinero por cuál canal.
    await vender('pos', brandId);
    await vender('web', brandId);
    await vender('pos', marcaDosId);
    await drenar();

    const filas = await analytics.profitability(tenantA, {
      from: new Date(Date.now() - 86_400_000),
      to: hoy(),
    });

    const combinaciones = filas.map((f) => `${f.brandId}|${f.channel}`);
    expect(new Set(combinaciones).size).toBe(combinaciones.length);
    expect(
      filas.some((f) => f.brandId === brandId && f.channel === 'web'),
    ).toBe(true);
    expect(
      filas.some((f) => f.brandId === marcaDosId && f.channel === 'pos'),
    ).toBe(true);
  });

  it('reprocesar un evento NO duplica la venta', async () => {
    // Un panel que dice que se vendió el doble es peor que uno vacío: el vacío
    // se nota.
    const pedido = await vender();
    await drenar();

    const antes = await analytics.profitability(tenantA, {
      from: new Date(Date.now() - 86_400_000),
      to: hoy(),
    });
    const totalAntes = antes.reduce((acc, f) => acc + f.orders, 0);

    // Se fuerza el reproceso saltándose el `inbox`, como haría un reproceso
    // manual o un consumidor añadido mañana.
    await withTenant(pool, tenantA, (ctx) =>
      analytics.recordSale(ctx, pedido.id),
    );

    const despues = await analytics.profitability(tenantA, {
      from: new Date(Date.now() - 86_400_000),
      to: hoy(),
    });
    expect(despues.reduce((acc, f) => acc + f.orders, 0)).toBe(totalAntes);
  });

  it('las cancelaciones se cuentan APARTE y no ensucian el ticket promedio', async () => {
    // Dividir ingresos entre pedidos incluyendo cancelados da un ticket más
    // bajo que el real y lleva a decisiones equivocadas sobre precios.
    const pedido = await vender('pos', marcaDosId);
    await drenar();

    const antes = (
      await analytics.profitability(tenantA, {
        from: new Date(Date.now() - 86_400_000),
        to: hoy(),
        brandId: marcaDosId,
      })
    )[0]!;

    await ordering.applyTransition(tenantA, pedido.id, 'cancel', {
      actorType: 'user',
      reason: 'El cliente se arrepintió',
    });
    await drenar();

    const despues = (
      await analytics.profitability(tenantA, {
        from: new Date(Date.now() - 86_400_000),
        to: hoy(),
        brandId: marcaDosId,
      })
    )[0]!;

    expect(despues.cancelled).toBe(antes.cancelled + 1);
    // El ticket promedio no se mueve por la cancelación.
    expect(despues.averageTicket).toBe(antes.averageTicket);
  });

  it('el margen se CALCULA de los sumandos: neto − comisión − food cost', async () => {
    // Guardarlo calculado obliga a recalcular la fila cada vez que llega un
    // costo tardío, y abre la puerta a que el total y sus partes discrepen.
    await vender('web', marcaDosId);
    await drenar();

    const fila = (
      await analytics.profitability(tenantA, {
        from: new Date(Date.now() - 86_400_000),
        to: hoy(),
        brandId: marcaDosId,
      })
    ).find((f) => f.channel === 'web')!;

    const neto = Number(fila.netRevenue);
    const esperado = neto - Number(fila.commission) - Number(fila.foodCost);
    expect(Number(fila.contributionMargin)).toBeCloseTo(esperado, 4);
    expect(Number(fila.netRevenue)).toBeCloseTo(
      Number(fila.grossRevenue) - Number(fila.discounts),
      4,
    );
  });

  it('CONCILIA con Billing: divergencia = bug crítico (spec 16)', async () => {
    // Se parte de una fecha limpia para que el cuadre sea exacto y no herede
    // ventas de las pruebas anteriores.
    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query(`DELETE FROM ana_counted_orders`);
      await client.query(`DELETE FROM ana_daily_sales`);
      await client.query(`DELETE FROM bil_documents`);
    });

    const ventas = [await vender(), await vender(), await vender('web')];
    await drenar();

    for (const venta of ventas) {
      const doc = await billing.createForOrder(tenantA, venta.id, {
        docType: 'DNI',
        docNumber: '45678912',
      });
      await billing.issue(tenantA, doc.id);
    }

    const r = await analytics.reconcileWithBilling(tenantA, hoy());

    expect(r.matches).toBe(true);
    expect(r.difference).toBe('0.0000');
    expect(r.ordersWithoutDocument).toBe(0);
    expect(r.documentsWithoutSale).toBe(0);
    expect(Number(r.analyticsTotal)).toBeGreaterThan(0);
  });

  it('corta el día de negocio en la zona del local, no en UTC', async () => {
    // 23:40 en Lima del día 7 es 04:40 UTC del día 8. La conciliación tiene que
    // preguntar por el 7: es el día que el dueño está cerrando.
    //
    // Esto NO es una hipótesis. `aFechaNegocio` usaba `toISOString()`, que da el
    // día UTC, mientras la proyección guarda `business_date` en hora de Lima.
    // Entre las 19:00 y la medianoche de Lima —las horas de más venta— la
    // conciliación miraba el día siguiente, encontraba cero de los dos lados y
    // respondía «cuadra». Un cuadre que solo cuadra porque no mira nada.
    //
    // La fecha va FIJA en la prueba a propósito: con `new Date()` esto pasaría
    // en verde 19 horas de cada 24, que es como el fallo sobrevivió hasta que
    // la suite corrió de madrugada.
    const casiMedianocheEnLima = new Date('2026-08-08T04:40:00Z');
    const r = await analytics.reconcileWithBilling(
      tenantA,
      casiMedianocheEnLima,
    );
    expect(r.businessDate).toBe('2026-08-07');
  });

  it('detecta una venta SIN comprobante: es la divergencia que importa', async () => {
    // Un total que no cuadra apunta a un cálculo; un pedido sin comprobante
    // apunta a una venta que no se declaró, que es mucho peor.
    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query(`DELETE FROM ana_counted_orders`);
      await client.query(`DELETE FROM ana_daily_sales`);
      await client.query(`DELETE FROM bil_documents`);
    });

    await vender();
    await drenar();

    const r = await analytics.reconcileWithBilling(tenantA, hoy());
    expect(r.matches).toBe(false);
    expect(r.ordersWithoutDocument).toBe(1);
    expect(Number(r.difference)).toBeGreaterThan(0);
  });

  it('GET /analytics/profitability y /reconciliation responden desde la proyección', async () => {
    const perfil = await auth(
      http().get('/api/v1/analytics/profitability'),
    ).expect(200);
    expect(Array.isArray(perfil.body)).toBe(true);

    const conciliacion = await auth(
      http().get('/api/v1/analytics/reconciliation'),
    ).expect(200);
    expect(conciliacion.body).toHaveProperty('matches');
    expect(conciliacion.body).toHaveProperty('difference');

    // `?date=` es un DÍA y se responde por ESE día. Con `new Date('2026-01-15')`
    // —medianoche UTC, 19:00 del 14 en Lima— la respuesta salía fechada el 14
    // aunque se hubiera pedido el 15: el panel enseñaría la conciliación de la
    // víspera bajo el título del día pedido, que es la peor forma de estar mal.
    const delDia = await auth(
      http().get('/api/v1/analytics/reconciliation?date=2026-01-15'),
    ).expect(200);
    expect(delDia.body.businessDate).toBe('2026-01-15');

    await auth(
      http().get('/api/v1/analytics/reconciliation?date=15-01-2026'),
    ).expect(422);

    await auth(
      http().get('/api/v1/analytics/profitability?from=no-es-fecha'),
    ).expect(422);
  });
  it('«¿CÓMO VAMOS HOY?» es lo que abre el panel, y compara con la semana pasada', async () => {
    // La portada del panel (specs/ux/03). Se comprueba contra la MISMA
    // proyección que la rentabilidad: si el resumen de hoy saliera de otro
    // sitio, el dueño vería un número en la portada y otro al entrar al
    // detalle, y no habría forma de saber cuál creer.
    const hoy = await auth(http().get('/api/v1/analytics/today')).expect(200);

    expect(hoy.body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hoy.body.orders).toBeGreaterThan(0);
    expect(hoy.body.byBrand.length).toBeGreaterThan(0);
    expect(hoy.body.byChannel.length).toBeGreaterThan(0);

    // El día comparado es SIETE días antes, no ayer: un martes no se parece a
    // un lunes en un restaurante.
    const dia = (t: string): number => Date.parse(`${t}T12:00:00Z`);
    expect(dia(hoy.body.businessDate) - dia(hoy.body.comparedDate)).toBe(
      7 * 24 * 3_600_000,
    );

    // Sin ventas la semana pasada NO se inventa un «+100 %»: no hay con qué
    // comparar y se dice así.
    expect(hoy.body.comparedNetRevenue).toBe('0.0000');
    expect(hoy.body.changeBps).toBeNull();

    // El total de la portada cuadra con la suma de sus partes. Un desglose que
    // no suma el total es exactamente lo que hace desconfiar de un panel.
    const sumaMarcas = hoy.body.byBrand.reduce(
      (n: number, s: { orders: number }) => n + s.orders,
      0,
    );
    const sumaCanales = hoy.body.byChannel.reduce(
      (n: number, s: { orders: number }) => n + s.orders,
      0,
    );
    expect(sumaMarcas).toBe(hoy.body.orders);
    expect(sumaCanales).toBe(hoy.body.orders);

    // Y el ticket promedio es el neto entre los pedidos NO cancelados.
    const neto = Number(hoy.body.netRevenue);
    expect(Number(hoy.body.averageTicket)).toBeCloseTo(
      neto / hoy.body.orders,
      3,
    );
  });
});
