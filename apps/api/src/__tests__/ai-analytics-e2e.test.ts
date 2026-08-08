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
import { ConversationsService } from '../modules/conversations/index.js';
import {
  AgentService,
  AgentConfigService,
  AgentAnalyticsService,
  AiEventHandlers,
  AI_CONSUMER,
} from '../modules/ai/index.js';
import { consumeEvent } from '../events/consumer.js';
import { relayOnce } from '../events/outbox.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Analítica del agente (spec 19 §6, T5.32).
 *
 * La pregunta que decide si el agente se queda encendido es **¿vende, y a qué
 * coste?**, y hasta ahora no se podía contestar: el vínculo entre conversación
 * y pedido vivía dentro del `payload` JSON de un mensaje de sistema.
 *
 * Estas pruebas montan tráfico real —reglas, consultas al catálogo, un reclamo
 * derivado y un pedido cerrado— y comprueban los números contra hechos que la
 * propia prueba provocó, no contra constantes copiadas de la implementación.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Analítica del agente', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantId = '';
  let token = '';
  let brandId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let agent: AgentService;
  let conversations: ConversationsService;
  let analytics: AgentAnalyticsService;
  let aiHandlers: ReturnType<AiEventHandlers['handlers']>;

  /** Conversación que acabó en pedido; se reutiliza en varias pruebas. */
  let convVendida = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    configureApp(app);
    await app.init();
    agent = app.get(AgentService);
    conversations = app.get(ConversationsService);
    analytics = app.get(AgentAnalyticsService);
    aiHandlers = app.get(AiEventHandlers).handlers();
    const config = app.get(AgentConfigService);

    await seedPlans(pool);
    const t = await app.get(TenancyService).provisionTenant({
      name: 'Analitica IA Tenant',
      planCode: 'growth',
      owner: {
        email: 'ia-analitica@sahana.test',
        password: 'password-ia-an-1',
        fullName: 'Dueña Analítica',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);

    org = await withTenant(pool, tenantId, (ctx) => seedDemoOrganization(ctx));
    brandId = org.brandIds[0]!;
    cat = await withTenant(pool, tenantId, (ctx) =>
      seedDemoCatalog(ctx, { brandId, locationId: org.locationId }),
    );

    const draft = await config.getDraft(tenantId, brandId);
    await config.updateDraft(tenantId, draft.id, {
      identity: { name: 'Sahanita' },
      enabled: true,
    });
    await config.addRule(tenantId, draft.id, {
      name: 'Horario',
      priority: 10,
      conditions: [{ kind: 'asks_about', value: 'horario, abren' }],
      actions: [{ kind: 'reply', value: 'Atendemos de 11:00 a 23:00.' }],
    });
    await config.publish(tenantId, draft.id);
    await agent.setBudget(tenantId, 1_000_000);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ia-analitica@sahana.test', password: 'password-ia-an-1' })
      .expect(201);
    token = login.body.accessToken;

    await montarTrafico();
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  /**
   * Tráfico de un día cualquiera.
   *
   * Tres conversaciones con formas distintas a propósito: una que compra, una
   * que solo pregunta y una que acaba en una persona. Si las tres fueran
   * iguales, las métricas cuadrarían por casualidad.
   */
  async function montarTrafico(): Promise<void> {
    // Todo el tráfico entra por `receiveInbound` y se drena por el outbox, como
    // en producción. Llamar a `agent.respond` a mano —que es lo que hacía la
    // primera versión de esta suite— habría medido un camino que ningún cliente
    // recorre, y habría dejado sin detectar que ese camino no existía.

    // (1) Conversación que VENDE: pregunta el horario (regla, gratis), pregunta
    //     el precio (herramienta) y cierra pedido.
    const vende = await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010001',
      text: '¿A qué hora abren?',
      displayName: 'Cliente Compra',
    });
    convVendida = vende.conversationId;
    await drenarHaciaIa();
    await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010001',
      text: '¿Cuánto cuesta el pollo?',
    });
    await drenarHaciaIa();

    await request(app.getHttpServer())
      .post(`/api/v1/conversations/${convVendida}/orders`)
      .set('authorization', `Bearer ${token}`)
      .send({
        locationId: org.locationId,
        customerName: 'Cliente Compra',
        lines: [
          {
            productId: cat.polloId,
            quantity: 1,
            modifierOptionIds: [cat.optionGrandeId],
          },
        ],
      })
      .expect(201);

    // (2) Conversación que solo pregunta, y por algo que NINGUNA fuente ni
    //     herramienta respalda: es la materia prima de «agrega una fuente
    //     sobre X».
    for (const texto of [
      '¿Los cubiertos son biodegradables?',
      '¿Y las servilletas son biodegradables?',
    ]) {
      await conversations.receiveInbound(tenantId, {
        brandId,
        channel: 'whatsapp',
        phone: '+51987010002',
        text: texto,
        displayName: 'Cliente Pregunta',
      });
      await drenarHaciaIa();
    }

    // (3) Conversación que acaba en una persona (reclamo).
    await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010003',
      text: 'Mi pedido llegó frío',
      displayName: 'Cliente Reclamo',
    });
    await drenarHaciaIa();
  }

  /**
   * Drena el outbox y se lo da al consumidor de IA.
   *
   * Es el camino COMPLETO —mensaje → outbox → relay → consumidor → agente—, y
   * no un atajo, porque el eslabón que faltaba era justamente ese.
   */
  const drenarHaciaIa = async (): Promise<number> => {
    let aplicados = 0;
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      const entregados: Array<Record<string, unknown>> = [];
      const publicados = await relayOnce(
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
        const r = await consumeEvent(
          { pool, consumer: AI_CONSUMER, handlers: aiHandlers as never },
          mensaje as never,
        );
        if (r === 'processed') aplicados++;
      }
      if (publicados === 0) break;
    }
    return aplicados;
  };

  const rango = () => ({
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(Date.now() + 60 * 60 * 1000),
  });

  // ------------------------------------------------------------------------

  it('cuenta conversaciones atendidas solo por IA frente a derivadas', async () => {
    const a = await analytics.overview(tenantId, rango());
    expect(a.conversations.count).toBe(3);
    expect(a.conversations.handedOff).toBe(1);
    expect(a.conversations.aiOnly).toBe(2);
    // Un tercio, en puntos básicos.
    expect(a.conversations.handoffBps).toBe(3333);
  });

  it('EL VÍNCULO conversación→pedido es una fila, no un JSON', async () => {
    // Es lo que hace que la conversión se pueda CONTAR. Mientras vivió dentro
    // del payload de un mensaje, la métrica que decide si el agente sigue
    // encendido salía de rebuscar en texto.
    const filas = await withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT order_id FROM cnv_conversation_orders WHERE conversation_id = $1`,
        [convVendida],
      );
      return rows;
    });
    expect(filas).toHaveLength(1);
  });

  it('la conversión se reparte por origen y los tres orígenes SALEN', async () => {
    const a = await analytics.overview(tenantId, rango());
    const porOrigen = new Map(a.conversionByOrigin.map((o) => [o.origin, o]));

    // Los tres siempre presentes: una fila ausente en el panel se lee como «no
    // hay datos», y cero conversiones por IA es un dato.
    expect([...porOrigen.keys()].sort()).toEqual(['ai', 'human', 'mixed']);

    // La que vendió tuvo bot Y persona (el pedido lo creó alguien desde la
    // bandeja): es mixta, no de IA pura.
    expect(porOrigen.get('mixed')!.conversations).toBe(1);
    expect(porOrigen.get('mixed')!.converted).toBe(1);
    expect(porOrigen.get('mixed')!.conversionBps).toBe(10_000);

    // Las otras dos las atendió solo el bot y no vendieron. La del reclamo
    // cuenta como atendida por IA aunque el bot no escribiera nada: derivar
    // ES actuar, y es lo que el agente hizo bien.
    expect(porOrigen.get('ai')!.conversations).toBe(2);
    expect(porOrigen.get('ai')!.converted).toBe(0);
    expect(porOrigen.get('ai')!.conversionBps).toBe(0);
  });

  it('mide el KPI de la fase: mensajes por pedido', async () => {
    const a = await analytics.overview(tenantId, rango());
    expect(a.messagesPerOrder.orders).toBe(1);
    expect(a.messagesPerOrder.target).toBe(8);
    expect(a.messagesPerOrder.value).not.toBeNull();
    // El criterio del backlog. Con este tráfico se cumple de sobra; lo que la
    // prueba fija es que el número EXISTE y se compara, no su valor exacto.
    expect(a.messagesPerOrder.meetsTarget).toBe(true);
  });

  it('el coste sale en CRÉDITOS, y por conversación y por pedido', async () => {
    const a = await analytics.overview(tenantId, rango());
    // Hubo generación: la consulta de precio pasó por el modelo.
    expect(a.cost.credits).toBeGreaterThan(0);
    expect(a.cost.inputTokens).toBeGreaterThan(0);
    expect(a.cost.creditsPerConversation).not.toBeNull();
    expect(a.cost.creditsPerOrder).not.toBeNull();
    // Con un solo pedido, el coste por pedido es todo el gasto del rango.
    expect(a.cost.creditsPerOrder).toBe(a.cost.credits);
  });

  it('sin pedidos, el coste por pedido es NULL y no cero', async () => {
    // Un cero se lee como «gratis». Lo que pasó es que se gastaron créditos sin
    // vender, que es lo contrario y lo que hay que mirar.
    const futuro = {
      from: new Date(Date.now() + 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 48 * 60 * 60 * 1000),
    };
    const a = await analytics.overview(tenantId, futuro);
    expect(a.cost.creditsPerOrder).toBeNull();
    expect(a.messagesPerOrder.meetsTarget).toBeNull();
  });

  it('separa lo que costó tokens de lo que se resolvió por regla', async () => {
    const a = await analytics.overview(tenantId, rango());
    const porTipo = new Map(a.resolutions.map((r) => [r.resolution, r.count]));
    // La pregunta por el horario tenía regla: coste cero.
    expect(porTipo.get('rule')).toBe(1);
    // El reclamo derivó sin pasar por el modelo.
    expect(porTipo.get('handoff')).toBe(1);
    expect(porTipo.get('llm')).toBe(3);
  });

  it('las reglas más disparadas se cuentan DEL RANGO, no del acumulado', async () => {
    const a = await analytics.overview(tenantId, rango());
    expect(a.topRules).toHaveLength(1);
    expect(a.topRules[0]!.name).toBe('Horario');
    expect(a.topRules[0]!.hits).toBe(1);

    // Un rango sin tráfico no hereda los disparos históricos de la regla: si se
    // leyera `hit_count`, esta lista saldría igual de llena siempre.
    const vacio = await analytics.overview(tenantId, {
      from: new Date(Date.now() + 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    expect(vacio.topRules).toEqual([]);
  });

  it('SUGIERE qué fuente falta: el tema preguntado sin respaldo', async () => {
    const a = await analytics.overview(tenantId, rango());
    const terminos = a.topicsWithoutSource.map((t) => t.term);
    // Se preguntó dos veces por lo mismo y nada lo respaldaba. Es la única
    // métrica del panel que le dice al dueño QUÉ HACER.
    expect(terminos).toContain('biodegradables');
    const tema = a.topicsWithoutSource.find(
      (t) => t.term === 'biodegradables',
    )!;
    expect(tema.messages).toBe(2);
    // Con ejemplos literales: un número sin ellos no se discute, se cree o no.
    expect(tema.examples.length).toBeGreaterThan(0);

    // Lo que SÍ tuvo herramienta detrás no aparece como carencia.
    expect(terminos).not.toContain('pollo');
  });

  it('el endpoint responde y respeta el filtro por marca', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/ai/analytics')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(r.body.conversations.count).toBe(3);

    // La otra marca del tenant no tuvo ni una conversación: filtrar por ella
    // tiene que dar cero, no el total del tenant.
    const otra = await request(app.getHttpServer())
      .get(`/api/v1/ai/analytics?brand=${org.brandIds[1]}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(otra.body.conversations.count).toBe(0);
  });

  it('un rango invertido se rechaza', async () => {
    const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const hoy = new Date().toISOString();
    await request(app.getHttpServer())
      .get(`/api/v1/ai/analytics?from=${hoy}&to=${ayer}`)
      .set('authorization', `Bearer ${token}`)
      .expect(422);
  });

  // ------------------------------------------------ El agente es ALCANZABLE

  it('UN MENSAJE DE UN CLIENTE LLEGA AL AGENTE Y RECIBE RESPUESTA', async () => {
    // La prueba que faltaba. Toda la plataforma del agente estaba construida y
    // probada, y la única ruta que la llamaba era el sandbox del dueño: un
    // cliente escribiendo por WhatsApp no recibía nada. Aquí no se llama a
    // `respond`: se recibe un mensaje y se drena el outbox, como en producción.
    const conv = await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010009',
      text: '¿A qué hora abren?',
      displayName: 'Cliente Real',
    });

    await drenarHaciaIa();

    const hilo = await conversations.listMessages(
      tenantId,
      conv.conversationId,
    );
    const delBot = hilo.filter((m) => m.authorType === 'bot');
    expect(delBot).toHaveLength(1);
    // La respuesta de la regla, en el hilo. Que quede como mensaje del BOT y
    // no de un agente es RN-CNV-04: cuando el cliente reclame por lo que se le
    // dijo, la pregunta «¿esto lo dijo la IA o una persona?» tiene respuesta.
    expect(String(delBot[0]!.payload['text'])).toContain('11:00');
  });

  it('una entrega REPETIDA no contesta dos veces', async () => {
    const conv = await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010010',
      text: '¿A qué hora abren?',
      displayName: 'Cliente Repetido',
    });

    // Se captura el evento y se entrega DOS veces con otro nombre de
    // consumidor, para saltarse el `inbox` y simular exactamente la reentrega
    // que ocurre si el proceso muere entre responder y marcar.
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
    const suyo = entregados.find(
      (e) =>
        e['eventType'] === 'conversation.message_received' &&
        (e['payload'] as { conversationId?: string }).conversationId ===
          conv.conversationId,
    )!;

    for (const consumidor of ['ai-reentrega-1', 'ai-reentrega-2']) {
      await consumeEvent(
        { pool, consumer: consumidor, handlers: aiHandlers as never },
        suyo as never,
      );
    }

    const hilo = await conversations.listMessages(
      tenantId,
      conv.conversationId,
    );
    // Dos respuestas idénticas seguidas se ven, en WhatsApp, exactamente como
    // un bot roto.
    expect(hilo.filter((m) => m.authorType === 'bot')).toHaveLength(1);
  });

  it('con una PERSONA al mando el bot no se mete', async () => {
    const conv = await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010011',
      text: 'Hola',
      displayName: 'Cliente Asignado',
    });
    await conversations.handoffToHuman(tenantId, conv.conversationId, {
      intent: 'Quiere hablar con alguien',
      notes: 'Pidió una persona',
    });

    await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987010011',
      text: '¿A qué hora abren?',
    });
    await drenarHaciaIa();

    const hilo = await conversations.listMessages(
      tenantId,
      conv.conversationId,
    );
    // Es la mitad de RN-CNV-02 que hace útil el traspaso: si el bot siguiera
    // contestando, el cliente vería dos interlocutores a la vez.
    expect(hilo.filter((m) => m.authorType === 'bot')).toHaveLength(0);
  });
});
