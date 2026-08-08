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
import { ConversationsService } from '../modules/conversations/index.js';
import {
  AgentConfigService,
  AgentService,
  AiEventHandlers,
  AI_CONSUMER,
} from '../modules/ai/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * LA DEMO DE IA, de extremo a extremo (T5.34).
 *
 * El criterio del backlog: **acción determinista + consulta con datos vivos +
 * carrito + derivación con contexto, en una pantalla**. «En una pantalla»
 * significa una sola conversación: es lo que se le enseña a un dueño en una
 * reunión de ventas, y si algún paso hay que provocarlo desde fuera, la demo no
 * se puede hacer.
 *
 * Todo pasa por el camino real —mensaje entrante, outbox, consumidor,
 * agente— y las respuestas se leen del HILO, no del valor devuelto: lo que el
 * dueño ve en la demo es la bandeja.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const HOST = 'demoia.sahana.food';
const TELEFONO = '+51987330001';

suite('Demo de IA en una conversación', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantId = '';
  let brandId = '';
  let conversationId = '';
  let conversations: ConversationsService;
  let aiHandlers: ReturnType<AiEventHandlers['handlers']>;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    conversations = app.get(ConversationsService);
    aiHandlers = app.get(AiEventHandlers).handlers();

    await seedPlans(pool);
    await pool.query('DELETE FROM ten_tenants WHERE name = $1', [
      'Demo IA Tenant',
    ]);

    const t = await app.get(TenancyService).provisionTenant({
      name: 'Demo IA Tenant',
      planCode: 'growth',
      owner: {
        email: 'demoia@sahana.test',
        password: 'password-demoia-1',
        fullName: 'Dueña Demo',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);

    const org = await withTenant(pool, tenantId, (ctx) =>
      seedDemoOrganization(ctx),
    );
    brandId = org.brandIds[0]!;
    await withTenant(pool, tenantId, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    // La tienda tiene que existir: sin dominio verificado no hay enlace de
    // carrito que mandar, y el paso del carrito de la demo se cae.
    const storefront = app.get(StorefrontService);
    const dominio = await storefront.registerDomain(tenantId, {
      brandId,
      host: HOST,
    });
    await storefront.verifyDomain(tenantId, dominio.id);

    // Configuración de rubro, como la dejaría el dueño en menos de 30 min.
    const config = app.get(AgentConfigService);
    const draft = await config.getDraft(tenantId, brandId);
    await config.updateDraft(tenantId, draft.id, {
      identity: { name: 'Sahanita', tone: 'amistoso', length: 'corta' },
      enabled: true,
    });
    await config.addRule(tenantId, draft.id, {
      name: 'Promociones',
      priority: 10,
      conditions: [{ kind: 'asks_about', value: 'promo, oferta, descuento' }],
      actions: [
        {
          kind: 'reply',
          value: 'Hoy tenemos 2x1 en pollo entero hasta las 6 p. m.',
        },
      ],
    });
    await config.publish(tenantId, draft.id);
    await app.get(AgentService).setBudget(tenantId, 1_000_000);
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  /** Mensaje del cliente → outbox → consumidor de IA, como en producción. */
  async function cliente(texto: string): Promise<void> {
    const r = await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: TELEFONO,
      text: texto,
      displayName: 'Cliente Demo',
    });
    conversationId = r.conversationId;

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
      100,
    );
    for (const mensaje of entregados) {
      await consumeEvent(
        { pool, consumer: AI_CONSUMER, handlers: aiHandlers as never },
        mensaje as never,
      );
    }
  }

  /** El hilo tal como lo ve el dueño en la bandeja. */
  async function hilo(): Promise<Array<{ authorType: string; text: string }>> {
    const mensajes = await conversations.listMessages(
      tenantId,
      conversationId,
      { includeNotes: true },
    );
    return mensajes.map((m) => ({
      authorType: m.authorType,
      text: String((m.payload as { text?: string }).text ?? ''),
    }));
  }

  it('LA DEMO ENTERA: promo por regla, precio con datos vivos, carrito y derivación', async () => {
    // --- 1. Acción determinista. Coste cero y respuesta exacta del dueño.
    await cliente('¿Tienen alguna promo hoy?');
    let mensajes = await hilo();
    const promo = mensajes.find((m) => m.authorType === 'bot');
    expect(promo?.text).toContain('2x1');

    const trasRegla = await app
      .get(AgentService)
      .traces(tenantId, conversationId);
    expect(trasRegla[0]!.resolution).toBe('rule');
    // Lo que hace vendible el agente: esta respuesta NO cuesta tokens.
    expect(trasRegla[0]!.credits).toBe(0);

    // --- 2. Datos vivos: el precio sale del catálogo, no de la memoria.
    await cliente('¿Cuánto cuesta el pollo a la brasa?');
    const trazas = await app.get(AgentService).traces(tenantId, conversationId);
    const precio = trazas[1]!;
    expect(precio.resolution).toBe('llm');
    expect(JSON.stringify(precio.toolsCalled)).toContain('catalog.search');

    // --- 3. Carrito: intención de compra → enlace a la tienda.
    await cliente('Quiero pedir uno para llevar');
    mensajes = await hilo();
    const conEnlace = mensajes.filter((m) => m.text.includes(HOST));
    expect(
      conEnlace.length,
      'la intención de compra tiene que producir un enlace de carrito',
    ).toBeGreaterThan(0);

    const url = /https:\/\/[^\s]+/.exec(conEnlace[0]!.text)![0];
    const cartToken = url.split('/').pop()!;

    // El enlace FUNCIONA: se abre sin sesión y es un carrito de esta marca.
    const carrito = await request(app.getHttpServer())
      .get(`/api/v1/shop/carts/${cartToken}`)
      .set('host', HOST)
      .expect(200);
    expect(carrito.body.lines).toEqual([]);
    // Vacío a propósito: lo que se compra se decide en el checkout
    // estructurado. Una compra confirmada por texto libre es una compra que
    // nadie puede demostrar (ADR-0011 §2).

    // --- 4. Derivación CON CONTEXTO. Es el paso que vende la demo: el humano
    //        no abre con «hola, ¿en qué puedo ayudarte?».
    await cliente('El pedido de ayer llegó frío, quiero hablar con alguien');

    const conversacion = await conversations.getConversation(
      tenantId,
      conversationId,
    );
    expect(conversacion.status).toBe('waiting_human');

    const resumen = await withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        handoff_summary: { intent?: string; notes?: string } | null;
      }>('SELECT handoff_summary FROM cnv_conversations WHERE id = $1', [
        conversationId,
      ]);
      return rows[0]!.handoff_summary;
    });
    expect(resumen?.intent).toContain('frío');

    // Y el hilo completo sigue ahí: el humano lee lo que el bot dijo, incluida
    // la promoción que prometió. Sin eso, el traspaso obliga al cliente a
    // contarlo todo otra vez, que es cuando la gente abandona.
    const completo = await hilo();
    expect(
      completo.filter((m) => m.authorType === 'bot').length,
    ).toBeGreaterThanOrEqual(3);
    expect(completo.some((m) => m.text.includes('2x1'))).toBe(true);
  });

  it('tras la derivación el bot YA NO contesta', async () => {
    // El estado anterior manda: si el agente siguiera respondiendo después de
    // derivar, el cliente vería dos interlocutores a la vez.
    const antes = (await hilo()).filter((m) => m.authorType === 'bot').length;
    await cliente('¿Sigue ahí alguien?');
    const despues = (await hilo()).filter((m) => m.authorType === 'bot').length;
    expect(despues).toBe(antes);
  });
});
