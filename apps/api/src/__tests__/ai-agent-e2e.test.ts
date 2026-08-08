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
  KnowledgeService,
  AI_PROVIDER,
  type AiProvider,
} from '../modules/ai/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Agente de IA (spec 19, ADR-0011, T5.22–T5.30).
 *
 * Las pruebas que la spec 19 §7 marca:
 *
 * · **Precio inventado imposible** — el validador, probado adversarialmente.
 * · **Presupuesto agotado degrada a reglas**, no a errores.
 * · **El sandbox reproduce la traza**.
 * · **Aislamiento de fuentes entre tenants** (RAG con filtro por `tenant_id`).
 *
 * Y la de ADR-0011 que sostiene todo lo demás: **apagar la IA deja el sistema
 * 100 % funcional**.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Agente de IA', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantA = '';
  let tenantB = '';
  let tokenA = '';
  let brandA = '';
  let orgA: Awaited<ReturnType<typeof seedDemoOrganization>>;
  let agent: AgentService;
  let knowledge: KnowledgeService;
  let conversations: ConversationsService;
  let configIdA = '';
  let conversacionA = '';

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
    knowledge = app.get(KnowledgeService);
    conversations = app.get(ConversationsService);

    await seedPlans(pool);
    const tenancy = app.get(TenancyService);

    const a = await tenancy.provisionTenant({
      name: 'IA Tenant A',
      planCode: 'growth',
      owner: {
        email: 'ia-a@sahana.test',
        password: 'password-ia-a-1',
        fullName: 'Dueña IA A',
      },
    });
    tenantA = a.tenantId;
    created.push(tenantA);

    const b = await tenancy.provisionTenant({
      name: 'IA Tenant B',
      planCode: 'growth',
      owner: {
        email: 'ia-b@sahana.test',
        password: 'password-ia-b-1',
        fullName: 'Dueño IA B',
      },
    });
    tenantB = b.tenantId;
    created.push(tenantB);

    orgA = await withTenant(pool, tenantA, (ctx) => seedDemoOrganization(ctx));
    brandA = orgA.brandIds[0]!;
    await withTenant(pool, tenantA, (ctx) =>
      seedDemoCatalog(ctx, { brandId: brandA, locationId: orgA.locationId }),
    );

    // B solo necesita existir con su organización: lo que se prueba de B es
    // que sus FUENTES no se ven desde A.
    await withTenant(pool, tenantB, (ctx) => seedDemoOrganization(ctx));

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ia-a@sahana.test', password: 'password-ia-a-1' })
      .expect(201);
    tokenA = login.body.accessToken;

    const conv = await conversations.receiveInbound(tenantA, {
      brandId: brandA,
      channel: 'whatsapp',
      phone: '+51987770000',
      text: 'Hola',
    });
    conversacionA = conv.conversationId;

    // Sin fila de presupuesto el límite es 0 y todo degrada, que es el
    // comportamiento correcto (un tenant sin créditos no genera). Las pruebas
    // que ejercitan el modelo necesitan saldo; la de degradación lo agota a
    // propósito y lo repone al terminar.
    await app.get(AgentService).setBudget(tenantA, 100_000);
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('authorization', `Bearer ${tokenA}`);

  // ------------------------------------------- ADR-0011: la IA es opcional

  it('SIN AGENTE PUBLICADO el sistema sigue funcionando', async () => {
    // El criterio de ADR-0011: apagar la IA deja el sistema 100 % funcional.
    // No es un error, es un tenant que no la activó.
    const r = await agent.respond(tenantA, {
      conversationId: conversacionA,
      brandId: brandA,
      text: '¿Cuánto cuesta el pollo?',
    });
    expect(r.resolution).toBe('handoff');
    expect(r.text).toBeNull();
  });

  // -------------------------------------------------- Configuración (T5.29)

  it('el borrador se crea, se edita, se le añaden reglas y se publica', async () => {
    const borrador = await auth(
      http().get(`/api/v1/ai/config?brand=${brandA}`),
    ).expect(200);
    configIdA = borrador.body.id;
    expect(borrador.body.status).toBe('draft');

    await auth(http().put(`/api/v1/ai/config/${configIdA}`))
      .send({
        identity: { name: 'Sahanita', tone: 'amistoso' },
        guidelines: ['Saluda por el nombre de la marca.'],
        enabled: true,
      })
      .expect(200);

    // Las reglas se configuran en el BORRADOR, que es el punto del sandbox:
    // se prueban antes de que las vea un cliente.
    await auth(http().post(`/api/v1/ai/config/${configIdA}/rules`))
      .send({
        name: 'Horario',
        priority: 10,
        conditions: [{ kind: 'asks_about', value: 'horario, abren' }],
        actions: [{ kind: 'reply', value: 'Atendemos de 11:00 a 23:00.' }],
      })
      .expect(201);

    const publicada = await auth(
      http().post(`/api/v1/ai/config/${configIdA}/publish`),
    ).expect(201);
    expect(publicada.body.status).toBe('published');
    expect(publicada.body.rules).toHaveLength(1);

    // Publicada es INMUTABLE: editarla cambiaría lo que respondió el agente
    // ayer sin dejar rastro, y la traza dejaría de ser reproducible.
    await auth(http().put(`/api/v1/ai/config/${configIdA}`))
      .send({ guidelines: ['Otra cosa'] })
      .expect(422);
    // Y tampoco se le pueden añadir reglas.
    await auth(http().post(`/api/v1/ai/config/${configIdA}/rules`))
      .send({
        name: 'Tardía',
        conditions: [{ kind: 'contains', value: 'x' }],
        actions: [{ kind: 'reply', value: 'y' }],
      })
      .expect(422);
  });

  it('ROLLBACK en un clic: se apunta a otra versión, no se copia nada', async () => {
    const nuevo = await auth(
      http().get(`/api/v1/ai/config?brand=${brandA}`),
    ).expect(200);
    await auth(http().put(`/api/v1/ai/config/${nuevo.body.id}`))
      .send({ identity: { name: 'Versión 2' }, enabled: true })
      .expect(200);
    await auth(
      http().post(`/api/v1/ai/config/${nuevo.body.id}/publish`),
    ).expect(201);

    // La v1 quedó archivada, no borrada: es lo que hace posible volver.
    const vuelta = await auth(
      http().post(`/api/v1/ai/config/${configIdA}/rollback`),
    ).expect(201);
    expect(vuelta.body.status).toBe('published');
    expect(vuelta.body.identity.name).toBe('Sahanita');

    const versiones = await auth(
      http().get(`/api/v1/ai/config/versions?brand=${brandA}`),
    ).expect(200);
    expect(
      versiones.body.filter(
        (v: { status: string }) => v.status === 'published',
      ),
    ).toHaveLength(1);
  });

  // ---------------------------------------------- Jerarquía determinista

  it('LA REGLA GANA AL MODELO, con coste cero', async () => {
    const r = await agent.respond(tenantA, {
      conversationId: conversacionA,
      brandId: brandA,
      text: '¿A qué hora abren?',
    });
    expect(r.resolution).toBe('rule');
    expect(r.text).toContain('11:00');
    expect(r.trace.credits).toBe(0);
    expect(r.trace.ruleName).toBe('Horario');
  });

  it('UN RECLAMO va a un humano aunque no haya regla (RN-AIA-03)', async () => {
    // Guardrail fijo, no configuración: dejar que un modelo gestione una queja
    // es cómo se pierde a un cliente enfadado dos veces.
    const conv = await conversations.receiveInbound(tenantA, {
      brandId: brandA,
      channel: 'whatsapp',
      phone: '+51987771111',
      text: 'Mi pedido no llegó y quiero una devolución',
    });
    const r = await agent.respond(tenantA, {
      conversationId: conv.conversationId,
      brandId: brandA,
      text: 'Mi pedido no llegó y quiero una devolución',
    });
    expect(r.resolution).toBe('handoff');

    // Y el traspaso lleva su contexto: el humano no empieza de cero.
    const fila = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{
        handoff_summary: { intent: string };
      }>('SELECT handoff_summary FROM cnv_conversations WHERE id = $1', [
        conv.conversationId,
      ]);
      return rows[0]!;
    });
    expect(fila.handoff_summary.intent).toContain('devolución');
  });

  // ------------------------------------------------- El validador (T5.24)

  it('EL PRECIO SALE DE LA HERRAMIENTA, no de la memoria del modelo', async () => {
    const conv = await conversations.receiveInbound(tenantA, {
      brandId: brandA,
      channel: 'whatsapp',
      phone: '+51987772222',
      text: '¿Cuánto cuesta el pollo?',
    });
    const r = await agent.respond(tenantA, {
      conversationId: conv.conversationId,
      brandId: brandA,
      text: '¿Cuánto cuesta el pollo?',
    });

    // Se consultó el catálogo y la respuesta pasó el validador.
    expect(r.trace.toolsCalled).toContain('catalog.search');
    expect(r.trace.validator?.ok).toBe(true);
    expect(r.resolution).toBe('llm');
  });

  it('ADVERSARIAL: un modelo que INVENTA un precio queda bloqueado', async () => {
    // La prueba que pide la spec 19 §7: el precio inventado tiene que ser
    // IMPOSIBLE, no improbable. Se levanta la aplicación entera con un
    // proveedor que responde con un precio que nadie consultó, y se comprueba
    // que esa respuesta NO llega al cliente. Probar solo el validador aparte
    // demostraría que la función funciona, no que está conectada.
    const inventor: AiProvider = {
      name: 'inventor',
      chat: async () => ({
        text: 'El pollo cuesta S/ 99.00 y te lo dejo hoy.',
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 10,
      }),
      embed: async (t) => t.map(() => new Array(1536).fill(0.001) as number[]),
    };

    const conInventor = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_PROVIDER)
      .useValue(inventor)
      .compile();
    const appMala = conInventor.createNestApplication(NEST_APP_OPTIONS);
    configureApp(appMala);
    await appMala.init();

    try {
      const agenteMalo = appMala.get(AgentService);
      const conv = await conversations.receiveInbound(tenantA, {
        brandId: brandA,
        channel: 'whatsapp',
        phone: '+51987773333',
        text: '¿Cuánto cuesta el pollo?',
      });

      const r = await agenteMalo.respond(tenantA, {
        conversationId: conv.conversationId,
        brandId: brandA,
        text: '¿Cuánto cuesta el pollo?',
      });

      expect(r.resolution).toBe('blocked');
      // Lo importante: el texto NO sale.
      expect(r.text).toBeNull();
      expect(r.trace.validator?.ok).toBe(false);
      expect(r.trace.validator?.reason).toContain('99.00');
      // Y se deriva a una persona en vez de reformular: pedirle otra redacción
      // al mismo modelo que acaba de inventar un precio es pedirle que lo
      // invente mejor.
      expect(r.actions[0]!.kind).toBe('handoff');

      // La traza guarda lo que el modelo QUERÍA decir: sin eso, «bloqueado» no
      // dice qué se evitó.
      const trazas = await agenteMalo.traces(tenantA, conv.conversationId);
      expect(trazas.some((t) => t.outbound?.includes('99.00'))).toBe(true);
    } finally {
      await appMala.close();
    }
  });

  // ------------------------------------------------- Presupuesto (T5.30)

  it('PRESUPUESTO AGOTADO degrada a reglas, NO a error', async () => {
    await agent.setBudget(tenantA, 1);
    await withTenant(pool, tenantA, ({ client }) =>
      client.query('UPDATE ai_budgets SET used_credits = 999'),
    );

    // La regla SIGUE respondiendo: el negocio nunca se queda mudo.
    const conRegla = await agent.respond(tenantA, {
      conversationId: conversacionA,
      brandId: brandA,
      text: '¿A qué hora abren?',
    });
    expect(conRegla.resolution).toBe('rule');
    expect(conRegla.text).toContain('11:00');

    // Lo que necesitaría el modelo se degrada, sin error.
    const sinRegla = await agent.respond(tenantA, {
      conversationId: conversacionA,
      brandId: brandA,
      text: 'Cuéntame algo de la historia del local',
    });
    expect(sinRegla.resolution).toBe('degraded');
    expect(sinRegla.trace.budget).toBe('exhausted');

    await withTenant(pool, tenantA, ({ client }) =>
      client.query(
        'UPDATE ai_budgets SET used_credits = 0, limit_credits = 100000',
      ),
    );
  });

  // --------------------------------------------------- RAG aislado (T5.23)

  it('LAS FUENTES DE UN TENANT NO APARECEN JAMÁS EN OTRO', async () => {
    // La prueba de aislamiento específica que pide la spec. La búsqueda es un
    // ORDER BY por distancia: si el filtro por tenant dependiera de recordar un
    // WHERE, olvidarlo devolvería el material del competidor ORDENADO POR
    // PARECIDO, sin error y con la respuesta puesta en boca del agente.
    await knowledge.upsertSource(tenantA, {
      title: 'Política de A',
      body: 'En el local de A no se aceptan mascotas dentro del comedor.',
    });
    await knowledge.upsertSource(tenantB, {
      title: 'Política SECRETA de B',
      body: 'El secreto de B es que la receta lleva ají charapita del norte.',
    });

    const enA = await knowledge.search(tenantA, 'receta ají charapita', {
      limit: 5,
    });
    expect(JSON.stringify(enA)).not.toContain('charapita');
    expect(JSON.stringify(enA)).not.toContain('SECRETA');

    const enB = await knowledge.search(tenantB, 'mascotas comedor', {
      limit: 5,
    });
    expect(JSON.stringify(enB)).not.toContain('mascotas');
  });

  it('las fuentes se reindexan al editarlas, sin dejar fragmentos viejos', async () => {
    // Actualizar en sitio dejaría fragmentos de un texto que ya no existe, y el
    // agente citaría una política derogada como vigente.
    const fuente = await knowledge.upsertSource(tenantA, {
      title: 'Envíos',
      body: 'Cobramos S/ 5 de envío en toda la ciudad y tardamos una hora.',
    });
    await knowledge.upsertSource(tenantA, {
      id: fuente.id,
      title: 'Envíos',
      body: 'El envío ahora es gratis en pedidos grandes.',
    });

    const fragmentos = await withTenant(pool, tenantA, async ({ client }) => {
      const { rows } = await client.query<{ content: string }>(
        'SELECT content FROM ai_source_chunks WHERE source_id = $1',
        [fuente.id],
      );
      return rows;
    });
    expect(JSON.stringify(fragmentos)).not.toContain('S/ 5 de envío');
    expect(JSON.stringify(fragmentos)).toContain('gratis');
  });

  // --------------------------------------------------- Traza (RN-AIA-05)

  it('EL SANDBOX reproduce la traza: qué regla, qué fuentes, qué validador', async () => {
    const r = await auth(http().post('/api/v1/ai/sandbox'))
      .send({
        conversationId: conversacionA,
        brandId: brandA,
        text: '¿A qué hora abren?',
      })
      .expect(201);
    expect(r.body.resolution).toBe('rule');
    expect(r.body.trace.ruleName).toBe('Horario');

    const trazas = await auth(
      http().get(`/api/v1/ai/traces/${conversacionA}`),
    ).expect(200);
    expect(trazas.body.length).toBeGreaterThan(0);
    // La traza guarda la entrada, la salida y cómo se resolvió: sin eso, «¿por
    // qué el bot le dijo eso a mi cliente?» no tiene respuesta.
    expect(trazas.body[0].inbound).toBeTruthy();
    expect(
      trazas.body.some((t: { resolution: string }) => t.resolution === 'rule'),
    ).toBe(true);
  });
});
