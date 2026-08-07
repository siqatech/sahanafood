import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  Money,
  SyncQueue,
  calculateOrderTotals,
  type OrderLineInput,
} from '@sahana/domain';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import {
  OrderingService,
  type OfflineOrderInput,
} from '../modules/ordering/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * PRUEBAS OFFLINE BLOQUEANTES de la spec 06 (T4.20/T4.21/T4.22).
 *
 * La regla que gobierna todo esto es RN-T07: **la venta offline nunca se
 * rechaza al sincronizar**. El cliente ya se fue con su comida y su boleta; el
 * servidor no puede decidir tres horas después que ese pedido no existió.
 *
 * Los totales que se comparan se calculan con `@sahana/domain`, el MISMO
 * código que correría en la PWA. Que coincidan no es una comprobación
 * decorativa: es lo que detecta que ambos lados dejaron de estar sincronizados,
 * que sería un fallo grave y completamente silencioso.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('POS offline: cola local y sincronización', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
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
    ordering = app.get(OrderingService);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Offline Tenant',
      planCode: 'growth',
      owner: {
        email: 'off-a@sahana.test',
        password: 'password-off-a-1',
        fullName: 'Dueño Offline',
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
      .send({ email: 'off-a@sahana.test', password: 'password-off-a-1' })
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

  /** ULID de cliente, estable y ordenable como los que genera el POS. */
  const clientId = (n: number, prefijo = 'A') =>
    `01J${prefijo}${String(n).padStart(22, '0')}`;

  /**
   * Simula lo que hace la PWA al cobrar sin red: calcula los totales con el
   * dominio compartido y guarda el snapshot. Es a propósito el MISMO cálculo
   * que hará el servidor al comparar.
   */
  function venderSinRed(
    n: number,
    opciones: {
      cantidad?: number;
      precioMinor?: number;
      prefijo?: string;
    } = {},
  ): OfflineOrderInput {
    const cantidad = opciones.cantidad ?? 1;
    const precio = opciones.precioMinor ?? Money.parse('38.00').minorUnits;

    const lineas: OrderLineInput[] = [
      {
        lineId: 'l0',
        productId: cat.comboId,
        productName: 'Combo familiar',
        unitPriceMinor: precio,
        quantity: cantidad,
        modifierGroups: [],
        modifierSelections: [],
      },
    ];
    const totales = calculateOrderTotals({ lines: lineas });

    return {
      clientId: clientId(n, opciones.prefijo),
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.comboId,
          productName: 'Combo familiar',
          quantity: cantidad,
          unitPriceMinor: precio,
          lineTotalMinor: totales.lines[0]!.total.minorUnits,
        },
      ],
      totalMinor: totales.total.minorUnits,
      soldAt: new Date(Date.now() - (30 - n) * 60_000).toISOString(),
    };
  }

  const sincronizar = (pedidos: OfflineOrderInput[]) =>
    auth(http().post('/api/v1/orders/sync').send({ orders: pedidos }));

  // ------------------------------- PRUEBA BLOQUEANTE 1: 20 pedidos sin red

  it('20 PEDIDOS SIN RED → 20 en servidor con TOTALES IDÉNTICOS', async () => {
    // El criterio de aceptación de la spec 06. Si los totales no coinciden, es
    // que el dominio compartido divergió entre PWA y servidor, y eso significa
    // que el importe del ticket y el de la factura no son el mismo número.
    const cola = new SyncQueue<OfflineOrderInput>();
    const ahora = Date.now();

    for (let i = 1; i <= 20; i++) {
      const pedido = venderSinRed(i, { cantidad: (i % 3) + 1 });
      cola.enqueue(pedido.clientId, pedido, ahora + i);
    }
    expect(
      cola.canCloseShift().ok,
      'no se puede cerrar con ventas pendientes',
    ).toBe(false);

    const lote = cola.nextBatch(ahora + 1_000, 50);
    cola.markInFlight(lote.map((i) => i.clientId));

    const res = await sincronizar(lote.map((i) => i.payload)).expect(201);
    expect(res.body.accepted).toBe(20);
    expect(res.body.failed).toBe(0);

    for (const r of res.body.results) cola.markSynced(r.clientId);
    expect(cola.canCloseShift()).toEqual({ ok: true, pending: 0 });

    // Los 20 están en el servidor...
    const enServidor = await ordering.list(tenantA, {
      channel: 'pos',
      limit: 200,
    });
    const porRef = new Map(
      await Promise.all(
        lote.map(async (i) => {
          const encontrado = res.body.results.find(
            (r: { clientId: string }) => r.clientId === i.clientId,
          );
          return [i.clientId, encontrado.orderId as string] as const;
        }),
      ),
    );
    expect(new Set(porRef.values()).size).toBe(20);

    // ...y CADA total coincide exactamente con el que calculó la PWA.
    const discrepancias: string[] = [];
    for (const item of lote) {
      const orderId = porRef.get(item.clientId)!;
      const enBd = enServidor.find((o) => o.id === orderId);
      if (!enBd) {
        discrepancias.push(`${item.clientId}: no está en el servidor`);
        continue;
      }
      if (enBd.total.minorUnits !== item.payload.totalMinor) {
        discrepancias.push(
          `${item.clientId}: POS ${item.payload.totalMinor} vs servidor ${enBd.total.minorUnits}`,
        );
      }
    }
    expect(
      discrepancias,
      `Los totales del POS y del servidor no coinciden:\n${discrepancias.join('\n')}`,
    ).toEqual([]);
  }, 60_000);

  // ------------------ PRUEBA BLOQUEANTE 2: corte a mitad de sincronización

  it('CORTE DE RED A MITAD DE LA SINCRONIZACIÓN → sin duplicados', async () => {
    // El caso real: se manda el lote, el servidor procesa parte, la conexión
    // muere antes de que llegue la respuesta. La PWA no sabe qué entró y
    // reenvía todo. Si el dedupe fallara, la mitad se cobraría dos veces.
    const cola = new SyncQueue<OfflineOrderInput>();
    const ahora = Date.now();
    const pedidos = Array.from({ length: 10 }, (_, i) =>
      venderSinRed(i + 1, { prefijo: 'B' }),
    );
    for (const p of pedidos) cola.enqueue(p.clientId, p, ahora);

    // Primera tanda: el servidor SÍ procesa los 5 primeros...
    const primeraMitad = pedidos.slice(0, 5);
    cola.markInFlight(primeraMitad.map((p) => p.clientId));
    await sincronizar(primeraMitad).expect(201);

    // ...pero la PWA nunca recibe la respuesta: se cae la red.
    const recuperados = cola.recoverInFlight(ahora + 5_000);
    expect(recuperados).toBe(5);

    // Al volver la red reenvía TODO, incluidos los que ya entraron.
    const reintento = cola.nextBatch(ahora + 6_000, 50);
    expect(reintento).toHaveLength(10);
    const res = await sincronizar(reintento.map((i) => i.payload)).expect(201);

    expect(res.body.duplicates, 'no se detectaron los ya sincronizados').toBe(
      5,
    );
    expect(res.body.accepted).toBe(5);

    // Y en la base hay exactamente 10 pedidos, ni uno más.
    const cuenta = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ord_orders
          WHERE channel = 'pos' AND external_ref LIKE '01JB%'`,
      );
      return Number(rows[0]!.count);
    });
    expect(
      cuenta,
      'la reconciliación creó pedidos duplicados: se cobraría dos veces',
    ).toBe(10);
  }, 60_000);

  it('reenviar el MISMO lote entero no crea nada nuevo', async () => {
    const pedidos = [venderSinRed(1, { prefijo: 'C' })];
    const primera = await sincronizar(pedidos).expect(201);
    const segunda = await sincronizar(pedidos).expect(201);

    expect(segunda.body.duplicates).toBe(1);
    expect(segunda.body.results[0].orderId).toBe(
      primera.body.results[0].orderId,
    );
  });

  // --------------------------- RN-T07: la venta offline NUNCA se rechaza

  it('un producto RETIRADO del catálogo no impide que la venta entre', async () => {
    // El cliente ya pagó y se fue. Rechazar aquí sería negar una venta real.
    const pedido = venderSinRed(1, { prefijo: 'D' });
    pedido.lines[0]!.productId = cat.soloPosId;
    pedido.lines[0]!.productName = 'Promo retirada';
    // `soloPosId` no tiene precio en el canal 'web': se sincroniza ahí para
    // forzar que el catálogo vigente no lo tenga.
    pedido.channel = 'web';

    const res = await sincronizar([pedido]).expect(201);
    expect(res.body.results[0].outcome).toBe('accepted_with_alerts');
    expect(res.body.results[0].alerts[0]).toContain('ya no está disponible');

    const orderId = res.body.results[0].orderId;
    expect((await ordering.getSummary(tenantA, orderId)).status).toBe(
      'accepted',
    );
  });

  it('si el PRECIO cambió, prevalece el del ticket y se alerta', async () => {
    // RN-T07: recalcular produciría un pedido que no coincide con el ticket
    // que la persona tiene en la mano.
    const precioViejo = Money.parse('30.00').minorUnits;
    const pedido = venderSinRed(2, {
      prefijo: 'D',
      precioMinor: precioViejo,
    });

    const res = await sincronizar([pedido]).expect(201);
    expect(res.body.results[0].outcome).toBe('accepted_with_alerts');
    expect(res.body.results[0].alerts.join(' ')).toMatch(
      /precio de .* cambió/i,
    );

    const enBd = await ordering.getSummary(
      tenantA,
      res.body.results[0].orderId,
    );
    expect(
      enBd.total.minorUnits,
      'el servidor recalculó el precio y el ticket dejó de cuadrar',
    ).toBe(pedido.totalMinor);
  });

  it('un total que no cuadra se acepta, se alerta y prevalece el del ticket', async () => {
    // Esta alerta es la que detecta que el dominio compartido divergió entre
    // PWA y servidor: un fallo grave y silencioso.
    const pedido = venderSinRed(3, { prefijo: 'D' });
    pedido.totalMinor = Money.parse('99.99').minorUnits;

    const res = await sincronizar([pedido]).expect(201);
    expect(res.body.results[0].outcome).toBe('accepted_with_alerts');
    expect(res.body.results[0].alerts.join(' ')).toContain('no coincide');

    const enBd = await ordering.getSummary(
      tenantA,
      res.body.results[0].orderId,
    );
    expect(enBd.total.minorUnits).toBe(Money.parse('99.99').minorUnits);
  });

  it('las alertas quedan en el TIMELINE del pedido, no en un log', async () => {
    // Quien revise ese pedido mañana tiene que ver por qué se marcó sin buscar
    // en otro sitio.
    const pedido = venderSinRed(4, { prefijo: 'D' });
    pedido.totalMinor = Money.parse('1.00').minorUnits;
    const res = await sincronizar([pedido]).expect(201);

    const timeline = await ordering.getTimeline(
      tenantA,
      res.body.results[0].orderId,
    );
    const alerta = timeline.find((e) => e.event === 'offline_alert');
    expect(alerta).toBeTruthy();
    expect(alerta!.reason).toContain('no coincide');

    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ resource_id: string }>(
        "SELECT resource_id FROM audit_log WHERE action = 'order.offline_alert'",
      );
      return rows.map((r) => r.resource_id);
    });
    expect(auditoria).toContain(res.body.results[0].orderId);
  });

  it('la venta offline entra ya ACEPTADA: se cobró y se entregó', async () => {
    // Nacer en `received` invitaría a que el barrido de vencimientos la
    // rechazara sola diez minutos después.
    const res = await sincronizar([venderSinRed(5, { prefijo: 'D' })]).expect(
      201,
    );
    const enBd = await ordering.getSummary(
      tenantA,
      res.body.results[0].orderId,
    );
    expect(enBd.status).toBe('accepted');
  });

  // -------------------------------------------------- Robustez del lote

  it('un pedido roto NO tumba el lote: los demás entran', async () => {
    // Un lote que falla entero por culpa de uno obligaría a reenviar los que
    // sí entraron, y la segunda vuelta chocaría contra el dedupe sin necesidad.
    const bueno = venderSinRed(1, { prefijo: 'E' });
    const malo = venderSinRed(2, { prefijo: 'E' });
    // Marca inexistente: falla la FK compuesta.
    malo.brandId = '00000000-0000-0000-0000-000000000000';

    const res = await sincronizar([bueno, malo]).expect(201);
    expect(res.body.accepted).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(
      res.body.results.find(
        (r: { clientId: string }) => r.clientId === malo.clientId,
      ).outcome,
    ).toBe('failed');
  });

  it('el lote está acotado: 200 pedidos de golpe se rechazan', async () => {
    // Una petición gigante que falla a mitad reintenta el trabajo entero.
    const muchos = Array.from({ length: 200 }, (_, i) =>
      venderSinRed(i + 1, { prefijo: 'F' }),
    );
    await sincronizar(muchos).expect(422);
  });

  it('el pedido sincronizado conserva su ULID de cliente como referencia', async () => {
    const pedido = venderSinRed(1, { prefijo: 'G' });
    const res = await sincronizar([pedido]).expect(201);

    const ref = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ external_ref: string }>(
        'SELECT external_ref FROM ord_orders WHERE id = $1',
        [res.body.results[0].orderId],
      );
      return rows[0]!.external_ref;
    });
    expect(ref).toBe(pedido.clientId);
  });
});
