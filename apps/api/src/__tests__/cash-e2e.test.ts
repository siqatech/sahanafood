import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Money } from '@sahana/domain';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { OrderingService } from '../modules/ordering/index.js';
import { CashService } from '../modules/cash/index.js';
import { DeviceService, UserAdminService } from '../modules/identity/index.js';
import { CashEventHandlers, CASH_CONSUMER } from '../modules/cash/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Caja, arqueo y descuentos (spec 06, T4.17/T4.18/T4.19).
 *
 * Es la parte del sistema donde un fallo no aparece en un log sino en una caja
 * que no cuadra al final del turno. Las pruebas están escritas alrededor de eso:
 * cada una corresponde a una forma concreta en que el dinero se pierde.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const PIN_SUPERVISOR = '4821';
/** El del dueño: existe desde F3 y sirve para probar la AUTOaprobación. */
const PIN_SUPERVISOR_DUENO = PIN_SUPERVISOR;
const PIN_CAJERA = '1357';
const PIN_COCINERO = '2468';

suite('Caja: sesiones, arqueo y descuentos', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let ownerId = '';
  /** Quien cierra la caja. NO es quien la firma: ese es el control entero. */
  let cajeroId = '';
  /** Tiene PIN y no tiene `cash.approve_difference`: un PIN no es un permiso. */
  let cocineroId = '';
  /** El que FIRMA los descuentos: el dueño los pide, otro los aprueba. */
  let supervisorId = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let cash: CashService;
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
    cash = app.get(CashService);
    ordering = app.get(OrderingService);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Caja Tenant',
      planCode: 'growth',
      owner: {
        email: 'caja-a@sahana.test',
        password: 'password-caja-a-1',
        fullName: 'Dueño Caja',
      },
    });
    tenantA = a.tenantId;
    ownerId = a.ownerUserId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0];
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    // PIN del supervisor. `mustChange: false` porque un PIN que aún debe
    // cambiarse no sirve para autorizar (lo rechaza
    // `verifyPinForSensitiveAction`), y aquí lo que se prueba es la
    // autorización, no el alta.
    await app
      .get(DeviceService)
      .setPin(tenantA, ownerId, PIN_SUPERVISOR, { mustChange: false });

    // Un cajero de verdad: hasta ahora el dueño cerraba la caja Y firmaba su
    // propio descuadre, que es exactamente lo que la regla prohíbe.
    const usuarios = app.get(UserAdminService);
    cajeroId = (
      await usuarios.create(tenantA, {
        email: 'cajera-caja@sahana.test',
        fullName: 'Cajera del turno',
        password: 'password-cajera-1',
        roleCode: 'cashier',
      })
    ).id;
    cocineroId = (
      await usuarios.create(tenantA, {
        email: 'cocinero-caja@sahana.test',
        fullName: 'Cocinero del turno',
        password: 'password-cocinero',
        roleCode: 'cook',
      })
    ).id;
    await app
      .get(DeviceService)
      .setPin(tenantA, cajeroId, PIN_CAJERA, { mustChange: false });
    supervisorId = (
      await usuarios.create(tenantA, {
        email: 'supervisora-caja@sahana.test',
        fullName: 'Supervisora del turno',
        password: 'password-supervisora',
        roleCode: 'supervisor',
      })
    ).id;
    await app
      .get(DeviceService)
      .setPin(tenantA, cocineroId, PIN_COCINERO, { mustChange: false });
    await app
      .get(DeviceService)
      .setPin(tenantA, supervisorId, PIN_SUPERVISOR, { mustChange: false });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'caja-a@sahana.test', password: 'password-caja-a-1' })
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
  const soles = (valor: string) => Money.parse(valor).minorUnits;

  /** Sesión nueva sobre una terminal distinta en cada prueba. */
  let terminal = 0;
  const abrirCaja = (fondo = '100.00') =>
    cash.open(tenantA, {
      locationId: org.locationId,
      deviceId: `00000000-0000-4000-8000-${String(++terminal).padStart(12, '0')}`,
      openedBy: ownerId,
      openingFloatMinor: soles(fondo),
    });

  // ------------------------------------------------- Apertura (RN-POS-01)

  it('abre una sesión con su fondo y queda auditada', async () => {
    const sesion = await abrirCaja('150.00');
    expect(sesion.status).toBe('open');
    expect(sesion.openingFloat.minorUnits).toBe(soles('150.00'));

    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ resource_id: string }>(
        "SELECT resource_id FROM audit_log WHERE action = 'cash.session_opened'",
      );
      return rows.map((r) => r.resource_id);
    });
    expect(auditoria).toContain(sesion.id);
  });

  it('NO permite dos cajas abiertas en la misma terminal', async () => {
    // Con dos sesiones vivas es imposible saber a cuál pertenece un cobro, y
    // el descuadre aparece al cerrar la primera.
    const deviceId = '00000000-0000-4000-8000-0000000000ff';
    await cash.open(tenantA, {
      locationId: org.locationId,
      deviceId,
      openedBy: ownerId,
    });
    await expect(
      cash.open(tenantA, {
        locationId: org.locationId,
        deviceId,
        openedBy: ownerId,
      }),
    ).rejects.toThrow(/ya tiene una sesión abierta/);
  });

  it('sin caja abierta no se puede cobrar (RN-POS-01)', async () => {
    await expect(
      cash.assertOpenSession(tenantA, {
        deviceId: '00000000-0000-4000-8000-0000000000aa',
      }),
    ).rejects.toThrow(/abre caja antes de cobrar/);
  });

  // ---------------------------------------------------------- Movimientos

  it('el esperado se calcula sumando movimientos, no de un acumulado', async () => {
    const sesion = await abrirCaja('100.00');

    await cash.addMovement(tenantA, sesion.id, {
      kind: 'sale',
      amountMinor: soles('50.00'),
    });
    await cash.addMovement(tenantA, sesion.id, {
      kind: 'tip',
      amountMinor: soles('5.00'),
    });
    await cash.addMovement(tenantA, sesion.id, {
      kind: 'cash_out',
      amountMinor: soles('20.00'),
      reason: 'Compra de hielo',
    });

    const resumen = await cash.summary(tenantA, sesion.id);
    // 100 fondo + 50 venta + 5 propina − 20 salida = 135.
    expect(resumen.expectedCash.minorUnits).toBe(soles('135.00'));
    expect(resumen.byKind.sale.minorUnits).toBe(soles('50.00'));
    expect(resumen.byKind.cash_out.minorUnits).toBe(soles('20.00'));
    expect(resumen.movements).toBe(3);
  });

  it('las ventas con TARJETA no cuentan como efectivo en gaveta', async () => {
    // Contarlas produciría un faltante del tamaño exacto de lo cobrado con
    // tarjeta, y el cajero pasaría el turno buscando dinero que nunca estuvo.
    const sesion = await abrirCaja('100.00');
    await cash.addMovement(tenantA, sesion.id, {
      kind: 'sale',
      amountMinor: soles('80.00'),
      method: 'card',
    });

    const resumen = await cash.summary(tenantA, sesion.id);
    expect(resumen.expectedCash.minorUnits).toBe(soles('100.00'));
    // Pero sí se registran para cuadrar el turno completo.
    expect(resumen.byMethod.card!.minorUnits).toBe(soles('80.00'));
  });

  it('una salida de efectivo SIN motivo se rechaza', async () => {
    // Sacar dinero sin decir por qué es lo que hace imposible auditar una caja.
    const sesion = await abrirCaja();
    await expect(
      cash.addMovement(tenantA, sesion.id, {
        kind: 'cash_out',
        amountMinor: soles('10.00'),
      }),
    ).rejects.toThrow(/exige motivo/);
  });

  it('un importe negativo se rechaza: el signo lo da el TIPO', async () => {
    // Un importe negativo con un tipo de salida da un doble negativo que nadie
    // ve hasta el arqueo.
    const sesion = await abrirCaja();
    await expect(
      cash.addMovement(tenantA, sesion.id, {
        kind: 'sale',
        amountMinor: -500,
      }),
    ).rejects.toThrow(/debe ser positivo/);
  });

  it('el mismo pedido NO se cobra dos veces en la caja', async () => {
    const sesion = await abrirCaja();
    const pedido = await ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [{ productId: cat.comboId, quantity: 1 }],
    });

    await cash.addMovement(tenantA, sesion.id, {
      kind: 'sale',
      amountMinor: soles('38.00'),
      orderId: pedido.id,
    });
    await expect(
      cash.addMovement(tenantA, sesion.id, {
        kind: 'sale',
        amountMinor: soles('38.00'),
        orderId: pedido.id,
      }),
    ).rejects.toThrow(/ya se cobró/);
  });

  it('los movimientos NO se pueden editar ni borrar', async () => {
    // Un registro corregible no sirve para arquear: quien se lleva dinero de
    // la caja lo primero que hace es corregir el registro.
    const sesion = await abrirCaja();
    const mov = await cash.addMovement(tenantA, sesion.id, {
      kind: 'sale',
      amountMinor: soles('25.00'),
    });

    await expect(
      withTenant(pool, tenantA, async ({ client }) => {
        await client.query(
          'UPDATE cash_movements SET amount = 1 WHERE id = $1',
          [mov.id],
        );
      }),
    ).rejects.toThrow(/permission denied|permiso denegado/i);

    await expect(
      withTenant(pool, tenantA, async ({ client }) => {
        await client.query('DELETE FROM cash_movements WHERE id = $1', [
          mov.id,
        ]);
      }),
    ).rejects.toThrow(/permission denied|permiso denegado/i);
  });

  // ------------------------------------------------- Arqueo (RN-POS-02)

  it('cierra sin diferencia sin pedir nada a nadie', async () => {
    const sesion = await abrirCaja('100.00');
    await cash.addMovement(tenantA, sesion.id, {
      kind: 'sale',
      amountMinor: soles('40.00'),
    });

    const cerrada = await cash.closeSession(tenantA, sesion.id, {
      declaredCashMinor: soles('140.00'),
      closedBy: ownerId,
    });

    expect(cerrada.status).toBe('closed');
    expect(cerrada.difference!.minorUnits).toBe(0);
    expect(cerrada.approvedBy).toBeNull();
  });

  it('una diferencia SIN motivo se rechaza', async () => {
    const sesion = await abrirCaja('100.00');
    const res = await auth(
      http()
        .post(`/api/v1/cash-sessions/${sesion.id}/close`)
        .send({ declaredCashMinor: soles('90.00') }),
    ).expect(422);

    expect(res.body.code).toBe('CASH_DIFFERENCE_REQUIRES_APPROVAL');
    expect(res.body.difference.minorUnits).toBe(soles('-10.00'));
    // La sesión NO se cerró: un cierre a medias dejaría un arqueo sin firmar.
    expect((await cash.getSession(tenantA, sesion.id)).status).toBe('open');
  });

  it('una diferencia con motivo pero SIN PIN de supervisor se rechaza', async () => {
    const sesion = await abrirCaja('100.00');
    await expect(
      cash.closeSession(tenantA, sesion.id, {
        declaredCashMinor: soles('95.00'),
        closedBy: cajeroId,
        differenceReason: 'Faltan 5 soles, no sé por qué',
      }),
    ).rejects.toThrow(/PIN de un supervisor/);
  });

  it('un PIN de supervisor INCORRECTO no cierra la caja', async () => {
    const sesion = await abrirCaja('100.00');
    await expect(
      cash.closeSession(tenantA, sesion.id, {
        declaredCashMinor: soles('95.00'),
        closedBy: cajeroId,
        differenceReason: 'Faltante',
        supervisorId: ownerId,
        supervisorPin: '0000',
      }),
    ).rejects.toThrow();
    expect((await cash.getSession(tenantA, sesion.id)).status).toBe('open');
  });

  it('EL CAJERO NO SE FIRMA SU PROPIO DESCUADRE, aunque sepa su PIN', async () => {
    // Era el agujero: bastaba con poner el propio id y el propio PIN. Un
    // control de dos personas que una sola persona puede satisfacer no es un
    // control, y el faltante de caja es justo lo que se firma solo.
    const sesion = await abrirCaja('100.00');
    await expect(
      cash.closeSession(tenantA, sesion.id, {
        declaredCashMinor: soles('60.00'),
        closedBy: cajeroId,
        differenceReason: 'Faltan 40 soles',
        supervisorId: cajeroId,
        supervisorPin: PIN_CAJERA,
      }),
    ).rejects.toThrow(/hacen falta dos personas/i);
    expect((await cash.getSession(tenantA, sesion.id)).status).toBe('open');
  });

  it('UN PIN NO ES UN PERMISO: el del cocinero no firma un descuadre', async () => {
    // Segunda mitad del mismo agujero: cualquiera con PIN servía. El cocinero
    // tiene PIN —lo necesita para marcar preparación— y no responde de la caja.
    const sesion = await abrirCaja('100.00');
    await expect(
      cash.closeSession(tenantA, sesion.id, {
        declaredCashMinor: soles('60.00'),
        closedBy: cajeroId,
        differenceReason: 'Faltan 40 soles',
        supervisorId: cocineroId,
        supervisorPin: PIN_COCINERO,
      }),
    ).rejects.toThrow(/cash\.approve_difference/);
    expect((await cash.getSession(tenantA, sesion.id)).status).toBe('open');
  });

  it('con motivo y PIN correcto cierra, registra quién aprobó y AUDITA', async () => {
    const sesion = await abrirCaja('100.00');
    await cash.addMovement(tenantA, sesion.id, {
      kind: 'sale',
      amountMinor: soles('60.00'),
    });

    const cerrada = await cash.closeSession(tenantA, sesion.id, {
      declaredCashMinor: soles('155.00'),
      closedBy: cajeroId,
      differenceReason: 'Se dio un vuelto de más al cliente de la mesa 3',
      supervisorId: ownerId,
      supervisorPin: PIN_SUPERVISOR,
    });

    expect(cerrada.status).toBe('closed');
    expect(cerrada.expectedCash!.minorUnits).toBe(soles('160.00'));
    expect(cerrada.difference!.minorUnits).toBe(soles('-5.00'));
    expect(cerrada.approvedBy).toBe(ownerId);

    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        resource_id: string;
        reason: string;
      }>(
        "SELECT resource_id, reason FROM audit_log WHERE action = 'cash.session_closed_with_difference'",
      );
      return rows;
    });
    const suya = auditoria.find((a) => a.resource_id === sesion.id);
    expect(
      suya,
      'el cierre descuadrado no dejó rastro en auditoría',
    ).toBeTruthy();
    expect(suya!.reason).toContain('vuelto de más');
  });

  it('el esperado se CONGELA al cerrar: un movimiento tardío no lo reescribe', async () => {
    const sesion = await abrirCaja('100.00');
    const cerrada = await cash.closeSession(tenantA, sesion.id, {
      declaredCashMinor: soles('100.00'),
      closedBy: ownerId,
    });
    expect(cerrada.expectedCash!.minorUnits).toBe(soles('100.00'));

    // Y ya no se aceptan movimientos: descuadrarían un arqueo ya firmado.
    await expect(
      cash.addMovement(tenantA, sesion.id, {
        kind: 'sale',
        amountMinor: soles('10.00'),
      }),
    ).rejects.toThrow(/ya está cerrada/);
  });

  it('cerrar dos veces la misma sesión se rechaza', async () => {
    const sesion = await abrirCaja('50.00');
    await cash.closeSession(tenantA, sesion.id, {
      declaredCashMinor: soles('50.00'),
      closedBy: ownerId,
    });
    await expect(
      cash.closeSession(tenantA, sesion.id, {
        declaredCashMinor: soles('50.00'),
        closedBy: ownerId,
      }),
    ).rejects.toThrow(/ya se cerró/);
  });

  it('tras cerrar se puede abrir otra caja en la misma terminal', async () => {
    const deviceId = '00000000-0000-4000-8000-0000000000bb';
    const primera = await cash.open(tenantA, {
      locationId: org.locationId,
      deviceId,
      openedBy: ownerId,
    });
    await cash.closeSession(tenantA, primera.id, {
      declaredCashMinor: 0,
      closedBy: ownerId,
    });
    const segunda = await cash.open(tenantA, {
      locationId: org.locationId,
      deviceId,
      openedBy: ownerId,
    });
    expect(segunda.id).not.toBe(primera.id);
  });

  // ------------------------------------------ Descuentos (RN-T08, RN-POS-03)

  /** Pedido de un combo: S/ 38,00, sin modificadores obligatorios. */
  const pedidoDe = () =>
    ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [{ productId: cat.comboId, quantity: 1 }],
    });

  it('un descuento bajo el umbral se aplica sin PIN', async () => {
    const pedido = await pedidoDe();
    const res = await auth(
      http()
        .post(`/api/v1/orders/${pedido.id}/discount`)
        .send({ bps: 1000, reason: 'Cliente frecuente' }),
    ).expect(201);

    // 38 − 10 % = 34,20.
    expect(res.body.total.minorUnits).toBe(soles('34.20'));
  });

  it('un descuento SOBRE el umbral exige PIN de supervisor', async () => {
    const pedido = await pedidoDe();
    const res = await auth(
      http()
        .post(`/api/v1/orders/${pedido.id}/discount`)
        .send({ bps: 2500, reason: 'Reclamo del cliente' }),
    ).expect(422);

    expect(res.body.code).toBe('DISCOUNT_REQUIRES_APPROVAL');
    expect(res.body.totalBps).toBe(2500);
    // Y el pedido NO cambió.
    const sigue = await ordering.getSummary(tenantA, pedido.id);
    expect(sigue.total.minorUnits).toBe(soles('38.00'));
  });

  it('con PIN correcto el descuento pasa y queda AUDITADO como aprobado', async () => {
    const pedido = await pedidoDe();
    const res = await auth(
      http().post(`/api/v1/orders/${pedido.id}/discount`).send({
        bps: 2500,
        reason: 'Pedido llegó tarde por nuestra culpa',
        // Otra persona: el token es del dueño, así que el dueño PIDE. Firmar
        // uno mismo su propio descuento es el fraude que la regla evita.
        supervisorId,
        supervisorPin: PIN_SUPERVISOR,
      }),
    ).expect(201);

    expect(res.body.total.minorUnits).toBe(soles('28.50'));

    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        resource_id: string;
        data: { approvedBy: string };
      }>(
        "SELECT resource_id, data FROM audit_log WHERE action = 'order.discount_approved'",
      );
      return rows;
    });
    const suya = auditoria.find((a) => a.resource_id === pedido.id);
    expect(suya).toBeTruthy();
    expect(suya!.data.approvedBy).toBe(supervisorId);
  });

  it('un PIN incorrecto NO aplica el descuento', async () => {
    const pedido = await pedidoDe();
    // 403 y no 422: no es que el dato esté mal formado, es que no tienes
    // autorización. La respuesta trae los intentos restantes antes del bloqueo.
    const res = await auth(
      http().post(`/api/v1/orders/${pedido.id}/discount`).send({
        bps: 3000,
        reason: 'Intento sin autorización',
        supervisorId,
        supervisorPin: '9999',
      }),
    ).expect(403);
    expect(res.body.remainingAttempts).toBeGreaterThanOrEqual(0);

    const sigue = await ordering.getSummary(tenantA, pedido.id);
    expect(sigue.total.minorUnits).toBe(soles('38.00'));
  });

  it('NADIE FIRMA SU PROPIO DESCUENTO, ni con su PIN bueno', async () => {
    // El mismo agujero que en caja: bastaba con poner el propio id y el propio
    // PIN. Un descuento del 25 % «autorizado» por quien lo aplica no está
    // autorizado por nadie.
    const pedido = await pedidoDe();
    await auth(
      http().post(`/api/v1/orders/${pedido.id}/discount`).send({
        bps: 2500,
        reason: 'Me lo apruebo yo',
        supervisorId: ownerId,
        supervisorPin: PIN_SUPERVISOR_DUENO,
      }),
    ).expect(403);

    const sigue = await ordering.getSummary(tenantA, pedido.id);
    expect(sigue.total.minorUnits).toBe(soles('38.00'));
  });

  it('EL PIN DE LA CAJERA no firma un descuento: no es su decisión', async () => {
    const pedido = await pedidoDe();
    const res = await auth(
      http().post(`/api/v1/orders/${pedido.id}/discount`).send({
        bps: 2500,
        reason: 'Firmado por quien no puede',
        supervisorId: cajeroId,
        supervisorPin: PIN_CAJERA,
      }),
    ).expect(403);
    expect(res.body.detail).toContain('orders.discount');
  });

  it('EL FRAUDE ENCADENADO: dos descuentos pequeños acumulan y piden PIN', async () => {
    // Tres descuentos del 10 % con umbral del 15 % son un 30 % sin que nadie
    // firme nada. El acumulado se guarda en el pedido y se compara siempre.
    const pedido = await pedidoDe();

    await auth(
      http()
        .post(`/api/v1/orders/${pedido.id}/discount`)
        .send({ bps: 1000, reason: 'Primero' }),
    ).expect(201);

    const segundo = await auth(
      http()
        .post(`/api/v1/orders/${pedido.id}/discount`)
        .send({ bps: 1000, reason: 'Segundo' }),
    ).expect(422);

    expect(
      segundo.body.code,
      'el segundo descuento del 10 % pasó sin aprobación pese a acumular 20 %',
    ).toBe('DISCOUNT_REQUIRES_APPROVAL');
    expect(segundo.body.totalBps).toBe(2000);
  });

  it('todo descuento exige motivo, aunque sea pequeño', async () => {
    const pedido = await pedidoDe();
    await auth(
      http().post(`/api/v1/orders/${pedido.id}/discount`).send({ bps: 500 }),
    ).expect(422);
  });

  it('no se descuenta un pedido que ya está en cocina', async () => {
    // Descontar sobre un pedido cobrado sería reescribir un cobro hecho; eso
    // es una nota de crédito, no un descuento (RN-POS-05).
    const pedido = await pedidoDe();
    await ordering.applyTransition(tenantA, pedido.id, 'accept', {
      actorType: 'system',
    });
    await ordering.applyTransition(tenantA, pedido.id, 'start_preparing', {
      actorType: 'system',
    });

    const res = await auth(
      http()
        .post(`/api/v1/orders/${pedido.id}/discount`)
        .send({ bps: 500, reason: 'Tarde' }),
    ).expect(409);
    expect(res.body.code).toBe('ORDER_NOT_MODIFIABLE');
  });

  it('el descuento queda en el timeline sin cambiar el estado', async () => {
    const pedido = await pedidoDe();
    await auth(
      http()
        .post(`/api/v1/orders/${pedido.id}/discount`)
        .send({ bps: 500, reason: 'Cortesía' }),
    ).expect(201);

    const timeline = await ordering.getTimeline(tenantA, pedido.id);
    const descuento = timeline.find((e) => e.event === 'discount');
    expect(descuento).toBeTruthy();
    expect(descuento!.fromStatus).toBe(descuento!.toStatus);
    expect(descuento!.reason).toBe('Cortesía');
  });
  // ------------------------------------ La venta del mostrador LLEGA a la caja

  /**
   * Drena el outbox por el camino REAL hasta el consumidor de caja.
   *
   * No se llama al handler a mano: lo que había roto antes era justamente el
   * cable —el evento se publicaba y no lo escuchaba nadie—, así que la prueba
   * recorre relay y consumidor como en producción.
   */
  const drenarHaciaCaja = async (): Promise<void> => {
    const handlers = app.get(CashEventHandlers).handlers();
    for (let vuelta = 0; vuelta < 4; vuelta++) {
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
        50,
      );
      if (entregados.length === 0) break;
      for (const mensaje of entregados) {
        await consumeEvent(
          { pool, consumer: CASH_CONSUMER, handlers },
          mensaje as never,
        );
      }
    }
  };

  it('UNA VENTA EN EFECTIVO DEL MOSTRADOR entra en el arqueo', async () => {
    // El fallo que esto cierra: `cash_movements` solo se escribía a mano, así
    // que un turno con ventas en efectivo cerraba con un «esperado» igual al
    // fondo inicial y un sobrante del tamaño exacto de lo vendido. Todos los
    // días, en todos los locales.
    const sesion = await abrirCaja('100.00');

    const venta = await ordering.submitOffline(tenantA, {
      clientId: `01JCAJA0000000000000000${String(++terminal).padStart(3, '0')}`,
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.polloId,
          productName: 'Pollo',
          quantity: 1,
          unitPriceMinor: soles('55.00'),
          lineTotalMinor: soles('55.00'),
        },
      ],
      totalMinor: soles('55.00'),
      paymentMethod: 'cash',
    });
    expect(venta.outcome).not.toBe('duplicate');

    await drenarHaciaCaja();

    const arqueo = await cash.summary(tenantA, sesion.id);
    // Fondo 100 + venta 55 = 155 en la gaveta.
    expect(arqueo.expectedCash.minorUnits).toBe(soles('155.00'));
  });

  it('una venta con TARJETA se registra pero NO mueve la gaveta', async () => {
    // Contarla como efectivo produciría un faltante del tamaño exacto de lo
    // cobrado con tarjeta — el mismo error, con el signo cambiado.
    const sesion = await abrirCaja('100.00');

    await ordering.submitOffline(tenantA, {
      clientId: `01JCAJA1000000000000000${String(++terminal).padStart(3, '0')}`,
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.polloId,
          productName: 'Pollo',
          quantity: 1,
          unitPriceMinor: soles('55.00'),
          lineTotalMinor: soles('55.00'),
        },
      ],
      totalMinor: soles('55.00'),
      paymentMethod: 'card',
    });
    await drenarHaciaCaja();

    const arqueo = await cash.summary(tenantA, sesion.id);
    expect(arqueo.expectedCash.minorUnits).toBe(soles('100.00'));
  });

  it('SIN CAJA ABIERTA la venta no se pierde: entra igual y no revienta nada', async () => {
    // El consumidor no puede fallar por no encontrar turno: tumbarlo dejaría
    // sin procesar los eventos que vienen detrás —cocina, inventario,
    // analítica— por un apunte de caja.
    const venta = await ordering.submitOffline(tenantA, {
      clientId: `01JCAJA2000000000000000${String(++terminal).padStart(3, '0')}`,
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.polloId,
          productName: 'Pollo',
          quantity: 1,
          unitPriceMinor: soles('20.00'),
          lineTotalMinor: soles('20.00'),
        },
      ],
      totalMinor: soles('20.00'),
      paymentMethod: 'cash',
    });
    await expect(drenarHaciaCaja()).resolves.toBeUndefined();
    expect(venta.order.id).toBeTruthy();
  });

  it('reprocesar el evento NO suma la venta dos veces', async () => {
    const sesion = await abrirCaja('100.00');
    await ordering.submitOffline(tenantA, {
      clientId: `01JCAJA3000000000000000${String(++terminal).padStart(3, '0')}`,
      brandId,
      locationId: org.locationId,
      channel: 'pos',
      lines: [
        {
          productId: cat.polloId,
          productName: 'Pollo',
          quantity: 1,
          unitPriceMinor: soles('30.00'),
          lineTotalMinor: soles('30.00'),
        },
      ],
      totalMinor: soles('30.00'),
      paymentMethod: 'cash',
    });
    await drenarHaciaCaja();
    await drenarHaciaCaja();

    const arqueo = await cash.summary(tenantA, sesion.id);
    // 100 + 30, no 100 + 60. Duplicar aquí sería inventar dinero en un turno.
    expect(arqueo.expectedCash.minorUnits).toBe(soles('130.00'));
  });
});
