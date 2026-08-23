import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { DeliveryService } from '../modules/delivery/index.js';
import {
  MessagingService,
  MessagingEventHandlers,
  MESSAGING_CONSUMER,
  WhatsAppSimulatorProvider,
  WA_REJECTION_CODES,
} from '../modules/messaging/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Notificaciones por WhatsApp (spec 12, T4.28).
 *
 * Las cuatro pruebas que pide la spec, y ninguna es decorativa:
 *
 * · **Ventana expirada → usa plantilla.** Dentro de la ventana el texto libre
 *   es gratis; fuera, Meta lo descarta sin avisar y el cliente se queda sin
 *   saber que su comida salió.
 * · **Opt-out respetado**, con cualquier antigüedad y en cualquier estado.
 * · **Dedupe del webhook**, porque Meta entrega at-least-once y un reintento
 *   suyo reabriría una ventana ya cerrada.
 * · **WhatsApp caído → el PEDIDO SIGUE.** Es la regla que gobierna el módulo
 *   entero.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('WhatsApp — notificaciones de estado', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 20 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let ordering: OrderingService;
  let messaging: MessagingService;
  let wa: WhatsAppSimulatorProvider;
  let handlers: Record<string, unknown>;

  const TELEFONO = '+51987654321';
  /** Host propio del cliente, por donde tiene que salir el seguimiento. */
  const HOST_TIENDA = 'wa-seguimiento.sahana.test';
  let delivery: DeliveryService;

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
    messaging = app.get(MessagingService);
    delivery = app.get(DeliveryService);
    wa = app.get(WhatsAppSimulatorProvider);
    handlers = app.get(MessagingEventHandlers).handlers() as Record<
      string,
      unknown
    >;

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'WhatsApp Tenant',
      planCode: 'growth',
      owner: {
        email: 'wa-a@sahana.test',
        password: 'password-wa-a-1',
        fullName: 'Dueño WhatsApp',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    // Dominio propio del cliente, verificado y en servicio: es de donde debe
    // colgar el enlace de seguimiento.
    //
    // Se siembra aquí y no dentro de una prueba para que las dos que lo usan no
    // dependan del orden en que corran. Antes NINGUNA lo sembraba, el enlace
    // salía por el respaldo de configuración, y eso escondía que la consulta
    // del dominio propio filtraba por un estado inexistente: la prueba pasaba
    // en esta máquina solo porque `PUBLIC_TRACKING_BASE_URL` estaba puesta en
    // el entorno, y en CI —donde no lo está— fallaba.
    await withTenant(pool, tenantA, async ({ client }) => {
      await client.query(
        `INSERT INTO sto_domains (tenant_id, brand_id, host, is_subdomain,
                                  verified_at, status)
         VALUES ($1, $2, $3, true, now(), 'active')`,
        [tenantA, brandId, HOST_TIENDA],
      );
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'wa-a@sahana.test', password: 'password-wa-a-1' })
      .expect(201);
    tokenA = login.body.accessToken;
  });

  beforeEach(async () => {
    wa.configure({ down: false, unreachableNumbers: [] });
    wa.reset();
    // Cada prueba parte de un contacto limpio: el opt-out es persistente a
    // propósito y arrastrarlo entre pruebas escondería fallos.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(`DELETE FROM wa_contacts`),
    );
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`);

  const pedirConTelefono = async (telefono = TELEFONO): Promise<string> => {
    const pedido = await ordering.submit(tenantA, {
      brandId,
      locationId: org.locationId,
      channel: 'whatsapp',
      customerName: 'Ana Quispe',
      customerPhone: telefono,
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

  const mensajesDe = async (orderId: string) =>
    withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        kind: string | null;
        template_name: string | null;
        status: string;
        error_code: string | null;
      }>(
        `SELECT kind, template_name, status, error_code FROM wa_messages
          WHERE order_id = $1 AND direction = 'outbound'
          ORDER BY occurred_at`,
        [orderId],
      );
      return rows;
    });

  // -------------------------------------------------------------------------

  it('VENTANA EXPIRADA → usa plantilla aprobada', async () => {
    // Fuera de ventana el texto libre no llega: Meta lo descarta y el cliente
    // se queda sin saber que su comida salió.
    const orderId = await pedirConTelefono();
    const r = await messaging.notifyOrderState(tenantA, orderId, 'accepted');

    expect(r.sent).toBe(true);
    expect(r.kind).toBe('template');
    expect(wa.sent[0]!.templateName).toBe('pedido_confirmado');
  });

  it('ventana ABIERTA → texto libre, que es gratis', async () => {
    // Usar plantilla dentro de ventana es pagar por nada, en cada pedido y en
    // cada estado.
    const orderId = await pedirConTelefono();
    await messaging.receiveInbound(tenantA, {
      providerMessageId: 'wamid.entrante-1',
      from: TELEFONO,
      body: '¿Cuánto falta?',
      receivedAt: new Date(),
    });

    const r = await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    expect(r.kind).toBe('freeform');
    expect(wa.sent[0]!.body).toContain('#');
  });

  it('OPT-OUT respetado incluso con la ventana abierta', async () => {
    // Un contacto que se dio de baja hace cinco minutos tiene la ventana
    // abierta; preguntar primero por la ventana daría permiso para escribirle.
    const orderId = await pedirConTelefono();
    await messaging.receiveInbound(tenantA, {
      providerMessageId: 'wamid.entrante-2',
      from: TELEFONO,
      body: 'hola',
      receivedAt: new Date(),
    });
    await messaging.recordConsent(tenantA, {
      phone: TELEFONO,
      action: 'revoked',
      source: 'panel',
      consentText: 'El cliente pidió no recibir más mensajes por teléfono.',
    });

    const r = await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/no recibir/);
    expect(wa.sent).toHaveLength(0);
  });

  it('LA BAJA SE PUEDE COMPROBAR: contacto, estado y el texto exacto', async () => {
    // Es la mitad LEGIBLE de RN-T10. El consentimiento se guarda con el texto
    // exacto que aceptó la persona —un booleano no demuestra qué aceptó nadie—
    // y hasta ahora ninguna ruta lo devolvía: la baja se respetaba en cada
    // envío y nadie podía comprobarla ni enseñarla.
    const telefono = '+51955500123';
    await auth(
      http().post('/api/v1/messaging/consents').send({
        phone: telefono,
        action: 'revoked',
        source: 'mostrador',
        consentText: 'Dijo en el mostrador que no quiere más mensajes.',
      }),
    ).expect(201);

    const contactos = await auth(
      http().get(
        `/api/v1/messaging/contacts?phone=${encodeURIComponent(telefono)}`,
      ),
    ).expect(200);
    const suyo = contactos.body.find(
      (c: { phone: string }) => c.phone === telefono,
    );
    expect(suyo, 'el contacto no aparece en la lista').toBeTruthy();
    expect(suyo.optedOut).toBe(true);
    expect(suyo.optedOutAt).toBeTruthy();

    const historial = await auth(
      http().get(`/api/v1/messaging/contacts/${suyo.id}/consents`),
    ).expect(200);
    expect(historial.body[0].action).toBe('revoked');
    expect(historial.body[0].consentText).toMatch(/no quiere más mensajes/);
    // La fecha es la de CUÁNDO lo dijo la persona, no la del apunte.
    expect(historial.body[0].at).toBeTruthy();
  });

  it('responder «BAJA» por WhatsApp da de baja EN EL ACTO', async () => {
    // No se pone en una cola ni se manda a un panel: la persona ya dijo que no.
    await messaging.receiveInbound(tenantA, {
      providerMessageId: 'wamid.baja-1',
      from: TELEFONO,
      body: 'BAJA',
      receivedAt: new Date(),
    });

    const orderId = await pedirConTelefono();
    const r = await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    expect(r.sent).toBe(false);

    // Y queda registrado con el texto exacto, que es lo que exige RN-T10.
    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ action: string; consent_text: string }>(
        `SELECT action, consent_text FROM wa_consents ORDER BY occurred_at DESC LIMIT 1`,
      ),
    );
    expect(rows[0]?.action).toBe('revoked');
    expect(rows[0]?.consent_text).toBe('BAJA');
  });

  it('DEDUPE del webhook: el mismo message_id no cuenta dos veces', async () => {
    // Meta entrega at-least-once. Sin dedupe, un reintento suyo reabriría una
    // ventana ya cerrada y contaría como un mensaje más en el KPI de costo.
    const primera = await messaging.receiveInbound(tenantA, {
      providerMessageId: 'wamid.repetido',
      from: TELEFONO,
      body: 'hola',
      receivedAt: new Date(),
    });
    const segunda = await messaging.receiveInbound(tenantA, {
      providerMessageId: 'wamid.repetido',
      from: TELEFONO,
      body: 'hola',
      receivedAt: new Date(),
    });

    expect(primera.duplicate).toBe(false);
    expect(segunda.duplicate).toBe(true);

    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM wa_messages WHERE direction = 'inbound'`,
      ),
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('WHATSAPP CAÍDO → el pedido sigue su curso', async () => {
    // La regla que gobierna el módulo entero: la comida sale igual aunque el
    // aviso no llegue.
    wa.configure({ down: true });
    const orderId = await pedirConTelefono();

    const r = await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    expect(r.sent).toBe(false);

    // El pedido se acepta sin enterarse de nada.
    await ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });
    expect((await ordering.getSummary(tenantA, orderId)).status).toBe(
      'accepted',
    );

    // Y el fallo queda registrado para el panel, no se pierde.
    const mensajes = await mensajesDe(orderId);
    expect(mensajes[0]?.status).toBe('failed');
  });

  it('un número sin WhatsApp se registra como rechazo, no como avería', async () => {
    // Un teléfono válido no implica una cuenta: el cliente dejó su fijo.
    const fijo = '+5114567890';
    wa.configure({ unreachableNumbers: [fijo] });
    const orderId = await pedirConTelefono(fijo);

    const r = await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    expect(r.sent).toBe(false);

    const mensajes = await mensajesDe(orderId);
    expect(mensajes[0]?.error_code).toBe(
      WA_REJECTION_CODES.RECIPIENT_NOT_ON_WHATSAPP,
    );
  });

  it('un pedido SIN teléfono no es un error: es lo normal en mostrador', async () => {
    const pedido = await ordering.submit(tenantA, {
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
    });
    const r = await messaging.notifyOrderState(tenantA, pedido.id, 'accepted');
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/teléfono/);
  });

  it('solo se notifican los estados que le importan al cliente', async () => {
    // Notificar las doce transiciones multiplica el costo por cuatro sin decir
    // nada útil: nadie necesita saber que pasó de «empacado» a «despachado».
    const orderId = await pedirConTelefono();
    for (const estado of ['received', 'ready', 'packed']) {
      const r = await messaging.notifyOrderState(tenantA, orderId, estado);
      expect(r.sent).toBe(false);
    }
    expect(wa.sent).toHaveLength(0);
  });

  it('el MISMO aviso no se manda dos veces aunque el evento llegue repetido', async () => {
    // Garantía de la BASE, no del código: un evento entregado dos veces no le
    // manda al cliente dos veces «tu pedido está en camino», ni se lo cobra
    // dos veces al tenant.
    const orderId = await pedirConTelefono();
    await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    await messaging.notifyOrderState(tenantA, orderId, 'accepted');

    const mensajes = await mensajesDe(orderId);
    expect(
      mensajes.filter((m) => m.template_name === 'pedido_confirmado'),
    ).toHaveLength(1);
  });

  it('el aviso llega por el camino REAL de eventos', async () => {
    // Lo que se prueba es que el evento LLEGA: ese es el eslabón que se rompe.
    const orderId = await pedirConTelefono();
    await ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });

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
        200,
      );
      if (entregados.length === 0) break;
      for (const mensaje of entregados) {
        await consumeEvent(
          { pool, consumer: MESSAGING_CONSUMER, handlers: handlers as never },
          mensaje as never,
        );
      }
    }

    expect(wa.sent.some((m) => m.templateName === 'pedido_confirmado')).toBe(
      true,
    );
  });

  it('el KPI de mensajes por pedido cuenta lo que se cobra', async () => {
    // A partir del cambio de precios de Meta cada mensaje de servicio se
    // cobra: esta media dice si el canal gana o pierde dinero.
    const orderId = await pedirConTelefono();
    await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    await messaging.notifyOrderState(tenantA, orderId, 'dispatched');

    const stats = await messaging.statsForOrder(tenantA, orderId);
    expect(stats.messages).toBe(2);
    expect(stats.budget.status).toBe('ok');

    const res = await auth(http().get('/api/v1/messaging/kpi')).expect(200);
    expect(res.body.orders).toBeGreaterThanOrEqual(1);
    expect(res.body.average).toBeGreaterThan(0);
  });

  it('POST /messaging/consents exige el TEXTO EXACTO aceptado (RN-T10)', async () => {
    // Un `accepts_marketing` booleano no demuestra qué aceptó esa persona.
    await auth(
      http().post('/api/v1/messaging/consents').send({
        phone: TELEFONO,
        action: 'granted',
        source: 'checkout_web',
      }),
    ).expect(422);

    await auth(
      http().post('/api/v1/messaging/consents').send({
        phone: TELEFONO,
        action: 'granted',
        source: 'checkout_web',
        consentText:
          'Acepto recibir mensajes sobre el estado de mis pedidos por WhatsApp.',
      }),
    ).expect(201);

    const { rows } = await withTenant(pool, tenantA, ({ client }) =>
      client.query<{ consent_text: string; source: string }>(
        `SELECT consent_text, source FROM wa_consents ORDER BY occurred_at DESC LIMIT 1`,
      ),
    );
    expect(rows[0]?.consent_text).toMatch(/Acepto recibir mensajes/);
    expect(rows[0]?.source).toBe('checkout_web');
  });

  it('rechaza teléfonos que no están en E.164', async () => {
    await auth(
      http().post('/api/v1/messaging/consents').send({
        phone: '987654321',
        action: 'granted',
        source: 'panel',
        consentText: 'Acepto recibir mensajes sobre el estado de mis pedidos.',
      }),
    ).expect(422);
  });

  it('el registro de consentimiento es APPEND-ONLY en la base', async () => {
    // Un registro de consentimiento que se puede editar no demuestra nada.
    await messaging.recordConsent(tenantA, {
      phone: TELEFONO,
      action: 'granted',
      source: 'panel',
      consentText: 'Acepto recibir mensajes sobre el estado de mis pedidos.',
    });

    await expect(
      withTenant(pool, tenantA, ({ client }) =>
        client.query(`UPDATE wa_consents SET action = 'revoked'`),
      ),
    ).rejects.toThrow(/permiso|permission/i);
    await expect(
      withTenant(pool, tenantA, ({ client }) =>
        client.query(`DELETE FROM wa_consents`),
      ),
    ).rejects.toThrow(/permiso|permission/i);
  });

  // ------------------------------------------------- Enlace de seguimiento

  it('AL SALIR el aviso LLEVA EL ENLACE de seguimiento', async () => {
    // La página de seguimiento estaba construida entera desde T5.16 y en la
    // práctica no la recibía casi nadie: había que emitir el enlace desde el
    // panel y pegarlo a mano en el chat. Una promesa hecha y no entregada.
    const orderId = await pedirConTelefono();
    await ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });
    const envio = await delivery.createShipment(tenantA, { orderId });

    const r = await messaging.notifyOrderState(tenantA, orderId, 'dispatched');
    expect(r.sent).toBe(true);

    const mandado = wa.sent.at(-1)!;
    const texto = JSON.stringify(mandado);
    // Del HOST DEL CLIENTE, no de cualquier sitio. Comprobar solo que aparece
    // «/seguimiento/» daba por bueno el respaldo de configuración y dejaba
    // pasar que el dominio propio no se consultara nunca — que es exactamente
    // lo que estaba ocurriendo.
    expect(texto).toContain(`https://${HOST_TIENDA}/seguimiento/`);
    expect(envio.id).toBeTruthy();
  });

  it('EL MISMO ENLACE la segunda vez: dos no se pueden seguir a la vez', async () => {
    // Avisar dos veces —un reintento, un cambio de repartidor— no debe dejar
    // dos enlaces distintos en el mismo chat: quien abriera el primero vería
    // un seguimiento que ya nadie actualiza.
    const orderId = await pedirConTelefono();
    await ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });
    const envio = await delivery.createShipment(tenantA, { orderId });

    await messaging.notifyOrderState(tenantA, orderId, 'dispatched');
    const primero = JSON.stringify(wa.sent.at(-1));
    await messaging.notifyOrderState(tenantA, orderId, 'dispatched');
    const segundo = JSON.stringify(wa.sent.at(-1));

    const sacarToken = (t: string): string =>
      t.match(/\/seguimiento\/([A-Za-z0-9_-]+)/)![1]!;
    expect(sacarToken(primero)).toBe(sacarToken(segundo));

    // Y solo hay UN token vivo PARA ESE ENVÍO. Acotado al envío y no al
    // tenant: las otras pruebas de este archivo crean los suyos, y contarlos
    // todos haría que esta prueba dependiera del orden de ejecución.
    const vivos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pub_tokens
          WHERE purpose = 'order_tracking'
            AND resource_id = $1
            AND expires_at > now()`,
        [envio.id],
      );
      return Number(rows[0]!.n);
    });
    expect(vivos).toBe(1);
  });

  it('SIN ENVÍO el aviso se manda IGUAL, solo que sin enlace', async () => {
    // Mostrador, recojo en tienda, o un marketplace que reparte con su flota.
    // Quedarse sin avisar por no tener una URL sería cambiar un problema
    // pequeño por uno grande.
    const orderId = await pedirConTelefono();
    const r = await messaging.notifyOrderState(tenantA, orderId, 'dispatched');

    expect(r.sent).toBe(true);
    expect(JSON.stringify(wa.sent.at(-1))).not.toContain('/seguimiento/');
  });

  it('ANTES de salir NO se manda el enlace', async () => {
    // Un enlace que la primera vez dice «todavía en cocina» es un enlace que
    // el cliente ya no vuelve a abrir.
    const orderId = await pedirConTelefono();
    await ordering.applyTransition(tenantA, orderId, 'accept', {
      actorType: 'system',
    });
    await delivery.createShipment(tenantA, { orderId });

    await messaging.notifyOrderState(tenantA, orderId, 'accepted');
    expect(JSON.stringify(wa.sent.at(-1))).not.toContain('/seguimiento/');
  });
});
