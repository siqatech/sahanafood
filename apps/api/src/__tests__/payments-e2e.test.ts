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
  CulqiSandboxProvider,
  MercadoPagoSandboxProvider,
  CULQI_PROVIDER,
  MERCADOPAGO_PROVIDER,
} from '../modules/payments/index.js';
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
  let culqi: CulqiSandboxProvider;
  let mercadopago: MercadoPagoSandboxProvider;

  let tokenCulqi = '';
  let tokenMp = '';

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
