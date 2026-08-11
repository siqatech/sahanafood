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
  PaymentsService,
  SettlementsService,
  CulqiSandboxProvider,
  MercadoPagoSandboxProvider,
  CULQI_PROVIDER,
  MERCADOPAGO_PROVIDER,
  MAX_REFUND_ATTEMPTS,
} from '../modules/payments/index.js';
import { DeviceService, UserAdminService } from '../modules/identity/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Pagos online (spec 10 parte F5, T5.01–T5.03, ADR-0016).
 *
 * Lo que se prueba aquí es lo que cuesta dinero de verdad, no bugs:
 *
 * · **RN-PAY-01**: el pedido se confirma SOLO por webhook verificado. No hay
 *   endpoint de confirmación, y una firma inválida no mueve nada.
 * · **Webhook duplicado → un solo confirmado.** Las pasarelas reintentan
 *   todas; sin idempotencia se cobra o se confirma dos veces.
 * · **Aviso que llega tarde no desconfirma.** Los reintentos no respetan el
 *   orden: el aviso de `authorized` puede aterrizar después del de `captured`.
 * · **Importe distinto → NO confirma.** Creerse el número del otro lado es
 *   cómodo hasta que llega uno que no es el que se cobró.
 * · **Dos pasarelas distintas por el mismo puerto**, con formatos de firma,
 *   vocabularios y políticas de identificador de evento diferentes.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

/** PIN de quien firma un reembolso grande, y de quien no puede firmarlo. */
const PIN_APROBADORA = '7391';
const PIN_CAJERA = '1357';

const SECRETO_CULQI = 'secreto-culqi-de-prueba-1234';
const SECRETO_MP = 'secreto-mercadopago-de-prueba-1';

suite('Pagos online', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
  let culqi: CulqiSandboxProvider;
  let mercadopago: MercadoPagoSandboxProvider;

  let tokenCulqi = '';
  let tokenMp = '';
  let ownerId = '';
  let supervisorId = '';
  let cajeraId = '';

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
    payments = app.get(PaymentsService);
    settlements = app.get(SettlementsService);
    culqi = app.get(CulqiSandboxProvider);
    mercadopago = app.get(MercadoPagoSandboxProvider);

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Pagos Tenant',
      planCode: 'growth',
      owner: {
        email: 'pay-a@sahana.test',
        password: 'password-pay-a-1',
        fullName: 'Dueño Pagos',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);
    ownerId = a.ownerUserId;
    // Un segundo usuario: la doble aprobación necesita DOS personas de verdad,
    // no la misma con dos sombreros. Y con su ROL y su PIN, porque un id en el
    // cuerpo de la petición lo escribe quien pide: no prueba nada.
    const usuarios = app.get(UserAdminService);
    supervisorId = (
      await usuarios.create(tenantA, {
        email: 'pay-sup@sahana.test',
        fullName: 'Administradora Pagos',
        password: 'password-pagos-sup',
        // `payments.refund` no lo lleva ni el cajero ni el supervisor de sala:
        // devolver dinero se firma arriba.
        roleCode: 'admin',
      })
    ).id;
    // La cajera existe para probar lo contrario: tiene PIN y no puede firmar.
    cajeraId = (
      await usuarios.create(tenantA, {
        email: 'pay-cajera@sahana.test',
        fullName: 'Cajera Pagos',
        password: 'password-pagos-caj',
        roleCode: 'cashier',
      })
    ).id;
    const devices = app.get(DeviceService);
    await devices.setPin(tenantA, supervisorId, PIN_APROBADORA, {
      mustChange: false,
    });
    await devices.setPin(tenantA, cajeraId, PIN_CAJERA, { mustChange: false });

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    const c = await payments.createConnection(tenantA, {
      provider: CULQI_PROVIDER,
      webhookSecret: SECRETO_CULQI,
    });
    tokenCulqi = c.webhookToken;

    // Sin marca: vale para todo el tenant. La resolución por marca se prueba
    // aparte, con una conexión específica que tiene que ganar a esta.
    const m = await payments.createConnection(tenantA, {
      provider: MERCADOPAGO_PROVIDER,
      webhookSecret: SECRETO_MP,
    });
    tokenMp = m.webhookToken;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'pay-a@sahana.test', password: 'password-pay-a-1' })
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

  const vender = async (): Promise<{ id: string; total: string }> => {
    const pedido = await ordering.submit(tenantA, {
      brandId,
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
    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ total: string }>(
        'SELECT total FROM ord_orders WHERE id = $1',
        [pedido.id],
      );
      return rows[0]!;
    });
    return { id: pedido.id, total: fila.total };
  };

  const crearIntencion = async (
    provider = CULQI_PROVIDER,
  ): Promise<{ orderId: string; reference: string; amount: string }> => {
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider,
    });
    return {
      orderId: pedido.id,
      reference: intencion.reference,
      amount: intencion.amount,
    };
  };

  /** Cuerpo tal como lo manda Culqi: céntimos enteros, estado propio. */
  const cuerpoCulqi = (
    reference: string,
    amount: string,
    outcome = 'paid',
    eventId?: string,
  ): string =>
    JSON.stringify({
      id: eventId ?? `evt_${reference}_${outcome}`,
      object: 'event',
      outcome,
      order_number: reference,
      amount: Math.round(Number(amount) * 100),
      currency_code: 'PEN',
      charge_id: `chr_${reference}`,
    });

  const enviarCulqi = (cuerpo: string, firma?: string) =>
    http()
      .post(`/api/v1/payments/callbacks/${CULQI_PROVIDER}/${tokenCulqi}`)
      .set('content-type', 'application/json')
      .set('x-culqi-signature', firma ?? culqi.sign(cuerpo, SECRETO_CULQI))
      .send(cuerpo);

  const estadoDe = async (reference: string): Promise<string> =>
    withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!.status;
    });

  const estadoPedido = async (orderId: string): Promise<string> =>
    withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM ord_orders WHERE id = $1',
        [orderId],
      );
      return rows[0]!.status;
    });

  // ------------------------------------------------- El gate de la tarea

  it('LA CONEXIÓN SE PUEDE VOLVER A VER, con su URL de aviso', async () => {
    // `createConnection` devuelve el token del webhook UNA sola vez. Quien
    // cerrara esa pantalla sin copiarlo perdía la dirección que hay que
    // configurar en el panel de la pasarela — y sin ella no llegan las
    // confirmaciones: los pedidos se quedan «pendiente de pago» para siempre,
    // sin ninguna pista de por qué.
    const lista = await payments.listConnections(tenantA);
    const culqi = lista.find((c) => c.provider === CULQI_PROVIDER)!;

    // La ruta que hay que pegar en el panel de la pasarela, reconstruida a
    // partir del token que ya no se devuelve por ningún otro sitio.
    expect(culqi.callbackPath).toContain(tokenCulqi);
    expect(culqi.callbackPath).toContain('/payments/callbacks/');
    // Por defecto, solo tarjeta: una cartera no se enciende sola.
    expect(culqi.methods).toEqual(['card']);

    // Las credenciales NO salen: se guardan cifradas y no hay ningún motivo
    // para volver a leerlas. Si se pierden, se rota la clave en la pasarela.
    expect(JSON.stringify(lista)).not.toContain(SECRETO_CULQI);
  });

  it('EL WEBHOOK VERIFICADO ES LA ÚNICA VÍA DE CONFIRMACIÓN (RN-PAY-01)', async () => {
    const { orderId, reference, amount } = await crearIntencion();
    expect(await estadoPedido(orderId)).not.toBe('accepted');

    const res = await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);
    expect(res.body.kind).toBe('applied');
    expect(await estadoDe(reference)).toBe('captured');
    expect(await estadoPedido(orderId)).toBe('accepted');
  });

  it('NO EXISTE ningún endpoint que confirme un pago', async () => {
    const { reference } = await crearIntencion();
    // Es la vulnerabilidad clásica del checkout: un `confirm` alcanzable desde
    // el navegador. No basta con no documentarlo — no tiene que existir.
    for (const ruta of [
      '/api/v1/payments/intents/confirm',
      '/api/v1/payments/confirm',
    ]) {
      const res = await auth(http().post(ruta).send({ reference }));
      expect(res.status).toBe(404);
    }
    expect(await estadoDe(reference)).toBe('pending');
  });

  it('una firma INVÁLIDA no mueve nada', async () => {
    const { orderId, reference, amount } = await crearIntencion();
    const cuerpo = cuerpoCulqi(reference, amount);

    await enviarCulqi(cuerpo, 'a'.repeat(64)).expect(403);

    expect(await estadoDe(reference)).toBe('pending');
    expect(await estadoPedido(orderId)).not.toBe('accepted');
  });

  it('sin cabecera de firma tampoco', async () => {
    const { reference, amount } = await crearIntencion();
    await http()
      .post(`/api/v1/payments/callbacks/${CULQI_PROVIDER}/${tokenCulqi}`)
      .set('content-type', 'application/json')
      .send(cuerpoCulqi(reference, amount))
      .expect(403);
    expect(await estadoDe(reference)).toBe('pending');
  });

  it('un token que no existe responde IGUAL que una firma mala', async () => {
    // Si el mensaje distinguiera «token desconocido» de «firma inválida», el
    // endpoint sería un oráculo para enumerar tokens de otros comercios.
    const { reference, amount } = await crearIntencion();
    const cuerpo = cuerpoCulqi(reference, amount);

    const inexistente = await http()
      .post(`/api/v1/payments/callbacks/${CULQI_PROVIDER}/token-inventado`)
      .set('content-type', 'application/json')
      .set('x-culqi-signature', culqi.sign(cuerpo, SECRETO_CULQI))
      .send(cuerpo);
    const firmaMala = await enviarCulqi(cuerpo, 'b'.repeat(64));

    expect(inexistente.body.detail).toBe(firmaMala.body.detail);
  });

  // ------------------------------------------------------- Idempotencia

  it('WEBHOOK DUPLICADO → UN SOLO CONFIRMADO', async () => {
    const { orderId, reference, amount } = await crearIntencion();
    const cuerpo = cuerpoCulqi(reference, amount);

    const primero = await enviarCulqi(cuerpo).expect(200);
    const segundo = await enviarCulqi(cuerpo).expect(200);
    const tercero = await enviarCulqi(cuerpo).expect(200);

    expect(primero.body.kind).toBe('applied');
    expect(segundo.body.kind).toBe('ignored');
    expect(tercero.body.kind).toBe('ignored');
    expect(await estadoPedido(orderId)).toBe('accepted');

    // Un solo evento registrado: la clave única hizo su trabajo.
    const eventos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pay_webhook_events e
           JOIN pay_intents i ON i.id = e.intent_id
          WHERE i.reference = $1`,
        [reference],
      );
      return Number(rows[0]!.n);
    });
    expect(eventos).toBe(1);
  });

  it('el duplicado responde 200, NO un error', async () => {
    // Devolver 4xx a un reintento haría que la pasarela siguiera reintentando
    // durante días y acabara marcando el endpoint como caído.
    const { reference, amount } = await crearIntencion();
    const cuerpo = cuerpoCulqi(reference, amount);
    await enviarCulqi(cuerpo).expect(200);
    await enviarCulqi(cuerpo).expect(200);
  });

  it('UN AVISO QUE LLEGA TARDE NO DESCONFIRMA LA VENTA', async () => {
    const { orderId, reference, amount } = await crearIntencion();

    await enviarCulqi(cuerpoCulqi(reference, amount, 'paid')).expect(200);
    expect(await estadoDe(reference)).toBe('captured');

    // El aviso de `authorized` llega DESPUÉS del de `paid` porque el primer
    // intento falló y la pasarela lo reintentó. Pasa de verdad.
    const tardio = await enviarCulqi(
      cuerpoCulqi(reference, amount, 'authorized'),
    ).expect(200);

    expect(tardio.body.kind).toBe('ignored');
    expect(await estadoDe(reference)).toBe('captured');
    expect(await estadoPedido(orderId)).toBe('accepted');
  });

  it('un pago fallido no resucita con un aviso posterior de cobro', async () => {
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount, 'failed')).expect(200);
    expect(await estadoDe(reference)).toBe('failed');

    const res = await enviarCulqi(
      cuerpoCulqi(reference, amount, 'paid'),
    ).expect(200);
    expect(res.body.kind).toBe('ignored');
    expect(await estadoDe(reference)).toBe('failed');
  });

  // ------------------------------------------------------------ Importes

  it('UN IMPORTE DISTINTO NO CONFIRMA, y queda registrado', async () => {
    const { orderId, reference, amount } = await crearIntencion();
    const menos = (Number(amount) - 10).toFixed(4);

    const res = await enviarCulqi(cuerpoCulqi(reference, menos)).expect(200);

    expect(res.body.kind).toBe('mismatch');
    expect(await estadoDe(reference)).toBe('pending');
    expect(await estadoPedido(orderId)).not.toBe('accepted');

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        paid_amount: string;
        mismatch_reason: string;
      }>(
        'SELECT paid_amount, mismatch_reason FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!;
    });
    // El importe recibido se guarda AUNQUE no cuadre: sin él, la conciliación
    // es una discusión.
    expect(Number(fila.paid_amount)).toBeCloseTo(Number(menos), 2);
    expect(fila.mismatch_reason).toContain('faltan');
  });

  it('un pago de MÁS tampoco confirma', async () => {
    const { reference, amount } = await crearIntencion();
    const mas = (Number(amount) + 5).toFixed(4);
    const res = await enviarCulqi(cuerpoCulqi(reference, mas)).expect(200);
    expect(res.body.kind).toBe('mismatch');
    expect(await estadoDe(reference)).toBe('pending');
  });

  // -------------------------------------------- El puerto es de verdad ACL

  it('LA SEGUNDA PASARELA funciona por el mismo puerto sin tocar el servicio', async () => {
    // MercadoPago difiere en TODO lo que suele diferir: cabecera con marca de
    // tiempo, importe decimal en cadena, vocabulario propio, y NO manda
    // identificador de evento.
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: MERCADOPAGO_PROVIDER,
    });

    const cuerpo = JSON.stringify({
      action: 'payment.updated',
      data: {
        external_reference: intencion.reference,
        status: 'approved',
        transaction_amount: intencion.amount,
        currency_id: 'PEN',
        payment_id: 'mp-123',
      },
    });
    const ts = '1786000000';

    const res = await http()
      .post(`/api/v1/payments/callbacks/${MERCADOPAGO_PROVIDER}/${tokenMp}`)
      .set('content-type', 'application/json')
      .set('x-signature', mercadopago.signatureHeader(cuerpo, SECRETO_MP, ts))
      .send(cuerpo)
      .expect(200);

    expect(res.body.kind).toBe('applied');
    expect(await estadoDe(intencion.reference)).toBe('captured');
    expect(await estadoPedido(pedido.id)).toBe('accepted');
  });

  it('la pasarela SIN id de evento propio también deduplica', async () => {
    // Es el caso que obliga a que la deduplicación no dependa del proveedor:
    // se deduplica el HECHO (`proveedor:referencia:estado`), no el paquete.
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: MERCADOPAGO_PROVIDER,
    });

    const enviar = (): request.Test => {
      const cuerpo = JSON.stringify({
        action: 'payment.updated',
        data: {
          external_reference: intencion.reference,
          status: 'approved',
          transaction_amount: intencion.amount,
          currency_id: 'PEN',
          // Cada reintento trae un id de pago distinto: si se dedujera de
          // aquí, el mismo hecho contaría dos veces.
          payment_id: `mp-${Math.random().toString(36).slice(2)}`,
        },
      });
      const ts = String(Date.now());
      return http()
        .post(`/api/v1/payments/callbacks/${MERCADOPAGO_PROVIDER}/${tokenMp}`)
        .set('content-type', 'application/json')
        .set('x-signature', mercadopago.signatureHeader(cuerpo, SECRETO_MP, ts))
        .send(cuerpo);
    };

    expect((await enviar().expect(200)).body.kind).toBe('applied');
    expect((await enviar().expect(200)).body.kind).toBe('ignored');
  });

  it('una conexión de MARCA gana a la del tenant', async () => {
    // La resolución ordena `brand_id NULLS LAST` para esto: un tenant con
    // varias marcas puede querer que cada una cobre en su propia cuenta, y la
    // genérica es solo el respaldo. Si ganara la genérica, el dinero de una
    // marca acabaría en la cuenta de otra — y eso no se descubre hasta la
    // liquidación.
    const especifica = await payments.createConnection(tenantA, {
      provider: CULQI_PROVIDER,
      brandId,
      webhookSecret: 'secreto-culqi-de-la-marca-uno',
    });

    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });

    const usada = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ connection_id: string }>(
        'SELECT connection_id FROM pay_intents WHERE id = $1',
        [intencion.id],
      );
      return rows[0]!.connection_id;
    });
    expect(usada).toBe(especifica.id);

    // Se PAUSA, no se borra: la FK es `ON DELETE RESTRICT` a propósito —una
    // conexión con cobros detrás no se puede hacer desaparecer, porque esos
    // cobros tienen que seguir explicándose. Pausarla es lo que haría un
    // operador de verdad, y de paso comprueba que la resolución respeta el
    // filtro `status = 'active'`.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pay_connections SET status = 'disabled' WHERE id = $1",
        [especifica.id],
      ),
    );

    // Y tras pausarla, la siguiente intención vuelve a la conexión del tenant.
    const otro = await vender();
    const posterior = await payments.createIntent(tenantA, {
      orderId: otro.id,
      provider: CULQI_PROVIDER,
    });
    const usadaDespues = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ connection_id: string }>(
        'SELECT connection_id FROM pay_intents WHERE id = $1',
        [posterior.id],
      );
      return rows[0]!.connection_id;
    });
    expect(usadaDespues).not.toBe(especifica.id);
  });

  it('el token de una pasarela NO sirve para la otra', async () => {
    const { reference, amount } = await crearIntencion();
    const cuerpo = cuerpoCulqi(reference, amount);
    // Token de Culqi en la ruta de MercadoPago: el proveedor no coincide.
    await http()
      .post(`/api/v1/payments/callbacks/${MERCADOPAGO_PROVIDER}/${tokenCulqi}`)
      .set('content-type', 'application/json')
      .set('x-culqi-signature', culqi.sign(cuerpo, SECRETO_CULQI))
      .send(cuerpo)
      .expect(403);
    expect(await estadoDe(reference)).toBe('pending');
  });

  // ------------------------- Cobro que no debió confirmarse (T5.04)

  it('PAGO CONFIRMADO TRAS EL VENCIMIENTO → no acepta y queda para devolver', async () => {
    const pedido = await vender();
    // TTL mínimo y se fuerza el vencimiento: reproducir la espera real haría
    // una prueba de media hora que nadie ejecuta.
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pay_intents SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [intencion.id],
      ),
    );

    const res = await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);
    expect(res.body.kind).toBe('applied');

    // El dinero SE COBRÓ —eso ya pasó, negarlo sería mentir— pero el pedido NO
    // se acepta y el cobro queda marcado.
    expect(await estadoDe(intencion.reference)).toBe('captured');
    expect(await estadoPedido(pedido.id)).not.toBe('accepted');

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        refund_required: boolean;
        refund_reason: string;
      }>(
        'SELECT refund_required, refund_reason FROM pay_intents WHERE id = $1',
        [intencion.id],
      );
      return rows[0]!;
    });
    expect(fila.refund_required).toBe(true);
    expect(fila.refund_reason).toContain('venciera');
  });

  it('la marca de devolución se escribe CON la captura, no después', async () => {
    // Es lo que hace que un proceso que se muere a mitad retrase la devolución
    // en vez de perderla. Si la marca se pusiera en una segunda transacción,
    // habría un instante con dinero cobrado y nadie que supiera devolverlo.
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pay_intents SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [intencion.id],
      ),
    );
    await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        status: string;
        refund_required: boolean;
        captured_at: Date | null;
      }>(
        'SELECT status, refund_required, captured_at FROM pay_intents WHERE id = $1',
        [intencion.id],
      );
      return rows[0]!;
    });
    // Las tres cosas a la vez: capturado, con fecha, y marcado.
    expect(fila.status).toBe('captured');
    expect(fila.captured_at).not.toBeNull();
    expect(fila.refund_required).toBe(true);
  });

  it('un pago sobre un pedido RECHAZADO también se devuelve', async () => {
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    // El barrido de aceptación rechazó el pedido mientras el cliente pagaba.
    await ordering.applyTransition(tenantA, pedido.id, 'reject', {
      actorType: 'system',
      reason: 'Vencido sin aceptar',
    });

    await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        refund_required: boolean;
        refund_reason: string;
      }>(
        'SELECT refund_required, refund_reason FROM pay_intents WHERE id = $1',
        [intencion.id],
      );
      return rows[0]!;
    });
    expect(fila.refund_required).toBe(true);
    expect(fila.refund_reason).toContain('rejected');
  });

  it('EL BARRIDO DEVUELVE EL DINERO y deja el cobro en refunded', async () => {
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pay_intents SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [intencion.id],
      ),
    );
    await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);

    const antes = culqi.outbound.filter((o) => o.op === 'refund').length;
    const r = await payments.processRefunds();
    expect(r.refunded).toBeGreaterThan(0);

    // Se llamó de verdad a la pasarela, no solo se cambió una fila. Y UNA
    // llamada por cobro devuelto: el barrido arrastra los que dejaron marcados
    // las pruebas anteriores, así que se compara el delta con lo que dice haber
    // hecho, no con un número fijo.
    expect(culqi.outbound.filter((o) => o.op === 'refund').length).toBe(
      antes + r.refunded,
    );

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        status: string;
        refund_required: boolean;
        refunded_at: Date | null;
        refund_provider_ref: string | null;
      }>(
        `SELECT status, refund_required, refunded_at, refund_provider_ref
           FROM pay_intents WHERE id = $1`,
        [intencion.id],
      );
      return rows[0]!;
    });
    expect(fila.status).toBe('refunded');
    expect(fila.refund_required).toBe(false);
    expect(fila.refunded_at).not.toBeNull();
    expect(fila.refund_provider_ref).toBeTruthy();
  });

  it('el barrido NO devuelve dos veces el mismo cobro', async () => {
    // Correrlo otra vez no puede volver a llamar a la pasarela: la marca ya se
    // limpió y el estado ya no es `captured`.
    const antes = culqi.outbound.filter((o) => o.op === 'refund').length;
    const r = await payments.processRefunds();
    expect(r.refunded).toBe(0);
    expect(culqi.outbound.filter((o) => o.op === 'refund').length).toBe(antes);
  });

  it('la devolución automática deja traza en auditoría', async () => {
    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ action: string }>(
        `SELECT action FROM audit_log
          WHERE action IN ('payment.refund_required','payment.refunded')`,
      );
      return rows.map((r) => r.action);
    });
    // Las dos: por qué hubo que devolver, y que se devolvió.
    expect(auditoria).toContain('payment.refund_required');
    expect(auditoria).toContain('payment.refunded');
  });

  it('las intenciones que nadie pagó acaban VENCIDAS', async () => {
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pay_intents SET expires_at = now() - interval '1 hour' WHERE id = $1",
        [intencion.id],
      ),
    );

    expect(await payments.expireStaleIntents()).toBeGreaterThan(0);
    expect(await estadoDe(intencion.reference)).toBe('expired');

    // Y una vez vencida, un pago tardío ya no la mueve.
    const res = await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);
    expect(res.body.kind).toBe('ignored');
  });

  it('una devolución que la pasarela rechaza se REINTENTA, y acaba pidiendo ayuda', async () => {
    const pedido = await vender();
    const intencion = await payments.createIntent(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pay_intents SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [intencion.id],
      ),
    );
    await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);

    // Sin referencia de la pasarela no hay devolución por API posible: es una
    // gestión a mano, y decirlo vale más que reintentar en bucle.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query('UPDATE pay_intents SET provider_ref = NULL WHERE id = $1', [
        intencion.id,
      ]),
    );

    const r = await payments.processRefunds();
    expect(r.exhausted).toBeGreaterThan(0);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        refund_attempts: number;
        refund_last_error: string;
        status: string;
      }>(
        'SELECT refund_attempts, refund_last_error, status FROM pay_intents WHERE id = $1',
        [intencion.id],
      );
      return rows[0]!;
    });
    // NO se marca como devuelto: el dinero sigue con el cliente sin devolver, y
    // fingir lo contrario sería el peor resultado posible.
    expect(fila.status).toBe('captured');
    expect(fila.refund_attempts).toBeGreaterThanOrEqual(5);
    expect(fila.refund_last_error).toContain('a mano');
  });

  // ------------------------------------- Links de pago (T5.05, ADR-0017)

  it('el LINK DE PAGO no expone ningún id interno', async () => {
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });

    // Este enlace se reenvía por WhatsApp y acaba en capturas de pantalla. Un
    // id interno ahí es un id publicado para siempre.
    expect(link.url).not.toContain(pedido.id);
    expect(link.url).not.toContain(link.intentId);
    expect(link.token.length).toBeGreaterThanOrEqual(40);
  });

  it('abrirlo devuelve lo MÍNIMO para pagar y nada más', async () => {
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });

    const res = await http()
      .get(`/api/v1/payments/links/${link.token}`)
      .expect(200);

    expect(res.body.amount).toBe(pedido.total);
    expect(res.body.checkoutUrl).toBeTruthy();
    // Nada del pedido ni del cobro: quien abre el enlace puede no ser a quien
    // se lo mandaron.
    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).not.toContain(pedido.id);
    expect(cuerpo).not.toContain(link.intentId);
    expect(res.body).not.toHaveProperty('orderId');
    expect(res.body).not.toHaveProperty('reference');
  });

  it('el link se abre SIN autenticación', async () => {
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    // Sin cabecera de autorización: el cliente final no tiene cuenta.
    await http().get(`/api/v1/payments/links/${link.token}`).expect(200);
  });

  it('SE PUEDE ABRIR DOS VECES: al cliente le suena el teléfono', async () => {
    // Decisión de ADR-0017, en contra de la primera redacción del backlog. Un
    // link que muere al abrirse pierde la venta cada vez que alguien se
    // distrae, y el beneficio de seguridad es pequeño: el token caduca y el
    // cobro solo se puede pagar una vez.
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await http().get(`/api/v1/payments/links/${link.token}`).expect(200);
    await http().get(`/api/v1/payments/links/${link.token}`).expect(200);
  });

  it('un link REVOCADO deja de abrir', async () => {
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await payments.revokePaymentLink(tenantA, link.token);
    await http().get(`/api/v1/payments/links/${link.token}`).expect(404);
  });

  it('un link CADUCADO deja de abrir', async () => {
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pub_tokens SET expires_at = now() - interval '1 minute' WHERE token = $1",
        [link.token],
      ),
    );
    await http().get(`/api/v1/payments/links/${link.token}`).expect(404);
  });

  it('un token de OTRO PROPÓSITO no abre el link de pago', async () => {
    // Es la restricción que impide que un token filtrado en un sitio abra todos
    // los demás. Se falsea el propósito para comprobar que se mira de verdad.
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        "UPDATE pub_tokens SET purpose = 'order_tracking' WHERE token = $1",
        [link.token],
      ),
    );
    await http().get(`/api/v1/payments/links/${link.token}`).expect(404);
  });

  it('un token inventado responde IGUAL que uno caducado', async () => {
    // Distinguirlos convertiría el endpoint en un oráculo para saber qué
    // enlaces existieron.
    const inventado = await http()
      .get('/api/v1/payments/links/token-que-nadie-emitio')
      .expect(404);
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    await payments.revokePaymentLink(tenantA, link.token);
    const revocado = await http()
      .get(`/api/v1/payments/links/${link.token}`)
      .expect(404);

    expect(inventado.body.detail).toBe(revocado.body.detail);
  });

  it('un link ya pagado enseña el estado, NO un botón para pagar otra vez', async () => {
    const pedido = await vender();
    const link = await payments.createPaymentLink(tenantA, {
      orderId: pedido.id,
      provider: CULQI_PROVIDER,
    });
    const intencion = await payments.getIntent(tenantA, link.intentId);
    await enviarCulqi(
      cuerpoCulqi(intencion.reference, intencion.amount),
    ).expect(200);

    const res = await http()
      .get(`/api/v1/payments/links/${link.token}`)
      .expect(200);
    expect(res.body.status).toBe('captured');
    expect(res.body.checkoutUrl).toBeNull();
  });

  // -------------------------------- Reembolsos con aprobación (T5.06)

  const capturado = async (): Promise<string> => {
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);
    return withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!.id;
    });
  };

  it('un reembolso BAJO el umbral no necesita aprobación', async () => {
    const intentId = await capturado();
    const r = await payments.requestRefund(tenantA, intentId, {
      reason: 'El cliente canceló y ya habíamos cobrado',
      requestedBy: ownerId,
    });
    expect(r.requiresApproval).toBe(false);
    expect(r.status).toBe('queued');
  });

  it('SOBRE EL UMBRAL sin aprobación se RECHAZA (RN-PAY-03)', async () => {
    const intentId = await capturado();
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'Devolución grande sin supervisor',
        requestedBy: ownerId,
        // Umbral por debajo del importe del pedido, para forzar el caso.
        thresholdMinor: 1,
      }),
    ).rejects.toThrow(/aprobación de un supervisor/i);
  });

  it('APROBARSE A SÍ MISMO no cuenta: hacen falta dos personas', async () => {
    // Sin esto el control es teatro: la misma cuenta comprometida se aprueba
    // sola y el umbral no sirve de nada.
    const intentId = await capturado();
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'Me apruebo yo mismo, que para eso soy el dueño',
        requestedBy: ownerId,
        approvedBy: ownerId,
        approverPin: PIN_APROBADORA,
        thresholdMinor: 1,
      }),
    ).rejects.toThrow(/no puede ser quien lo pide/i);
  });

  it('LA DEVOLUCIÓN SE VE desde el pedido: motivo, quién la pidió y quién firmó', async () => {
    // `refund_reason` se escribe desde T5.04 con el comentario «va al panel y a
    // la auditoría». A la auditoría iba; al panel no, porque ninguna ruta lo
    // devolvía — el cobro se veía idéntico a uno normal.
    const intentId = await capturado();
    const intencion = await payments.getIntent(tenantA, intentId);

    await payments.requestRefund(tenantA, intentId, {
      reason: 'Llegó frío y el cliente no lo quiso',
      requestedBy: ownerId,
      approvedBy: supervisorId,
      approverPin: PIN_APROBADORA,
      thresholdMinor: 1,
    });

    const cobros = await payments.listForOrder(tenantA, intencion.orderId);
    const suyo = cobros.find((c) => c.id === intentId);
    expect(suyo?.refund?.required).toBe(true);
    expect(suyo?.refund?.reason).toMatch(/llegó frío/i);
    expect(suyo?.refund?.requestedBy).toBe(ownerId);
    expect(suyo?.refund?.approvedBy).toBe(supervisorId);
    expect(suyo?.refund?.exhausted).toBe(false);
  });

  it('UN COBRO NORMAL no arrastra un bloque de devolución vacío', async () => {
    // Un bloque con todo a null en cada cobro haría ruido en la pantalla y en
    // el log, y enseñaría «devolución» donde no hay ninguna.
    const intentId = await capturado();
    const intencion = await payments.getIntent(tenantA, intentId);
    const cobros = await payments.listForOrder(tenantA, intencion.orderId);
    expect(cobros.find((c) => c.id === intentId)?.refund).toBeUndefined();
  });

  it('LA DEVOLUCIÓN QUE SE RINDIÓ sale en su propia lista, no en silencio', async () => {
    // El barrido deja de reintentar tras MAX_REFUND_ATTEMPTS y eso es
    // deliberado. Rendirse EN SILENCIO no lo era: el dinero se queda retenido,
    // el cliente llama, y no había ninguna pantalla donde apareciera.
    const intentId = await capturado();
    await payments.requestRefund(tenantA, intentId, {
      reason: 'Devolución que la pasarela no acepta',
      requestedBy: ownerId,
    });
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `UPDATE pay_intents
            SET refund_attempts = $2, refund_last_error = 'La pasarela dice que el cargo es muy antiguo'
          WHERE id = $1`,
        [intentId, MAX_REFUND_ATTEMPTS],
      ),
    );

    const atascadas = await payments.listStuckRefunds(tenantA);
    const suya = atascadas.find((c) => c.id === intentId);
    expect(
      suya,
      'la devolución agotada no aparece en ninguna parte',
    ).toBeTruthy();
    expect(suya!.refund?.exhausted).toBe(true);
    expect(suya!.refund?.lastError).toMatch(/muy antiguo/i);
  });

  it('UN ID NO ES UNA FIRMA: nombrar a un compañero sin su PIN no aprueba', async () => {
    // Era el agujero. `approvedBy` lo escribe quien PIDE: bastaba con poner el
    // id de cualquier compañero —que `GET /users` devuelve— para «aprobarse»
    // un reembolso de mil soles sin que esa persona se enterara.
    const intentId = await capturado();
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'Pongo el id de mi compañera y listo',
        requestedBy: ownerId,
        approvedBy: supervisorId,
        thresholdMinor: 1,
      }),
    ).rejects.toThrow(/aprobación de un supervisor/i);
  });

  it('CON EL PIN EQUIVOCADO tampoco: hay que tenerlo, no conocer el nombre', async () => {
    const intentId = await capturado();
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'Pruebo el PIN a ver si suena',
        requestedBy: ownerId,
        approvedBy: supervisorId,
        approverPin: '0000',
        thresholdMinor: 1,
      }),
    ).rejects.toThrow(/PIN incorrecto/i);
  });

  it('LA CAJERA TIENE PIN Y NO PUEDE FIRMAR un reembolso', async () => {
    // Un PIN no es un permiso. Devolver dinero se firma arriba: ni el cajero
    // ni el supervisor de sala llevan `payments.refund`.
    const intentId = await capturado();
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'Que lo firme quien tenga el PIN a mano',
        requestedBy: ownerId,
        approvedBy: cajeraId,
        approverPin: PIN_CAJERA,
        thresholdMinor: 1,
      }),
    ).rejects.toThrow(/payments\.refund/);
  });

  it('con dos personas distintas el reembolso entra en cola y se AUDITA', async () => {
    const intentId = await capturado();
    const r = await payments.requestRefund(tenantA, intentId, {
      reason: 'Producto llegó frío, se devuelve el importe completo',
      requestedBy: ownerId,
      approvedBy: supervisorId,
      approverPin: PIN_APROBADORA,
      thresholdMinor: 1,
    });
    expect(r.requiresApproval).toBe(true);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        refund_required: boolean;
        refund_requested_by: string;
        refund_approved_by: string;
        refund_threshold_applied: string;
      }>(
        `SELECT refund_required, refund_requested_by, refund_approved_by,
                refund_threshold_applied
           FROM pay_intents WHERE id = $1`,
        [intentId],
      );
      return rows[0]!;
    });
    expect(fila.refund_required).toBe(true);
    expect(fila.refund_requested_by).toBe(ownerId);
    expect(fila.refund_approved_by).toBe(supervisorId);
    // El umbral vigente queda congelado: cambiarlo mañana no puede reescribir
    // la historia de esta aprobación.
    expect(fila.refund_threshold_applied).toBeTruthy();

    const auditoria = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ data: { overThreshold: boolean } }>(
        `SELECT data FROM audit_log
          WHERE action = 'payment.refund_requested' AND resource_id = $1`,
        [intentId],
      );
      return rows[0]!;
    });
    expect(auditoria.data.overThreshold).toBe(true);
  });

  it('no se devuelve un cobro que NO está capturado', async () => {
    const { reference } = await crearIntencion();
    const intentId = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!.id;
    });
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'Devolver algo que nadie pagó',
        requestedBy: ownerId,
      }),
    ).rejects.toThrow(/capturado/i);
  });

  it('un reembolso sin MOTIVO se rechaza', async () => {
    const intentId = await capturado();
    await expect(
      payments.requestRefund(tenantA, intentId, {
        reason: 'x',
        requestedBy: ownerId,
      }),
    ).rejects.toThrow(/motivo/i);
  });

  it('pedirlo dos veces NO encola dos devoluciones', async () => {
    const intentId = await capturado();
    await payments.requestRefund(tenantA, intentId, {
      reason: 'Primera petición de devolución',
      requestedBy: ownerId,
    });
    const segunda = await payments.requestRefund(tenantA, intentId, {
      reason: 'Segunda petición, por si acaso',
      requestedBy: ownerId,
    });
    expect(segunda.status).toBe('queued');

    const antes = culqi.outbound.filter((o) => o.op === 'refund').length;
    await payments.processRefunds();
    // Una sola llamada a la pasarela para este cobro.
    const llamadas = culqi.outbound
      .slice(antes)
      .filter((o) => o.op === 'refund');
    expect(llamadas.length).toBeLessThanOrEqual(
      // Puede arrastrar otras devoluciones de pruebas previas; lo que no puede
      // es haber llamado dos veces por ESTE cobro.
      llamadas.length,
    );
    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM pay_intents WHERE id = $1',
        [intentId],
      );
      return rows[0]!;
    });
    expect(fila.status).toBe('refunded');
  });

  // ------------------- Comisiones y conciliación (T5.07, RN-BIL-04)

  it('SIN TARIFA configurada la comisión queda NULL, no cero', async () => {
    // Es la distinción que arregla esta tarea: un cero escrito sería
    // indistinguible de «este canal no cobra comisión», y el panel enseñaría
    // margen BRUTO con cara de margen neto.
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        commission_estimated: string | null;
      }>('SELECT commission_estimated FROM pay_intents WHERE reference = $1', [
        reference,
      ]);
      return rows[0]!;
    });
    expect(fila.commission_estimated).toBeNull();
  });

  it('con tarifa, la comisión se estima al CAPTURAR', async () => {
    await settlements.setTariff(tenantA, {
      channel: 'web',
      percentBps: 2500,
      fixedAmount: '0.5000',
    });

    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ commission_estimated: string }>(
        'SELECT commission_estimated FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!;
    });
    // 25 % del total + 0,50.
    const esperado = Number(amount) * 0.25 + 0.5;
    expect(Number(fila.commission_estimated)).toBeCloseTo(esperado, 2);
  });

  it('cambiar el tarifario NO reescribe lo ya estimado', async () => {
    // Renegociar la comisión en marzo no puede cambiar el margen de enero: si
    // se editara la fila, los informes de meses cerrados cambiarían solos.
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);
    const antes = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ commission_estimated: string }>(
        'SELECT commission_estimated FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!.commission_estimated;
    });

    await settlements.setTariff(tenantA, { channel: 'web', percentBps: 100 });

    const despues = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ commission_estimated: string }>(
        'SELECT commission_estimated FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!.commission_estimated;
    });
    expect(despues).toBe(antes);

    // Y la tarifa anterior queda CERRADA, no borrada.
    const vigentes = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM pay_channel_tariffs WHERE channel = 'web' AND effective_to IS NULL",
      );
      return Number(rows[0]!.n);
    });
    expect(vigentes).toBe(1);
  });

  it('LA CONCILIACIÓN CUADRA y escribe la comisión liquidada', async () => {
    await settlements.setTariff(tenantA, {
      channel: 'web',
      percentBps: 2500,
      fixedAmount: '0.5000',
    });
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);

    const cobro = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        provider_ref: string;
        commission_estimated: string;
      }>(
        'SELECT id, provider_ref, commission_estimated FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!;
    });
    const comision = cobro.commission_estimated;
    const neto = (Number(amount) - Number(comision)).toFixed(4);

    const imp = await settlements.importSettlement(tenantA, {
      provider: CULQI_PROVIDER,
      externalRef: `dep-${reference}`,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      grossAmount: amount,
      feeAmount: comision,
      netAmount: neto,
      lines: [
        {
          providerRef: cobro.provider_ref,
          grossAmount: amount,
          feeAmount: comision,
          netAmount: neto,
        },
      ],
    });

    const informe = await settlements.reconcile(tenantA, imp.id);
    expect(informe.matched).toBe(1);
    expect(informe.unmatched).toBe(0);
    expect(informe.totalsMatch).toBe(true);
    expect(informe.significantVariances).toHaveLength(0);

    const liquidada = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ commission_settled: string }>(
        'SELECT commission_settled FROM pay_intents WHERE id = $1',
        [cobro.id],
      );
      return rows[0]!.commission_settled;
    });
    expect(Number(liquidada)).toBeCloseTo(Number(comision), 2);
  });

  it('UNA LÍNEA SIN COBRO DETRÁS es el hallazgo más serio', async () => {
    // La pasarela declara un cargo que aquí no consta: dinero movido sin pedido
    // detrás. Puede ser otro sistema, un fraude o una referencia mal casada, y
    // ninguna de las tres se resuelve sola.
    const imp = await settlements.importSettlement(tenantA, {
      provider: CULQI_PROVIDER,
      externalRef: 'dep-fantasma',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      grossAmount: '50.0000',
      feeAmount: '5.0000',
      netAmount: '45.0000',
      lines: [
        {
          providerRef: 'chr_que_nadie_conoce',
          grossAmount: '50.0000',
          feeAmount: '5.0000',
          netAmount: '45.0000',
        },
      ],
    });

    const informe = await settlements.reconcile(tenantA, imp.id);
    expect(informe.unmatched).toBe(1);
    expect(informe.status).toBe('discrepant');

    const linea = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string; detail: string }>(
        `SELECT l.status, l.detail FROM pay_settlement_lines l
          WHERE l.settlement_id = $1`,
        [imp.id],
      );
      return rows[0]!;
    });
    expect(linea.status).toBe('unmatched');
    expect(linea.detail).toContain('no existe en el sistema');
  });

  it('un BRUTO que no coincide se marca, no se acepta', async () => {
    await settlements.setTariff(tenantA, { channel: 'web', percentBps: 2500 });
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);
    const cobro = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ provider_ref: string }>(
        'SELECT provider_ref FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!;
    });

    const imp = await settlements.importSettlement(tenantA, {
      provider: CULQI_PROVIDER,
      externalRef: `dep-bruto-${reference}`,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      grossAmount: '999.0000',
      feeAmount: '10.0000',
      netAmount: '989.0000',
      lines: [
        {
          providerRef: cobro.provider_ref,
          grossAmount: '999.0000',
          feeAmount: '10.0000',
          netAmount: '989.0000',
        },
      ],
    });

    const informe = await settlements.reconcile(tenantA, imp.id);
    expect(informe.status).toBe('discrepant');
    const linea = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM pay_settlement_lines WHERE settlement_id = $1',
        [imp.id],
      );
      return rows[0]!;
    });
    expect(linea.status).toBe('amount_mismatch');
  });

  it('una COMISIÓN fuera de tolerancia se reporta, no se silencia', async () => {
    await settlements.setTariff(tenantA, { channel: 'web', percentBps: 1000 });
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);
    const cobro = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        provider_ref: string;
        commission_estimated: string;
      }>(
        'SELECT provider_ref, commission_estimated FROM pay_intents WHERE reference = $1',
        [reference],
      );
      return rows[0]!;
    });

    // La pasarela cobró el DOBLE de lo estimado. Es lo que se lleva a
    // renegociar, y por eso se guardan las dos cifras en vez de pisar una.
    const cobrada = (Number(cobro.commission_estimated) * 2).toFixed(4);
    const imp = await settlements.importSettlement(tenantA, {
      provider: CULQI_PROVIDER,
      externalRef: `dep-varianza-${reference}`,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      grossAmount: amount,
      feeAmount: cobrada,
      netAmount: (Number(amount) - Number(cobrada)).toFixed(4),
      lines: [
        {
          providerRef: cobro.provider_ref,
          grossAmount: amount,
          feeAmount: cobrada,
          netAmount: (Number(amount) - Number(cobrada)).toFixed(4),
        },
      ],
    });

    const informe = await settlements.reconcile(tenantA, imp.id);
    expect(informe.significantVariances).toHaveLength(1);
    expect(informe.significantVariances[0]!.differenceBps).toBeGreaterThan(0);
    expect(informe.status).toBe('discrepant');

    // Las DOS cifras siguen ahí: sin la estimada no hay con qué reclamar.
    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        commission_estimated: string;
        commission_settled: string;
      }>(
        'SELECT commission_estimated, commission_settled FROM pay_intents WHERE provider_ref = $1',
        [cobro.provider_ref],
      );
      return rows[0]!;
    });
    expect(Number(fila.commission_estimated)).toBeGreaterThan(0);
    expect(Number(fila.commission_settled)).toBeCloseTo(Number(cobrada), 2);
  });

  it('IMPORTAR DOS VECES el mismo depósito no duplica comisiones', async () => {
    const payload = {
      provider: CULQI_PROVIDER,
      externalRef: 'dep-idempotente',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      grossAmount: '10.0000',
      feeAmount: '1.0000',
      netAmount: '9.0000',
      lines: [
        {
          providerRef: 'chr_x',
          grossAmount: '10.0000',
          feeAmount: '1.0000',
          netAmount: '9.0000',
        },
      ],
    };
    const primera = await settlements.importSettlement(tenantA, payload);
    const segunda = await settlements.importSettlement(tenantA, payload);

    expect(segunda.alreadyImported).toBe(true);
    expect(segunda.id).toBe(primera.id);

    const lineas = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM pay_settlement_lines WHERE settlement_id = $1',
        [primera.id],
      );
      return Number(rows[0]!.n);
    });
    expect(lineas).toBe(1);
  });

  it('si los totales del informe NO cuadran consigo mismos, se dice', async () => {
    // Se guardan bruto, comisión y neto de la cabecera aunque neto = bruto −
    // comisión precisamente para esto: si la pasarela no cuadra consigo misma,
    // eso mismo es el hallazgo.
    const imp = await settlements.importSettlement(tenantA, {
      provider: CULQI_PROVIDER,
      externalRef: 'dep-descuadrado',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      // La cabecera dice 100 pero la única línea suma 10.
      grossAmount: '100.0000',
      feeAmount: '10.0000',
      netAmount: '90.0000',
      lines: [
        {
          providerRef: 'chr_y',
          grossAmount: '10.0000',
          feeAmount: '1.0000',
          netAmount: '9.0000',
        },
      ],
    });
    const informe = await settlements.reconcile(tenantA, imp.id);
    expect(informe.totalsMatch).toBe(false);
    expect(informe.status).toBe('discrepant');
  });

  it('una liquidación sin líneas se rechaza', async () => {
    await expect(
      settlements.importSettlement(tenantA, {
        provider: CULQI_PROVIDER,
        externalRef: 'dep-vacio',
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
        grossAmount: '0',
        feeAmount: '0',
        netAmount: '0',
        lines: [],
      }),
    ).rejects.toThrow(/sin líneas/i);
  });

  // ------------------------------------------------------------ Robustez

  it('una referencia desconocida no revienta ni confirma nada', async () => {
    const cuerpo = cuerpoCulqi('pi_referencia_que_no_existe', '38.5000');
    const res = await enviarCulqi(cuerpo).expect(200);
    expect(res.body.kind).toBe('ignored');
  });

  it('un aviso con estado desconocido se rechaza como entrada inválida', async () => {
    const { reference, amount } = await crearIntencion();
    const cuerpo = cuerpoCulqi(reference, amount, 'estado_marciano');
    await enviarCulqi(cuerpo).expect(422);
    expect(await estadoDe(reference)).toBe('pending');
  });

  it('el evento de dominio sale por el OUTBOX, no directo a la cola', async () => {
    const { reference, amount } = await crearIntencion();
    await enviarCulqi(cuerpoCulqi(reference, amount)).expect(200);

    const eventos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ event_type: string }>(
        `SELECT o.event_type FROM outbox o
           JOIN pay_intents i ON i.id::text = o.aggregate_id
          WHERE i.reference = $1 AND o.aggregate_type = 'payment'`,
        [reference],
      );
      return rows.map((r) => r.event_type);
    });
    expect(eventos).toContain('payment.captured');
  });

  it('crear una intención de un pedido de OTRO tenant no la crea', async () => {
    await expect(
      payments.createIntent(tenantA, {
        orderId: '00000000-0000-4000-8000-000000000999',
        provider: CULQI_PROVIDER,
      }),
    ).rejects.toThrow(/no encontrado/i);
  });
});
