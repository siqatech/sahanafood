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
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Bandeja omnicanal (spec 18, T5.19–T5.21).
 *
 * Las cuatro pruebas que la spec marca:
 *
 * · **Dos marcas, mismo teléfono → dos conversaciones que no se cruzan**
 *   (RN-CNV-01). Es LA prueba del módulo.
 * · **Ventana expirada bloquea texto libre y ofrece plantillas** (RN-CNV-03).
 * · **El traspaso bot→humano conserva el contexto** (RN-CNV-02).
 * · **Crear pedido desde la bandeja pasa por Ordering** (RN-CNV-05).
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

const TELEFONO = '+51987001122';

suite('Bandeja omnicanal', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tokenA = '';
  let ownerId = '';
  let org: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let cat: Awaited<ReturnType<typeof seedDemoCatalog>>;
  let conversations: ConversationsService;

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

    await seedPlans(pool);
    const a = await app.get(TenancyService).provisionTenant({
      name: 'Bandeja Tenant',
      planCode: 'growth',
      owner: {
        email: 'cnv-a@sahana.test',
        password: 'password-cnv-a-1',
        fullName: 'Dueña Bandeja',
      },
    });
    tenantA = a.tenantId;
    ownerId = a.ownerUserId;
    created.push(tenantA);

    org = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    // El catálogo va en la marca 0; la marca 1 comparte cocina (dark kitchen).
    cat = await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, {
        brandId: org.brandIds[0]!,
        locationId: org.locationId,
      }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'cnv-a@sahana.test', password: 'password-cnv-a-1' })
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

  // -------------------------------------------------------- RN-CNV-01

  it('LA PRUEBA DEL MÓDULO: dos marcas, mismo teléfono, dos conversaciones', async () => {
    // Va contra lo que hace un help desk normal —una conversación por persona—
    // por dos motivos concretos: el branding de la respuesta (quien escribe a
    // la pollería no debe recibir el saludo del wok) y que el coste de
    // atención tiene que poder imputarse a una marca.
    const enPolleria = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: TELEFONO,
      text: '¿Tienen pollo a la brasa?',
      displayName: 'Marta Ríos',
    });
    const enWok = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[1]!,
      channel: 'whatsapp',
      phone: TELEFONO,
      text: '¿Y arroz chaufa?',
    });

    expect(enPolleria.conversationId).not.toBe(enWok.conversationId);

    // Y los hilos NO se cruzan: cada uno ve solo lo suyo.
    const hiloPolleria = await conversations.listMessages(
      tenantA,
      enPolleria.conversationId,
    );
    const hiloWok = await conversations.listMessages(
      tenantA,
      enWok.conversationId,
    );
    expect(JSON.stringify(hiloPolleria)).toContain('pollo a la brasa');
    expect(JSON.stringify(hiloPolleria)).not.toContain('chaufa');
    expect(JSON.stringify(hiloWok)).toContain('chaufa');
    expect(JSON.stringify(hiloWok)).not.toContain('pollo a la brasa');

    // Un agente las ve LAS DOS en una sola bandeja, con su marca al lado:
    // es el criterio de aceptación de la spec.
    const bandeja = await auth(http().get('/api/v1/conversations')).expect(200);
    const delTelefono = bandeja.body.filter(
      (c: { contactPhone: string }) => c.contactPhone === TELEFONO,
    );
    expect(delTelefono).toHaveLength(2);
    expect(new Set(delTelefono.map((c: { brandName: string }) => c.brandName)).size).toBe(2);
  });

  it('el mismo cliente escribiendo dos veces sigue en su hilo', async () => {
    const primero = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: TELEFONO,
      text: '¿Cuánto demora?',
    });
    const segundo = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: TELEFONO,
      text: '¿Hola?',
    });
    expect(primero.conversationId).toBe(segundo.conversationId);
  });

  it('un webhook repetido NO duplica el mensaje en el hilo', async () => {
    // Los webhooks de Meta reintentan; duplicar dejaría al cliente viendo su
    // propia pregunta dos veces.
    const uno = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987009999',
      text: 'Mensaje con id de proveedor',
      waMessageId: 'wamid.DUPLICADO_1',
    });
    const dos = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987009999',
      text: 'Mensaje con id de proveedor',
      waMessageId: 'wamid.DUPLICADO_1',
    });
    expect(dos.duplicate).toBe(true);
    expect(dos.messageId).toBe(uno.messageId);

    const hilo = await conversations.listMessages(tenantA, uno.conversationId);
    expect(
      hilo.filter((m) => JSON.stringify(m.payload).includes('id de proveedor')),
    ).toHaveLength(1);
  });

  // -------------------------------------------------------- RN-CNV-03

  it('VENTANA EXPIRADA: no deja escribir libre, y ofrece plantillas', async () => {
    // La regla entera. Dejar escribir y que Meta lo descarte en silencio es el
    // peor de los dos mundos: el agente cree que contestó y el cliente no
    // recibe nada.
    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        `INSERT INTO cnv_quick_replies (tenant_id, shortcut, body)
         VALUES ($1,'seguimiento','Hola, seguimos tu pedido.')`,
        [tenantA],
      ),
    );

    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987005555',
      text: 'Pregunta de hace dos días',
      at: new Date(Date.now() - 30 * 3_600_000),
    });

    const r = await auth(
      http().post(`/api/v1/conversations/${conversationId}/messages`),
    )
      .send({ kind: 'text', text: 'Te respondo tarde' })
      .expect(422);

    expect(r.body.code).toBe('WA_WINDOW_EXPIRED');
    expect(r.body.detail).toContain('plantilla aprobada');
    // Y dice QUÉ SÍ se puede mandar: un error que solo dice «no» deja al
    // agente sin salida y acaba en un «te escribo por privado» sin registrar.
    expect(r.body.availableTemplates).toContain('seguimiento');

    // La plantilla SÍ sale.
    await auth(http().post(`/api/v1/conversations/${conversationId}/messages`))
      .send({ kind: 'template', templateName: 'seguimiento' })
      .expect(201);
  });

  it('dentro de la ventana se escribe libre, con cuenta regresiva visible', async () => {
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987006666',
      text: 'Acabo de escribir',
    });

    const vista = await auth(
      http().get(`/api/v1/conversations/${conversationId}`),
    ).expect(200);
    expect(vista.body.window.state).toBe('open');
    expect(vista.body.window.canSendFreeform).toBe(true);
    expect(vista.body.window.minutesRemaining).toBeGreaterThan(23 * 60);
    expect(vista.body.window.label).toContain('Ventana abierta');

    await auth(http().post(`/api/v1/conversations/${conversationId}/messages`))
      .send({ kind: 'text', text: 'Claro, dime' })
      .expect(201);
  });

  // -------------------------------------------------------- RN-CNV-02

  it('EL TRASPASO bot→humano CONSERVA el contexto', async () => {
    // La alternativa es lo que hace todo el mundo: el humano abre con «hola,
    // ¿en qué puedo ayudarte?» y el cliente lo cuenta todo otra vez. Es el
    // momento exacto en el que la gente abandona.
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987007777',
      text: 'Quiero dos pollos para las 8',
    });

    await conversations.handoffToHuman(tenantA, conversationId, {
      intent: 'Pedir 2 pollos a la brasa para las 20:00',
      captured: { cantidad: 2, hora: '20:00' },
      notes: 'Ya preguntó por el precio; se le dijo S/ 32.',
    });

    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        status: string;
        handoff_summary: Record<string, unknown>;
        ai_enabled: boolean;
      }>(
        'SELECT status, handoff_summary, ai_enabled FROM cnv_conversations WHERE id = $1',
        [conversationId],
      );
      return rows[0]!;
    });

    expect(fila.status).toBe('waiting_human');
    expect(fila.handoff_summary['intent']).toContain('2 pollos');
    expect(fila.handoff_summary['captured']).toMatchObject({ cantidad: 2 });
    // La IA se apaga en ESTA conversación: si siguiera contestando mientras el
    // humano escribe, el cliente vería dos respuestas a la misma pregunta.
    expect(fila.ai_enabled).toBe(false);
  });

  it('un traspaso SIN resumen se rechaza', async () => {
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987008888',
      text: 'Hola',
    });
    await expect(
      conversations.handoffToHuman(tenantA, conversationId, { intent: '  ' }),
    ).rejects.toThrow(/resumen de contexto/i);
  });

  // -------------------------------------------------------- RN-CNV-05 / 07

  it('CREAR PEDIDO desde la bandeja pasa por Ordering, no por SQL', async () => {
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987004444',
      text: 'Mándame un pollo grande',
      displayName: 'Pedro Salas',
    });

    const r = await auth(
      http().post(`/api/v1/conversations/${conversationId}/orders`),
    )
      .send({
        locationId: org.locationId,
        customerName: 'Pedro Salas',
        lines: [
          {
            productId: cat.polloId,
            quantity: 1,
            modifierOptionIds: [cat.optionGrandeId],
          },
        ],
      })
      .expect(201);

    // El pedido existe con el canal correcto y el teléfono del contacto: es lo
    // que demuestra que pasó por `submit` y no por un INSERT.
    const pedido = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        channel: string;
        customer_phone: string | null;
        total: string;
        status: string;
      }>(
        'SELECT channel, customer_phone, total, status FROM ord_orders WHERE id = $1',
        [r.body.orderId],
      );
      return rows[0]!;
    });
    expect(pedido.channel).toBe('whatsapp');
    expect(pedido.customer_phone).toBe('+51987004444');
    // 30 (precio BASE) + 5 del tamaño grande = 35, no 37: el canal es
    // `whatsapp` y el catálogo demo solo tiene precio propio para `web`, así
    // que se resuelve al base (RN-CAT-01). Que el precio dependa del canal es
    // justo lo que demuestra que pasó por el dominio y no por un INSERT con
    // un total inventado.
    expect(pedido.total).toBe('35.0000');

    // Y queda rastro en el hilo: quien abra la conversación mañana tiene que
    // ver que de aquí salió un pedido, y cuál.
    const hilo = await conversations.listMessages(tenantA, conversationId);
    const sistema = hilo.find((m) => m.kind === 'system');
    expect(sistema?.payload['orderId']).toBe(r.body.orderId);
  });

  it('las NOTAS INTERNAS no salen en el hilo salvo que se pidan', async () => {
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987003333',
      text: 'Consulta',
    });

    await auth(http().post(`/api/v1/conversations/${conversationId}/messages`))
      .send({ kind: 'note', text: 'OJO: este cliente ya reclamó dos veces' })
      .expect(201);

    const publico = await auth(
      http().get(`/api/v1/conversations/${conversationId}/messages`),
    ).expect(200);
    expect(JSON.stringify(publico.body)).not.toContain('reclamó dos veces');

    const conNotas = await auth(
      http().get(
        `/api/v1/conversations/${conversationId}/messages?includeNotes=true`,
      ),
    ).expect(200);
    expect(JSON.stringify(conNotas.body)).toContain('reclamó dos veces');
  });

  it('asignar y resolver mueven la conversación por la bandeja', async () => {
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987002222',
      text: 'Necesito ayuda',
    });

    await auth(http().post(`/api/v1/conversations/${conversationId}/assign`))
      .send({ assigneeId: ownerId })
      .expect(201);

    const asignadas = await auth(
      http().get(`/api/v1/conversations?status=assigned&assignee=${ownerId}`),
    ).expect(200);
    expect(asignadas.body.map((c: { id: string }) => c.id)).toContain(
      conversationId,
    );

    await auth(
      http().post(`/api/v1/conversations/${conversationId}/resolve`),
    ).expect(201);

    // Y resuelta, un mensaje nuevo abre una conversación nueva: el índice
    // único es parcial sobre las no resueltas.
    const nueva = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987002222',
      text: 'Otra cosa',
    });
    expect(nueva.conversationId).not.toBe(conversationId);
  });

  it('la búsqueda encuentra por teléfono y por texto (RN-CNV-08)', async () => {
    await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987001111',
      text: 'Quiero pagar con yape por favor',
    });

    const porTelefono = await auth(
      http().get('/api/v1/conversations?search=987001111'),
    ).expect(200);
    expect(porTelefono.body.length).toBeGreaterThan(0);

    const porTexto = await auth(
      http().get('/api/v1/conversations?search=yape'),
    ).expect(200);
    expect(porTexto.body.length).toBeGreaterThan(0);
  });

  it('el contador de mensajes y el coste son visibles (RN-CNV-04)', async () => {
    const { conversationId } = await conversations.receiveInbound(tenantA, {
      brandId: org.brandIds[0]!,
      channel: 'whatsapp',
      phone: '+51987000001',
      text: 'Hola',
    });
    await conversations.sendMessage(tenantA, conversationId, {
      kind: 'text',
      text: 'Buenas',
      authorType: 'agent',
      authorId: ownerId,
      costEstimateMinor: 500, // S/ 0,05
    });

    const vista = await auth(
      http().get(`/api/v1/conversations/${conversationId}`),
    ).expect(200);
    expect(vista.body.messageCount).toBe(2);
    expect(vista.body.costTotal).toBe('0.0500');
  });
});
