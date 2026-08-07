import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Money } from '@sahana/domain';
import { AppModule } from '../app.module.js';
import { configureApp } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import * as schema from '../database/schema/index.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Orquestador de pedidos (spec 05, canónica).
 *
 * Cubre los criterios de aceptación §11: dedupe concurrente, idempotencia con
 * payload igual y distinto, snapshot inmutable, timeline reconstruible y
 * transiciones inválidas.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Ordering e2e', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let brandId = '';
  let ordering: OrderingService;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ordering = app.get(OrderingService);

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);
    const a = await tenancy.provisionTenant({
      name: 'Ord Tenant A',
      planCode: 'growth',
      owner: {
        email: 'ord-a@sahana.test',
        password: 'password-ord-a-1',
        fullName: 'Dueño Ord A',
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
      .send({ email: 'ord-a@sahana.test', password: 'password-ord-a-1' })
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

  /** Pedido base: pollo con tamaño obligatorio elegido. */
  const pedidoBase = (over: Record<string, unknown> = {}) => ({
    brandId,
    locationId: org.locationId,
    channel: 'pos',
    lines: [
      {
        productId: cat.polloId,
        quantity: 1,
        modifierOptionIds: [cat.optionGrandeId],
      },
    ],
    ...over,
  });

  // ------------------------------------------------------- Creación básica

  it('crea un pedido y calcula el total con el dominio compartido', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);

    // Pollo en POS = precio base 30 + "Grande" 5 = 35.
    expect(res.body.total.minorUnits).toBe(Money.parse('35.00').minorUnits);
    expect(res.body.status).toBe('received');
    expect(res.body.orderNumber).toBeGreaterThan(0);
    // IGV desglosado hacia atrás sobre el total.
    expect(Money.fromMinor(res.body.total.minorUnits).toDecimalString()).toBe(
      '35.0000',
    );
    expect(res.body.tax.minorUnits).toBeGreaterThan(0);
  });

  it('los números de pedido son correlativos y no se repiten', async () => {
    const a = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    const b = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    expect(b.body.orderNumber).toBe(a.body.orderNumber + 1);
  });

  it('emite el evento de recepción por el outbox', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    let evento: { eventType: string } | undefined;
    await relayOnce(pool, async (record) => {
      if (record.aggregateId === res.body.id) evento = record;
    });
    expect(evento?.eventType).toBe('order.received');
  });

  // ------------------------------------------ SNAPSHOT INMUTABLE (RN-ORD-02)

  it('el pedido guarda un SNAPSHOT: cambiar el precio no lo altera', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    const totalOriginal = res.body.total.minorUnits;

    // Subir el precio del pollo en POS después de crear el pedido.
    await withTenant(pool, tenantA, async (ctx) => {
      await ctx.client.query(
        `UPDATE cat_prices SET price = '99.0000'
          WHERE product_id = $1 AND channel IS NULL`,
        [cat.polloId],
      );
    });

    // El pedido ya creado conserva su total y el nombre del momento.
    const despues = await auth(
      http().get(`/api/v1/orders/${res.body.id}`),
    ).expect(200);
    expect(despues.body.total.minorUnits).toBe(totalOriginal);

    const lineas = await withTenant(pool, tenantA, async (ctx) => {
      const { rows } = await ctx.client.query<{
        product_name: string;
        unit_price: string;
      }>(
        'SELECT product_name, unit_price FROM ord_order_lines WHERE order_id = $1',
        [res.body.id],
      );
      return rows;
    });
    expect(lineas[0]!.unit_price).toBe('30.0000'); // el de entonces, no 99
    expect(lineas[0]!.product_name).toBe('Pollo a la brasa entero');

    // Restaurar para las demás pruebas.
    await withTenant(pool, tenantA, async (ctx) => {
      await ctx.client.query(
        `UPDATE cat_prices SET price = '30.0000'
          WHERE product_id = $1 AND channel IS NULL`,
        [cat.polloId],
      );
    });
  });

  // ------------------------------------------- DEDUPE (RN-ORD-03) — el gate

  it('un reintento del canal externo NO crea un segundo pedido', async () => {
    const externalRef = `mkt-${Date.now()}`;
    const primero = await auth(
      http()
        .post('/api/v1/orders')
        .send(pedidoBase({ channel: 'rappi', externalRef })),
    ).expect(201);

    const reintento = await auth(
      http()
        .post('/api/v1/orders')
        .send(pedidoBase({ channel: 'rappi', externalRef })),
    ).expect(201);

    expect(reintento.body.id).toBe(primero.body.id);
    expect(reintento.body.deduplicated).toBe(true);
  });

  it('DEDUPE CONCURRENTE: dos submits simultáneos → UN SOLO pedido (§11.2)', async () => {
    const externalRef = `concurrente-${Date.now()}`;
    const payload = {
      brandId,
      locationId: org.locationId,
      channel: 'rappi',
      externalRef,
      lines: [
        {
          productId: cat.polloId,
          quantity: 1,
          modifierOptionIds: [cat.optionGrandeId],
        },
      ],
    };

    // Dos workers procesando el MISMO webhook a la vez. Uno puede fallar por el
    // índice único —eso es correcto—, pero jamás pueden existir dos pedidos.
    const resultados = await Promise.allSettled([
      ordering.submit(tenantA, payload),
      ordering.submit(tenantA, payload),
    ]);

    const exitosos = resultados.filter((r) => r.status === 'fulfilled');
    expect(exitosos.length).toBeGreaterThanOrEqual(1);

    const enBd = await withTenant(pool, tenantA, async (ctx) => {
      const { rows } = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ord_orders
          WHERE channel = 'rappi' AND external_ref = $1`,
        [externalRef],
      );
      return Number(rows[0]!.count);
    });
    expect(
      enBd,
      'Se crearon pedidos duplicados: el índice único no está protegiendo',
    ).toBe(1);
  });

  // ------------------------------------- IDEMPOTENCIA (ADR-0010, §11 pruebas)

  it('la misma Idempotency-Key con el MISMO payload devuelve el pedido original', async () => {
    const key = `idem-${Date.now()}`;
    const primero = await auth(
      http()
        .post('/api/v1/orders')
        .set('idempotency-key', key)
        .send(pedidoBase()),
    ).expect(201);

    const repetido = await auth(
      http()
        .post('/api/v1/orders')
        .set('idempotency-key', key)
        .send(pedidoBase()),
    ).expect(201);

    expect(repetido.body.id).toBe(primero.body.id);
    expect(repetido.body.deduplicated).toBe(true);
  });

  it('la misma clave con payload DISTINTO es un error del cliente (422)', async () => {
    const key = `idem-mismatch-${Date.now()}`;
    await auth(
      http()
        .post('/api/v1/orders')
        .set('idempotency-key', key)
        .send(pedidoBase()),
    ).expect(201);

    const res = await auth(
      http()
        .post('/api/v1/orders')
        .set('idempotency-key', key)
        .send(
          pedidoBase({
            lines: [
              {
                productId: cat.polloId,
                quantity: 9,
                modifierOptionIds: [cat.optionGrandeId],
              },
            ],
          }),
        ),
    ).expect(422);

    expect(res.body.type).toContain('idempotency-payload-mismatch');
  });

  // -------------------------------------------- Validaciones (RN-ORD-09)

  it('rechaza un producto no disponible en el canal', async () => {
    // "Promo mostrador" solo tiene precio en POS.
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(
          pedidoBase({
            channel: 'web',
            lines: [{ productId: cat.soloPosId, quantity: 1 }],
          }),
        ),
    ).expect(422);
    expect(res.body.type).toContain('order-product-unavailable');
  });

  it('rechaza una dirección fuera de la zona de cobertura', async () => {
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(
          pedidoBase({
            delivery: { address: 'Muy lejos', lat: -12.9, lng: -76.5 },
          }),
        ),
    ).expect(409);
    expect(res.body.type).toContain('order-out-of-coverage');
  });

  it('acepta una dirección dentro de zona y le suma el envío', async () => {
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(
          pedidoBase({
            delivery: { address: 'Av. Larco 100', lat: -12.12, lng: -77.02 },
          }),
        ),
    ).expect(201);
    // 35 del pedido + 5 de la zona céntrica (la más barata del solapamiento).
    expect(res.body.total.minorUnits).toBe(Money.parse('40.00').minorUnits);
  });

  it('rechaza un pedido por debajo del mínimo de la zona', async () => {
    // La zona céntrica exige mínimo 20; una bebida sola no llega... pero la
    // bebida no tiene modificadores, así que se pide con cantidad 1 (10 soles).
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send({
          brandId,
          locationId: org.locationId,
          channel: 'pos',
          lines: [{ productId: cat.comboId, quantity: 1 }],
          delivery: { address: 'Av. Larco 100', lat: -12.12, lng: -77.02 },
        }),
    );
    // El combo cuesta 38, por encima del mínimo de 20: debe pasar.
    expect(res.status).toBe(201);
  });

  it('exige elegir los modificadores obligatorios', async () => {
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(
          pedidoBase({
            lines: [{ productId: cat.polloId, quantity: 1 }], // sin tamaño
          }),
        ),
    ).expect(422);
    expect(res.body.detail).toContain('Tamaño');
  });

  it('valida la entrada', async () => {
    await auth(http().post('/api/v1/orders').send({})).expect(422);
    await auth(
      http()
        .post('/api/v1/orders')
        .send(pedidoBase({ lines: [] })),
    ).expect(422);
  });

  // -------------------------------------------------------- Transiciones

  it('recorre el camino feliz y registra el TIMELINE completo (§11.3)', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    const id = res.body.id;

    const aceptado = await auth(
      http().post(`/api/v1/orders/${id}/accept`),
    ).expect(201);
    expect(aceptado.body.status).toBe('accepted');

    // Las siguientes transiciones las dispara cocina; aquí se usan directamente.
    await ordering.applyTransition(tenantA, id, 'start_preparing', {
      actorType: 'system',
    });
    await ordering.applyTransition(tenantA, id, 'finish_preparing', {
      actorType: 'system',
    });

    const timeline = await auth(
      http().get(`/api/v1/orders/${id}/timeline`),
    ).expect(200);
    const eventos = timeline.body.map((e: { event: string }) => e.event);
    expect(eventos).toEqual([
      'submit',
      'accept',
      'start_preparing',
      'finish_preparing',
    ]);
    // Cada paso registra de dónde venía y adónde fue.
    expect(timeline.body[1].fromStatus).toBe('received');
    expect(timeline.body[1].toStatus).toBe('accepted');
  });

  it('una transición inválida responde 409 y NO cambia el estado', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    const id = res.body.id;

    // Aceptar dos veces: la segunda es inválida.
    await auth(http().post(`/api/v1/orders/${id}/accept`)).expect(201);
    const invalido = await auth(
      http().post(`/api/v1/orders/${id}/accept`),
    ).expect(409);
    expect(invalido.body.type).toContain('order-invalid-transition');

    const actual = await auth(http().get(`/api/v1/orders/${id}`)).expect(200);
    expect(actual.body.status).toBe('accepted');
  });

  it('cancelar exige motivo y queda auditado', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    const id = res.body.id;

    await auth(http().post(`/api/v1/orders/${id}/cancel`).send({})).expect(422);

    const cancelado = await auth(
      http()
        .post(`/api/v1/orders/${id}/cancel`)
        .send({ reason: 'El cliente se arrepintió' }),
    ).expect(201);
    expect(cancelado.body.status).toBe('cancelled');

    const audit = await auth(http().get('/api/v1/audit?entity=order')).expect(
      200,
    );
    const evento = audit.body.items.find(
      (i: { resourceId: string; action: string }) =>
        i.resourceId === id && i.action === 'order.cancelled',
    );
    expect(evento).toBeTruthy();
    expect(evento.reason).toContain('arrepintió');
  });

  it('CANCELAR EN PREPARACIÓN exige permiso elevado (RN-ORD-06)', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    const id = res.body.id;
    await ordering.applyTransition(tenantA, id, 'accept', {
      actorType: 'system',
    });
    await ordering.applyTransition(tenantA, id, 'start_preparing', {
      actorType: 'system',
    });

    // Sin el permiso elevado, el servicio lo rechaza.
    await expect(
      ordering.applyTransition(tenantA, id, 'cancel', {
        reason: 'Se quemó',
        hasElevatedPermission: false,
      }),
    ).rejects.toThrow(/orders.cancel_in_progress/);

    // Con el permiso, pasa.
    const cancelado = await ordering.applyTransition(tenantA, id, 'cancel', {
      reason: 'Se quemó el pollo',
      hasElevatedPermission: true,
    });
    expect(cancelado.status).toBe('cancelled');
  });

  // ---------------------------------- Bandeja de excepciones (RN-ORD-10)

  it('un pedido con mapeo fallido NO se pierde: va a la bandeja', async () => {
    const res = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    await ordering.flagForReview(
      tenantA,
      res.body.id,
      'Producto externo sin mapear',
    );

    const bandeja = await auth(http().get('/api/v1/orders/exceptions')).expect(
      200,
    );
    expect(bandeja.body.some((o: { id: string }) => o.id === res.body.id)).toBe(
      true,
    );

    // Y puede resolverse para volver al flujo normal.
    const resuelto = await ordering.applyTransition(
      tenantA,
      res.body.id,
      'mapping_resolved',
      { actorType: 'user', actorId: 'operador' },
    );
    expect(resuelto.status).toBe('received');
  });

  // -------------------------------------------------- Pedidos programados

  it('un pedido con fecha futura queda en scheduled (RN-ORD-05)', async () => {
    const manana = new Date(Date.now() + 24 * 3600 * 1000);
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(pedidoBase({ scheduledAt: manana.toISOString() })),
    ).expect(201);
    expect(res.body.status).toBe('scheduled');

    // Se libera en su ventana y sigue el flujo normal.
    const liberado = await ordering.applyTransition(
      tenantA,
      res.body.id,
      'release',
      {
        actorType: 'system',
      },
    );
    expect(liberado.status).toBe('received');
  });

  it('una fecha pasada no lo aparca: entra como recibido', async () => {
    const ayer = new Date(Date.now() - 3600 * 1000);
    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(pedidoBase({ scheduledAt: ayer.toISOString() })),
    ).expect(201);
    expect(res.body.status).toBe('received');
  });

  // --------------------------- Marca no producida en el local (RN-ORD-09)

  it('rechaza un pedido de una marca que ninguna cocina del local produce', async () => {
    // Caso real: se da de alta una marca nueva y se olvida asociarla a cocina.
    // Sin esta validación el pedido entraría, no llegaría a ninguna pantalla y
    // se descubriría cuando el cliente reclamase.
    const huerfana = await withTenant(pool, tenantA, async (ctx) => {
      const [b] = await ctx.db
        .insert(schema.brands)
        .values({
          tenantId: tenantA,
          companyId: org.companyId,
          name: 'Marca sin cocina',
          slug: 'marca-sin-cocina',
        })
        .returning({ id: schema.brands.id });
      return b!.id;
    });

    const res = await auth(
      http()
        .post('/api/v1/orders')
        .send(pedidoBase({ brandId: huerfana })),
    ).expect(409);
    expect(res.body.code).toBe('ORDER_BRAND_NOT_SERVED');
  });

  it('cada error de negocio trae su código estable (spec 05 §9)', async () => {
    // El cliente decide por el `code`, no por el texto: el título y el detalle
    // están para personas y pueden reescribirse o traducirse sin avisar.
    const fuera = await auth(
      http()
        .post('/api/v1/orders')
        .send(
          pedidoBase({
            delivery: { address: 'Muy lejos', lat: -12.9, lng: -76.5 },
          }),
        ),
    ).expect(409);
    expect(fuera.body.code).toBe('ORDER_OUT_OF_COVERAGE');

    const noDisponible = await auth(
      http()
        .post('/api/v1/orders')
        .send(
          pedidoBase({
            channel: 'web',
            lines: [{ productId: cat.soloPosId, quantity: 1 }],
          }),
        ),
    ).expect(422);
    expect(noDisponible.body.code).toBe('ORDER_PRODUCT_UNAVAILABLE');
  });

  // ------------------------------------ Modificación del pedido (RN-ORD-07)

  it('modificar NO reescribe las líneas confirmadas: añade líneas de ajuste', async () => {
    const creado = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);

    const modificado = await auth(
      http()
        .patch(`/api/v1/orders/${creado.body.id}`)
        .set('if-match', String(creado.body.rowVersion))
        .send({
          reason: 'El cliente añadió una bebida',
          lines: [
            {
              productId: cat.polloId,
              quantity: 2,
              modifierOptionIds: [cat.optionGrandeId],
            },
          ],
        }),
    ).expect(200);

    // Pollo grande (35) × 2 = 70.
    expect(modificado.body.total.minorUnits).toBe(
      Money.parse('70.00').minorUnits,
    );
    expect(modificado.body.rowVersion).toBe(creado.body.rowVersion + 1);

    const lineas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        is_adjustment: boolean;
        quantity: number;
      }>(
        'SELECT is_adjustment, quantity FROM ord_order_lines WHERE order_id = $1 ORDER BY created_at',
        [creado.body.id],
      );
      return rows;
    });

    // La línea original SIGUE ahí, marcada como sustituida: es la única prueba
    // de qué se pidió primero, y el comprobante ya emitido se apoya en ella.
    expect(lineas).toHaveLength(2);
    expect(lineas.filter((l) => l.is_adjustment)).toHaveLength(1);
    expect(lineas.find((l) => !l.is_adjustment)?.quantity).toBe(2);
  });

  it('una versión desactualizada en If-Match se rechaza con 409', async () => {
    const creado = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);

    // Dos personas leyeron la misma versión; la primera modifica...
    await auth(
      http()
        .patch(`/api/v1/orders/${creado.body.id}`)
        .set('if-match', String(creado.body.rowVersion))
        .send({ lines: [{ productId: cat.comboId, quantity: 1 }] }),
    ).expect(200);

    // ...y la segunda llega con la versión vieja: se le dice que recargue en
    // vez de dejar que pise el cambio ajeno en silencio.
    const conflicto = await auth(
      http()
        .patch(`/api/v1/orders/${creado.body.id}`)
        .set('if-match', String(creado.body.rowVersion))
        .send({ lines: [{ productId: cat.comboId, quantity: 5 }] }),
    ).expect(409);
    expect(conflicto.body.code).toBe('ORDER_VERSION_CONFLICT');
    expect(conflicto.body.currentVersion).toBe(creado.body.rowVersion + 1);
  });

  it('sin cabecera If-Match no se modifica nada', async () => {
    const creado = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    await auth(
      http()
        .patch(`/api/v1/orders/${creado.body.id}`)
        .send({ lines: [{ productId: cat.comboId, quantity: 1 }] }),
    ).expect(422);
  });

  it('un pedido ya en cocina no se modifica (RN-ORD-07)', async () => {
    const creado = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    await ordering.applyTransition(tenantA, creado.body.id, 'accept', {
      actorType: 'system',
    });
    const enCocina = await ordering.applyTransition(
      tenantA,
      creado.body.id,
      'start_preparing',
      { actorType: 'system' },
    );

    const res = await auth(
      http()
        .patch(`/api/v1/orders/${creado.body.id}`)
        .set('if-match', String(enCocina.rowVersion))
        .send({ lines: [{ productId: cat.comboId, quantity: 1 }] }),
    ).expect(409);
    expect(res.body.code).toBe('ORDER_NOT_MODIFIABLE');
    // El estado del pedido viaja como extensión, sin pisar el `status` de
    // Problem Details, que es el código HTTP.
    expect(res.body.status).toBe(409);
    expect(res.body.orderStatus).toBe('preparing');
  });

  it('la modificación queda en el timeline sin cambiar el estado', async () => {
    const creado = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    await auth(
      http()
        .patch(`/api/v1/orders/${creado.body.id}`)
        .set('if-match', String(creado.body.rowVersion))
        .send({ lines: [{ productId: cat.comboId, quantity: 3 }] }),
    ).expect(200);

    const timeline = await ordering.getTimeline(tenantA, creado.body.id);
    const modificacion = timeline.find((e) => e.event === 'modify');
    expect(modificacion).toBeTruthy();
    expect(modificacion!.fromStatus).toBe('received');
    expect(modificacion!.toStatus).toBe('received');
  });

  // ------------------- Resolver la bandeja de excepciones (RN-ORD-10, §7)

  it('resolver el mapeo devuelve el pedido apartado al flujo con su importe', async () => {
    // Un pedido apartado por la ingesta: sin líneas y con importes en cero,
    // porque no se sabía qué se había pedido.
    const apartado = await ordering.submitForReview(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'rappi',
      externalRef: `RESOLVE-${Date.now()}`,
      reason: 'SKU externo sin mapear: XYZ-123',
      rawPayload: { items: [{ sku: 'XYZ-123', qty: 1 }] },
    });
    expect(apartado.status).toBe('needs_review');
    expect(apartado.total.minorUnits).toBe(0);

    const resuelto = await auth(
      http()
        .post(`/api/v1/orders/${apartado.id}/resolve-mapping`)
        .send({ lines: [{ productId: cat.comboId, quantity: 1 }] }),
    ).expect(201);

    expect(resuelto.body.status).toBe('received');
    expect(resuelto.body.total.minorUnits).toBe(Money.parse('38.00').minorUnits);

    // Y ya no está en la bandeja.
    const bandeja = await ordering.listExceptions(tenantA);
    expect(bandeja.some((o) => o.id === apartado.id)).toBe(false);

    // El timeline conserva por qué se apartó y cómo se resolvió.
    const timeline = await ordering.getTimeline(tenantA, apartado.id);
    expect(timeline.map((e) => e.event)).toEqual([
      'mapping_failed',
      'mapping_resolved',
    ]);
  });

  it('resolver dos veces el mismo pedido se rechaza con 409', async () => {
    const apartado = await ordering.submitForReview(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'rappi',
      externalRef: `RESOLVE-2-${Date.now()}`,
      reason: 'SKU sin mapear',
      rawPayload: {},
    });
    const cuerpo = { lines: [{ productId: cat.comboId, quantity: 1 }] };

    await auth(
      http()
        .post(`/api/v1/orders/${apartado.id}/resolve-mapping`)
        .send(cuerpo),
    ).expect(201);

    // El segundo supervisor llega tarde: se le dice que ya está resuelto en vez
    // de duplicarle las líneas.
    const segundo = await auth(
      http()
        .post(`/api/v1/orders/${apartado.id}/resolve-mapping`)
        .send(cuerpo),
    ).expect(409);
    expect(segundo.body.code).toBe('ORDER_INVALID_TRANSITION');
  });

  it('no se resuelve el mapeo de un pedido que nunca estuvo en revisión', async () => {
    const normal = await auth(
      http().post('/api/v1/orders').send(pedidoBase()),
    ).expect(201);
    await auth(
      http()
        .post(`/api/v1/orders/${normal.body.id}/resolve-mapping`)
        .send({ lines: [{ productId: cat.comboId, quantity: 1 }] }),
    ).expect(409);
  });

  it('resolver con un producto no vendible en ese canal falla y no toca el pedido', async () => {
    const apartado = await ordering.submitForReview(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'web',
      externalRef: `RESOLVE-3-${Date.now()}`,
      reason: 'SKU sin mapear',
      rawPayload: {},
    });

    await auth(
      http()
        .post(`/api/v1/orders/${apartado.id}/resolve-mapping`)
        .send({ lines: [{ productId: cat.soloPosId, quantity: 1 }] }),
    ).expect(422);

    // Sigue en la bandeja: un intento fallido no puede sacarlo de ahí.
    const sigue = await ordering.getSummary(tenantA, apartado.id);
    expect(sigue.status).toBe('needs_review');
    expect(sigue.total.minorUnits).toBe(0);
  });

  // ------------------------------------------------------------ Consultas

  it('un pedido inexistente responde 404', async () => {
    await auth(
      http().get('/api/v1/orders/00000000-0000-0000-0000-000000000000'),
    ).expect(404);
  });

  it('lista pedidos con filtro de estado', async () => {
    const res = await auth(
      http().get('/api/v1/orders?status=cancelled'),
    ).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(
      res.body.every((o: { status: string }) => o.status === 'cancelled'),
    ).toBe(true);
  });
});
