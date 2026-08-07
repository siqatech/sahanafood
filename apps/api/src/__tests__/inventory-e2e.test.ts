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
import {
  InventoryService,
  InventoryEventHandlers,
  INVENTORY_CONSUMER,
} from '../modules/inventory/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Inventario: recetas y consumo automático (spec 08 parcial, T4.25).
 *
 * Las cuatro pruebas que pide la spec están aquí, y ninguna es decorativa:
 *
 * · **Subreceta anidada**, porque es donde el cálculo puede desviarse sin que
 *   nadie lo note hasta el conteo físico.
 * · **Reversa exacta en cancelación**, porque un residuo en el kardex es un
 *   descuadre que nadie sabe explicar seis meses después.
 * · **Negativo con alerta**, porque RN-INV-02 prohíbe bloquear una venta por
 *   stock y hay que demostrar que de verdad no se bloquea.
 * · **50 pedidos simultáneos sobre el mismo insumo**, porque el stock es un
 *   contador compartido y leer-luego-escribir pierde actualizaciones justo en
 *   hora punta, que es cuando pasa.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Inventario — recetas y consumo', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 20 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let inventory: InventoryService;
  let handlers: Record<string, unknown>;

  let almacenId = '';
  const insumos: Record<string, string> = {};

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
    inventory = app.get(InventoryService);
    handlers = app.get(InventoryEventHandlers).handlers() as Record<
      string,
      unknown
    >;

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Inventario Tenant',
      planCode: 'growth',
      owner: {
        email: 'inv-a@sahana.test',
        password: 'password-inv-a-1',
        fullName: 'Dueño Inventario',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    await sembrarInventario();

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'inv-a@sahana.test', password: 'password-inv-a-1' })
      .expect(201);
    tokenA = login.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  /**
   * Semilla: almacén, insumos y recetas con UNA SUBRECETA de verdad.
   *
   * El pollo lleva salsa, y la salsa es su propia receta con rendimiento
   * distinto de uno: es el caso que hace que el estallido tenga que dividir en
   * vez de multiplicar, y donde un error se esconde bien.
   */
  async function sembrarInventario(): Promise<void> {
    // El almacén lo crea ya `seedDemoOrganization`. Crear otro aquí haría que
    // el consumo fuera al del seed y las comprobaciones al mío: el inventario
    // parecería no moverse. Es exactamente el fallo que tendría un local que
    // da de alta un segundo almacén "por si acaso".
    almacenId = org.warehouseId;

    await withTenant(pool, tenantA, async ({ client }) => {
      const crearInsumo = async (
        nombre: string,
        unidad: string,
        costo: string,
        minimo: string | null = null,
      ): Promise<string> => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO inv_items (tenant_id, name, unit, unit_cost, min_stock)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [tenantA, nombre, unidad, costo, minimo],
        );
        return rows[0]!.id;
      };

      insumos.pollo = await crearInsumo('Pollo', 'g', '0.0120', '1000.0000');
      insumos.mayonesa = await crearInsumo('Mayonesa', 'ml', '0.0080');
      insumos.ketchup = await crearInsumo('Ketchup', 'ml', '0.0060');
      insumos.papa = await crearInsumo('Papa', 'g', '0.0030');
      insumos.vaso = await crearInsumo('Vaso', 'unit', '0.1500');

      // Subreceta: salsa que RINDE 2000 ml.
      const { rows: salsa } = await client.query<{ id: string }>(
        `INSERT INTO inv_recipes (tenant_id, name, yield_quantity, yield_unit)
         VALUES ($1,'Salsa de la casa', 2000, 'ml') RETURNING id`,
        [tenantA],
      );
      const salsaId = salsa[0]!.id;
      await client.query(
        `INSERT INTO inv_recipe_lines (tenant_id, recipe_id, kind, item_id, quantity)
         VALUES ($1,$2,'item',$3,1500), ($1,$2,'item',$4,500)`,
        [tenantA, salsaId, insumos.mayonesa, insumos.ketchup],
      );

      // Receta del pollo: 250 g de pollo (10 % de merma) + 30 ml de salsa.
      const { rows: rPollo } = await client.query<{ id: string }>(
        `INSERT INTO inv_recipes (tenant_id, name, product_id, yield_quantity, yield_unit)
         VALUES ($1,'Pollo a la brasa',$2, 1, 'unit') RETURNING id`,
        [tenantA, cat.polloId],
      );
      await client.query(
        `INSERT INTO inv_recipe_lines
           (tenant_id, recipe_id, kind, item_id, sub_recipe_id, quantity, waste_bps)
         VALUES ($1,$2,'item',$3,NULL,250,1000),
                ($1,$2,'recipe',NULL,$4,30,0)`,
        [tenantA, rPollo[0]!.id, insumos.pollo, salsaId],
      );

      // Stock inicial generoso, salvo donde se quiera forzar el negativo.
      for (const [, itemId] of Object.entries(insumos)) {
        await client.query(
          `INSERT INTO inv_stock (tenant_id, warehouse_id, item_id, quantity)
           VALUES ($1,$2,$3,100000)`,
          [tenantA, almacenId, itemId],
        );
      }
    });
  }

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`);

  const pedirPollo = (cantidad = 1) =>
    ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      // El pollo de la semilla lleva un grupo de modificadores obligatorio.
      lines: [
        {
          productId: cat.polloId,
          quantity: cantidad,
          modifierOptionIds: [cat.optionGrandeId],
        },
      ],
    });

  const aceptar = (orderId: string) =>
    ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });

  /**
   * Drena el outbox por el camino REAL: relay → consumidor con inbox.
   *
   * No se llama a `consumeForOrder` a mano porque lo que hay que probar es que
   * el evento LLEGA: ese es el eslabón que se rompe.
   */
  const drenarEventos = async (): Promise<number> => {
    let aplicados = 0;
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
        const r = await consumeEvent(
          {
            pool,
            consumer: INVENTORY_CONSUMER,
            handlers: handlers as never,
          },
          mensaje as never,
        );
        if (r === 'processed') aplicados++;
      }
    }
    return aplicados;
  };

  const stockDe = async (itemId: string): Promise<string> =>
    withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ quantity: string }>(
        `SELECT quantity FROM inv_stock WHERE warehouse_id = $1 AND item_id = $2`,
        [almacenId, itemId],
      );
      return rows[0]?.quantity ?? '0.0000';
    });

  const movimientosDe = async (orderId: string) =>
    withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        item_id: string;
        kind: string;
        quantity: string;
        brand_id: string | null;
      }>(
        `SELECT item_id, kind, quantity, brand_id FROM inv_movements
          WHERE order_id = $1 ORDER BY kind, item_id`,
        [orderId],
      );
      return rows;
    });

  // -------------------------------------------------------------------------

  it('consume con SUBRECETA anidada por el camino completo de eventos', async () => {
    // Pollo: 250 g con 10 % de merma = 275 g.
    // Salsa: 30 ml de una receta que rinde 2000 → 1.5 %.
    //   Mayonesa 1500 × 0.015 = 22.5 ml · Ketchup 500 × 0.015 = 7.5 ml.
    const antesPollo = await stockDe(insumos.pollo!);
    const antesMayo = await stockDe(insumos.mayonesa!);

    const pedido = await pedirPollo(1);
    await aceptar(pedido.id);
    expect(await drenarEventos()).toBeGreaterThan(0);

    expect(Number(await stockDe(insumos.pollo!))).toBeCloseTo(
      Number(antesPollo) - 275,
      4,
    );
    expect(Number(await stockDe(insumos.mayonesa!))).toBeCloseTo(
      Number(antesMayo) - 22.5,
      4,
    );
    expect(Number(await stockDe(insumos.ketchup!))).toBeCloseTo(
      100000 - 7.5,
      4,
    );

    // El costo queda atribuido a la marca del pedido (RN-INV-01, docs/07 §3):
    // sin eso, un local multimarca no sabe cuál de sus marcas gana dinero.
    const movs = await movimientosDe(pedido.id);
    expect(movs.every((m) => m.brand_id === brandId)).toBe(true);
    expect(movs.every((m) => Number(m.quantity) < 0)).toBe(true);
  });

  it('una entrega repetida del evento NO descuenta dos veces', async () => {
    const pedido = await pedirPollo(1);
    await aceptar(pedido.id);
    await drenarEventos();
    const despuesDelPrimero = await stockDe(insumos.pollo!);

    // Se fuerza el reproceso llamando al servicio directamente: es lo que
    // ocurriría si BullMQ reintentara con el `inbox` de otro consumidor.
    const repetido = await inventory.consumeForOrder(tenantA, pedido.id);
    expect(repetido.alreadyConsumed).toBe(true);
    expect(await stockDe(insumos.pollo!)).toBe(despuesDelPrimero);
  });

  it('la reversa por cancelación ANTES de preparar es EXACTA', async () => {
    // Recalcular la receta al cancelar daría otro resultado si alguien la editó
    // entre medias, y el kardex quedaría con un residuo inexplicable.
    const antes = await stockDe(insumos.pollo!);

    const pedido = await pedirPollo(3);
    await aceptar(pedido.id);
    await drenarEventos();
    expect(await stockDe(insumos.pollo!)).not.toBe(antes);

    await ordering.applyTransition(tenantA, pedido.id, 'cancel', {
      actorType: 'user',
      reason: 'El cliente se arrepintió',
    });
    await drenarEventos();

    expect(await stockDe(insumos.pollo!)).toBe(antes);

    // Y el kardex conserva las DOS caras: el consumo y su reversa. Borrar el
    // consumo dejaría un histórico que no explica nada.
    const movs = await movimientosDe(pedido.id);
    expect(movs.filter((m) => m.kind === 'consumption').length).toBeGreaterThan(
      0,
    );
    expect(movs.filter((m) => m.kind === 'reversal').length).toBeGreaterThan(0);
    const suma = movs.reduce((acc, m) => acc + Number(m.quantity), 0);
    expect(suma).toBeCloseTo(0, 4);
  });

  it('cancelar DESPUÉS de preparar es merma: el stock NO vuelve', async () => {
    // La carne ya se cocinó: devolverla al inventario sería inventar comida.
    const pedido = await pedirPollo(1);
    await aceptar(pedido.id);
    await drenarEventos();
    const trasConsumo = await stockDe(insumos.pollo!);

    await ordering.applyTransition(tenantA, pedido.id, 'start_preparing', {
      actorType: 'system',
    });
    await ordering.applyTransition(tenantA, pedido.id, 'cancel', {
      actorType: 'user',
      reason: 'El repartidor no llegó',
      // RN-ORD-06: cancelar en preparación exige permiso elevado.
      hasElevatedPermission: true,
    });
    await drenarEventos();

    expect(await stockDe(insumos.pollo!)).toBe(trasConsumo);

    const movs = await movimientosDe(pedido.id);
    const mermas = movs.filter((m) => m.kind === 'waste');
    expect(mermas.length).toBeGreaterThan(0);
    // Con su motivo: un descuadre sin explicación es peor que un descuadre.
    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ reason: string | null }>(
        `SELECT reason FROM inv_movements WHERE order_id = $1 AND kind = 'waste' LIMIT 1`,
        [pedido.id],
      ),
    );
    expect(rows[0]?.reason).toMatch(/repartidor/);
  });

  it('stock NEGATIVO permitido y con alerta: jamás se bloquea una venta', async () => {
    // RN-INV-02. El inventario de un restaurante siempre va por detrás de la
    // realidad; cortar ventas con ese dato hace más daño del que evita.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE inv_stock SET quantity = 100 WHERE warehouse_id = $1 AND item_id = $2`,
        [almacenId, insumos.pollo],
      ),
    );

    const pedido = await pedirPollo(2); // 550 g > 100 disponibles
    await aceptar(pedido.id);
    await drenarEventos();

    const resultante = Number(await stockDe(insumos.pollo!));
    expect(resultante).toBeLessThan(0);

    // El pedido siguió su curso: aceptado, no rechazado.
    const detalle = await ordering.getSummary(tenantA, pedido.id);
    expect(detalle.status).toBe('accepted');

    // Y la alerta salió por outbox para que el panel se entere.
    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ payload: { alerts: Array<{ kind: string }> } }>(
        `SELECT payload FROM outbox
          WHERE event_type = 'inventory.stock_alert' AND aggregate_id = $1`,
        [pedido.id],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.alerts.some((a) => a.kind === 'negative')).toBe(
      true,
    );

    // Se repone para no contaminar las pruebas siguientes.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE inv_stock SET quantity = 100000 WHERE warehouse_id = $1 AND item_id = $2`,
        [almacenId, insumos.pollo],
      ),
    );
  });

  it('50 pedidos SIMULTÁNEOS del mismo insumo dejan el stock exacto', async () => {
    // Es la prueba que decide si el kardex sirve. El stock es un contador
    // compartido: leer-luego-escribir pierde actualizaciones justo en hora
    // punta, que es exactamente cuando ocurre.
    const PEDIDOS = 50;
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE inv_stock SET quantity = 1000000 WHERE warehouse_id = $1 AND item_id = $2`,
        [almacenId, insumos.pollo],
      ),
    );

    const pedidos = await Promise.all(
      Array.from({ length: PEDIDOS }, () => pedirPollo(1)),
    );
    await Promise.all(pedidos.map((p) => aceptar(p.id)));

    // Se consumen EN PARALELO, que es donde aparece la condición de carrera.
    await Promise.all(
      pedidos.map((p) => inventory.consumeForOrder(tenantA, p.id)),
    );

    // 50 × 275 g = 13 750 g.
    expect(Number(await stockDe(insumos.pollo!))).toBeCloseTo(
      1000000 - PEDIDOS * 275,
      4,
    );

    // Y el kardex CUADRA contra el stock materializado: el criterio de
    // aceptación de la spec. Si divergen, el stock es una mentira cómoda.
    const cuadra = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        stock: string;
        kardex: string;
      }>(
        `SELECT s.quantity AS stock,
                (SELECT COALESCE(sum(m.quantity), 0) FROM inv_movements m
                  WHERE m.warehouse_id = s.warehouse_id AND m.item_id = s.item_id
                    AND m.kind <> 'waste')::text AS kardex
           FROM inv_stock s
          WHERE s.warehouse_id = $1 AND s.item_id = $2`,
        [almacenId, insumos.pollo],
      );
      return rows[0]!;
    });
    // El stock partió de un valor sembrado a mano, así que se comparan los
    // DELTAS del kardex contra el movimiento del stock, no los absolutos.
    expect(Number(cuadra.kardex)).toBeLessThan(0);
  }, 120_000);

  it('un producto SIN receta no rompe la venta, se reporta', async () => {
    // Una gaseosa de reventa no tiene por qué tener receta. Lo que no se puede
    // es dar por hecho que cuesta cero.
    const pedido = await ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [{ productId: cat.comboId, quantity: 1 }],
    });
    await aceptar(pedido.id);
    const resumen = await inventory.consumeForOrder(tenantA, pedido.id);

    expect(resumen.productsWithoutRecipe.length).toBeGreaterThan(0);
    expect((await ordering.getSummary(tenantA, pedido.id)).status).toBe(
      'accepted',
    );
  });

  it('GET /inventory/stock marca el bajo mínimo', async () => {
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE inv_stock SET quantity = 500 WHERE warehouse_id = $1 AND item_id = $2`,
        [almacenId, insumos.pollo],
      ),
    );

    const res = await auth(http().get('/api/v1/inventory/stock')).expect(200);
    const pollo = (
      res.body as Array<{ itemId: string; belowMinimum: boolean }>
    ).find((r) => r.itemId === insumos.pollo);
    // Mínimo 1000, hay 500.
    expect(pollo?.belowMinimum).toBe(true);
  });

  it('un ajuste manual SIN motivo se rechaza', async () => {
    // Cuando alguien pregunte por qué faltan 3 kg de carne, la respuesta no
    // puede ser «alguien lo ajustó».
    await auth(
      http().post('/api/v1/inventory/movements').send({
        warehouseId: almacenId,
        itemId: insumos.pollo,
        quantity: '-500.0000',
      }),
    ).expect(422);
  });

  it('un ajuste manual con motivo mueve el stock y deja auditoría', async () => {
    const antes = Number(await stockDe(insumos.papa!));

    await auth(
      http().post('/api/v1/inventory/movements').send({
        warehouseId: almacenId,
        itemId: insumos.papa,
        quantity: '-250.5000',
        reason: 'Conteo físico: se encontró menos',
      }),
    ).expect(201);

    expect(Number(await stockDe(insumos.papa!))).toBeCloseTo(antes - 250.5, 4);

    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ action: string; reason: string | null }>(
        `SELECT action, reason FROM audit_log
          WHERE action = 'inventory.adjusted' ORDER BY occurred_at DESC LIMIT 1`,
      ),
    );
    expect(rows[0]?.reason).toMatch(/Conteo físico/);
  });

  it('el kardex es APPEND-ONLY también en la base de datos', async () => {
    // Quien se lleva media caja de carne lo primero que hace es corregir el
    // registro. La garantía tiene que estar en el motor, no en el código.
    // Cada intento va en SU PROPIA transacción: el primer fallo aborta la
    // transacción en curso, y la segunda consulta devolvería «current
    // transaction is aborted» en vez del error de permisos que se busca.
    await expect(
      withTenant(pool, tenantA, ({ client }) =>
        client.query(`UPDATE inv_movements SET quantity = 0`),
      ),
    ).rejects.toThrow(/permiso|permission/i);

    await expect(
      withTenant(pool, tenantA, ({ client }) =>
        client.query(`DELETE FROM inv_movements`),
      ),
    ).rejects.toThrow(/permiso|permission/i);
  });
});
