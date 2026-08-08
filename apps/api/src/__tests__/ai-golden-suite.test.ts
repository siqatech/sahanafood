import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  GOLDEN_DIALOGUES,
  compareGolden,
  formatFailures,
  SYSTEM_PROMPT_VERSION,
  type GoldenResult,
} from '@sahana/ai-prompts';
import { AppModule } from '../app.module.js';
import { configureApp, NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedDemoOrganization } from '../modules/organization/index.js';
import { seedDemoCatalog } from '../modules/catalog/index.js';
import { ConversationsService } from '../modules/conversations/index.js';
import { AgentService, AgentConfigService } from '../modules/ai/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * La suite dorada corrida contra el agente REAL (T5.31).
 *
 * Criterio del backlog: **un cambio de prompt que degrada la suite no se
 * mergea**. Esta prueba es lo que hace ese criterio ejecutable — corre en CI,
 * con el proveedor determinista, y falla con el motivo de negocio de cada
 * turno, no con un diff de texto.
 *
 * Lo que comprueba es CONTRATO, no estilo: cómo se resuelve cada diálogo, qué
 * herramientas se llamaron y qué no puede aparecer nunca. Un cambio de
 * redacción la pasa; uno que hace que el agente empiece a inventar precios o
 * que una regla pase a costar tokens, no.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

/**
 * Configuración de referencia: la que tendría un dueño tras rellenar la
 * plantilla de su rubro.
 *
 * Deliberadamente NORMAL. Si la suite dependiera de una configuración exótica,
 * aprobaría cambios que rompen al cliente corriente, que es el único que
 * importa.
 */
const REGLAS_DE_REFERENCIA = [
  {
    // Prioridad 5: gana a todo lo demás dentro de su franja. Es la regla que
    // evita aceptar a las 5 a. m. un pedido que nadie va a cocinar.
    name: 'Madrugada',
    priority: 5,
    conditions: [{ kind: 'wants' as const, value: 'comprar' }],
    actions: [
      {
        kind: 'reply' as const,
        value: 'Ahora estamos cerrados. Toma nota tu pedido desde las 11:00.',
      },
    ],
    activeFromMinute: 0,
    activeToMinute: 600,
  },
  {
    name: 'Horario',
    priority: 10,
    conditions: [
      { kind: 'asks_about' as const, value: 'horario, abren, cierran' },
    ],
    actions: [{ kind: 'reply' as const, value: 'Atendemos de 11:00 a 23:00.' }],
  },
  {
    name: 'Formas de pago',
    priority: 20,
    conditions: [
      {
        kind: 'asks_about' as const,
        value: 'pago, pagar, yape, plin, tarjeta',
      },
    ],
    actions: [
      {
        kind: 'reply' as const,
        value: 'Aceptamos Yape, Plin, tarjeta y efectivo.',
      },
    ],
  },
  {
    name: 'Ubicación',
    priority: 30,
    conditions: [{ kind: 'contains' as const, value: 'dónde están' }],
    actions: [
      { kind: 'reply' as const, value: 'Estamos en Av. Siempre Viva 742.' },
    ],
  },
  {
    name: 'Reservas',
    priority: 40,
    conditions: [{ kind: 'wants' as const, value: 'reservar' }],
    actions: [
      {
        kind: 'reply' as const,
        value: 'Las reservas se toman por teléfono; te paso con el equipo.',
      },
    ],
  },
  {
    // Responde Y deriva. Una respuesta sobre alérgenos que se queda en el bot
    // es la única de esta lista que puede mandar a alguien al hospital.
    name: 'Alérgenos',
    priority: 15,
    conditions: [
      { kind: 'asks_about' as const, value: 'gluten, alergi, celia' },
    ],
    actions: [
      {
        kind: 'reply' as const,
        value: 'Lo confirmo con cocina para no darte un dato equivocado.',
      },
      { kind: 'handoff' as const, value: 'Consulta de alérgenos.' },
    ],
  },
];

suite('Suite dorada del agente', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 10 });
  const created: string[] = [];

  let tenantId = '';
  let brandId = '';
  let agent: AgentService;
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
    agent = app.get(AgentService);
    conversations = app.get(ConversationsService);
    const config = app.get(AgentConfigService);

    await seedPlans(pool);
    const t = await app.get(TenancyService).provisionTenant({
      name: 'Dorada Tenant',
      planCode: 'growth',
      owner: {
        email: 'gold@sahana.test',
        password: 'password-gold-1',
        fullName: 'Dueña Dorada',
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

    const draft = await config.getDraft(tenantId, brandId);
    await config.updateDraft(tenantId, draft.id, {
      identity: { name: 'Sahanita', tone: 'amistoso', length: 'corta' },
      guidelines: ['Cierra siempre ofreciendo el siguiente paso.'],
      enabled: true,
    });
    for (const regla of REGLAS_DE_REFERENCIA) {
      await config.addRule(tenantId, draft.id, regla);
    }
    await config.publish(tenantId, draft.id);
    await agent.setBudget(tenantId, 1_000_000);
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  it('los diálogos de referencia se resuelven como manda el contrato', async () => {
    const resultados: GoldenResult[] = [];

    for (const dialogo of GOLDEN_DIALOGUES) {
      // Conversación NUEVA por diálogo: los turnos de uno no pueden contaminar
      // al siguiente, y un traspaso a humano en el diálogo del reclamo dejaría
      // muda a la conversación del que viene detrás.
      const conv = await conversations.receiveInbound(tenantId, {
        brandId,
        channel: 'whatsapp',
        phone: `+5198700${dialogo.id.length}${resultados.length}`,
        text: 'inicio',
      });

      for (let i = 0; i < dialogo.turns.length; i++) {
        const turno = dialogo.turns[i]!;
        const r = await agent.respond(tenantId, {
          conversationId: conv.conversationId,
          brandId,
          text: turno.user,
          ...(turno.minuteOfDay !== undefined
            ? { minuteOfDay: turno.minuteOfDay }
            : {}),
        });
        resultados.push({
          dialogueId: dialogo.id,
          turnIndex: i,
          resolution: r.resolution,
          toolsCalled: r.trace.toolsCalled,
          actionKinds: r.actions.map((a) => a.kind),
          text: r.text,
        });

        // Un traspaso apaga la IA en esa conversación (RN-CNV-02): se reabre
        // para poder seguir con los turnos que quedan.
        if (r.resolution === 'handoff') {
          await withTenant(pool, tenantId, ({ client }) =>
            client.query(
              `UPDATE cnv_conversations SET status = 'bot', ai_enabled = true
                WHERE id = $1`,
              [conv.conversationId],
            ),
          );
        }
      }
    }

    const fallos = compareGolden(GOLDEN_DIALOGUES, resultados);
    expect(
      fallos,
      fallos.length > 0
        ? `\nLa suite dorada se degradó. Un cambio que la rompe NO se mergea:\n\n${formatFailures(fallos)}\n`
        : '',
    ).toEqual([]);
  });

  it('la traza guarda la versión del prompt y los tokens', async () => {
    // Sin esto, «desde el martes responde peor» no se puede atribuir a nada: el
    // prompt es texto que vive en el código y cambia sin dejar rastro en los
    // datos. Con la versión guardada, la comparación entre dos prompts es un
    // GROUP BY; sin ella, es una discusión.
    const conv = await conversations.receiveInbound(tenantId, {
      brandId,
      channel: 'whatsapp',
      phone: '+51987009999',
      text: 'inicio',
    });

    const generada = await agent.respond(tenantId, {
      conversationId: conv.conversationId,
      brandId,
      text: '¿Cuánto cuesta el pollo?',
    });
    expect(generada.resolution).toBe('llm');
    expect(generada.trace.promptVersion).toBe(SYSTEM_PROMPT_VERSION);
    expect(generada.trace.outputTokens).toBeGreaterThan(0);

    const porRegla = await agent.respond(tenantId, {
      conversationId: conv.conversationId,
      brandId,
      text: '¿A qué hora abren?',
    });
    // Una regla NO pasó por ningún prompt: atribuirle una versión sería contar
    // como «respuesta de v1» algo que v1 no escribió, y falsear la comparación.
    expect(porRegla.resolution).toBe('rule');
    expect(porRegla.trace.promptVersion).toBeUndefined();

    const filas = await withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        resolution: string;
        prompt_version: string | null;
        input_tokens: number;
        output_tokens: number;
      }>(
        `SELECT resolution, prompt_version, input_tokens, output_tokens
           FROM ai_traces WHERE conversation_id = $1 ORDER BY created_at`,
        [conv.conversationId],
      );
      return rows;
    });

    const llm = filas.find((f) => f.resolution === 'llm');
    expect(llm?.prompt_version).toBe(SYSTEM_PROMPT_VERSION);
    // Los tokens ya se contaban para cobrar créditos pero no se guardaban: sin
    // ellos, «cuánto cuesta una conversación» solo se puede estimar, y una
    // estimación no sirve para facturar.
    expect(llm!.input_tokens).toBeGreaterThan(0);
    expect(llm!.output_tokens).toBeGreaterThan(0);
    expect(
      filas.find((f) => f.resolution === 'rule')?.prompt_version,
    ).toBeNull();
  });
});
