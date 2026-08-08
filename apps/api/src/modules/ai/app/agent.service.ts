import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  matchRule,
  detectNegativeSentiment,
  detectPurchaseIntent,
  validateOutput,
  checkAiBudget,
  creditsForTokens,
  type Action,
  type DeterministicRule,
  type ToolEvidence,
  type BudgetDecision,
} from '@sahana/domain';
import { buildSystemPrompt, SYSTEM_PROMPT_VERSION } from '@sahana/ai-prompts';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import { AI_PROVIDER } from '../ai.tokens.js';
import type { AiProvider } from '../domain/ai-provider.js';
import { AgentToolsService, type ToolResult } from './agent-tools.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { AgentCartService } from './agent-cart.service.js';
import { ConversationsService } from '../../conversations/index.js';

/**
 * El agente conversacional (spec 19, ADR-0011, T5.22–T5.30).
 *
 * Implementa la **jerarquía obligatoria** de ADR-0011 §1, y el orden no es
 * negociable porque cada escalón existe para tapar el fallo del siguiente:
 *
 *  1. **Acciones deterministas** del dueño. Coste cero, cero riesgo de
 *     invención. Ganan siempre.
 *  2. **Datos vivos por herramientas tipadas.** El LLM nunca los redacta de
 *     memoria: los consulta.
 *  3. **Fuentes del tenant** (RAG), filtradas por `tenant_id`.
 *  4. **Generación libre**, dentro de pautas y con derivación ante duda.
 *
 * Y por encima de todo, el **validador de salida** (T5.24): lo que no esté
 * respaldado por una herramienta de esta conversación no sale.
 *
 * Si algo de esto falla —proveedor caído, presupuesto agotado, respuesta
 * bloqueada— el resultado NUNCA es silencio: es la regla determinista o la
 * derivación a un humano. Un cliente esperando es un cliente que se va.
 */

export type Resolution = 'rule' | 'llm' | 'blocked' | 'handoff' | 'degraded';

export interface AgentReply {
  resolution: Resolution;
  text: string | null;
  actions: readonly Action[];
  /** Por qué respondió así. Es la traza de RN-AIA-05, ya legible. */
  trace: {
    ruleId?: string | undefined;
    ruleName?: string | undefined;
    sourceIds: string[];
    toolsCalled: string[];
    validator?: { ok: boolean; reason?: string } | undefined;
    credits: number;
    budget: BudgetDecision['state'];
    /**
     * Versión del prompt de sistema con la que se generó. `undefined` cuando no
     * hubo modelo (regla, derivación, presupuesto agotado): decir «v1» ahí sería
     * atribuirle a un prompt una respuesta que no escribió.
     */
    promptVersion?: string | undefined;
    inputTokens: number;
    outputTokens: number;
  };
}

const MAX_FUENTES = 3;

interface AgentIdentityFields {
  name?: string | undefined;
  role?: string | undefined;
  personality?: string | undefined;
  tone?: string | undefined;
  length?: string | undefined;
}

interface PublishedConfig {
  id: string;
  enabled: boolean;
  identity: AgentIdentityFields;
  guidelines: string[];
  limits: { forbiddenTopics?: string[] };
  /** Nombre real de la marca: el prompt dice de quién es el agente. */
  brandName: string;
}

@Injectable()
export class AgentService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly tools: AgentToolsService,
    private readonly knowledge: KnowledgeService,
    private readonly conversations: ConversationsService,
    private readonly cart: AgentCartService,
  ) {}

  /**
   * Responde a un mensaje entrante.
   *
   * Devuelve siempre algo: una respuesta, o una derivación. Nunca lanza por
   * culpa del modelo — un error del proveedor degrada a reglas.
   */
  async respond(
    tenantId: string,
    input: {
      conversationId: string;
      brandId: string;
      text: string;
      askedTopics?: string[] | undefined;
      minuteOfDay?: number | undefined;
      now?: Date | undefined;
    },
  ): Promise<AgentReply> {
    const inicio = Date.now();
    const config = await this.publishedConfig(tenantId, input.brandId);

    // Sin configuración publicada o con el agente apagado, no hay agente. NO es
    // un error: es un tenant que no lo activó, y su bandeja sigue funcionando
    // con personas (ADR-0011: apagar la IA deja el sistema 100 % funcional).
    if (!config || !config.enabled) {
      return this.registrar(
        tenantId,
        input,
        {
          resolution: 'handoff',
          text: null,
          actions: [{ kind: 'handoff', value: 'El agente no está activo.' }],
          trace: {
            sourceIds: [],
            toolsCalled: [],
            credits: 0,
            budget: 'ok',
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        null,
        inicio,
      );
    }

    const presupuesto = await this.budget(tenantId);

    // --- Escalón 1: acciones deterministas. Ganan SIEMPRE.
    const reglas = await this.rules(tenantId, config.id);
    const negativo = detectNegativeSentiment(input.text);
    const match = matchRule(reglas, {
      text: input.text,
      askedTopics: input.askedTopics ?? [],
      ...(input.minuteOfDay !== undefined
        ? { minuteOfDay: input.minuteOfDay }
        : {}),
      sentimentNegative: negativo,
    });

    if (match) {
      await this.contarDisparo(tenantId, match.rule.id);
      const respuesta = match.actions.find((a) => a.kind === 'reply');
      return this.registrar(
        tenantId,
        input,
        {
          resolution: 'rule',
          text: respuesta?.value ?? null,
          actions: match.actions,
          trace: {
            ruleId: match.rule.id,
            ruleName: match.rule.name,
            sourceIds: [],
            toolsCalled: [],
            credits: 0,
            budget: presupuesto.state,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        config.id,
        inicio,
      );
    }

    // RN-AIA-03: un reclamo va a un humano aunque no haya regla que lo diga.
    // Es guardrail fijo, no configuración: dejar que un modelo gestione una
    // queja es cómo se pierde a un cliente enfadado dos veces.
    if (negativo) {
      return this.derivar(
        tenantId,
        input,
        config.id,
        inicio,
        'Reclamo detectado: se deriva a una persona.',
        presupuesto.state,
      );
    }

    // --- Presupuesto agotado: se degrada a reglas, no a error (T5.30).
    if (!presupuesto.allowLlm) {
      return this.registrar(
        tenantId,
        input,
        {
          resolution: 'degraded',
          text: null,
          actions: [{ kind: 'handoff', value: presupuesto.reason }],
          trace: {
            sourceIds: [],
            toolsCalled: [],
            credits: 0,
            budget: presupuesto.state,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        config.id,
        inicio,
      );
    }

    // --- Escalón 2: datos vivos por herramientas tipadas.
    const resultados = await this.tools.runFor(tenantId, {
      brandId: input.brandId,
      text: input.text,
    });

    // Intención de compra: se abre un carrito y el enlace entra en el contexto
    // (spec 19 §3, `order.start_cart`). Es la ÚNICA escritura del agente, y es
    // deliberadamente pobre: un carrito vacío y su enlace. Lo que se compra se
    // decide en el checkout estructurado, porque una compra confirmada por
    // texto libre es una compra que nadie puede demostrar (ADR-0011 §2).
    if (detectPurchaseIntent(input.text)) {
      const carrito = await this.cart.startCart(tenantId, input.brandId);
      if (carrito) resultados.push(carrito);
    }

    // --- Escalón 3: fuentes del tenant, filtradas por tenant_id.
    const fuentes = await this.knowledge.search(tenantId, input.text, {
      brandId: input.brandId,
      limit: MAX_FUENTES,
    });

    // --- Escalón 4: generación, dentro de pautas.
    let texto: string;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const respuesta = await this.provider.chat({
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt({
              brandName: config.brandName,
              identity: config.identity,
              guidelines: config.guidelines,
              sources: fuentes.map((f) => f.content),
            }),
          },
          ...resultados.map((r) => ({
            role: 'tool' as const,
            name: r.tool,
            content: r.summary,
          })),
          { role: 'user', content: input.text },
        ],
        maxOutputTokens: 400,
      });
      texto = respuesta.text;
      inputTokens = respuesta.inputTokens;
      outputTokens = respuesta.outputTokens;
    } catch {
      // El proveedor cayó. NO es un error para el cliente: es una derivación.
      // Un agente que devuelve «error interno» a alguien que pregunta por su
      // pedido es peor que no tener agente.
      return this.derivar(
        tenantId,
        input,
        config.id,
        inicio,
        'El asistente no está disponible ahora mismo.',
        presupuesto.state,
      );
    }

    const credits = creditsForTokens(inputTokens, outputTokens, {
      creditsPerKInput: 1,
      creditsPerKOutput: 3,
    });
    await this.consumir(tenantId, credits);

    // --- El validador. Lo último y lo que manda (T5.24, RN-AIA-01).
    const evidencia: ToolEvidence[] = resultados.map((r) => ({
      tool: r.tool,
      kinds: r.kinds,
      values: r.values,
    }));
    const veredicto = validateOutput(texto, evidencia, {
      ...(config.limits.forbiddenTopics
        ? { forbiddenTopics: config.limits.forbiddenTopics }
        : {}),
    });

    if (!veredicto.ok) {
      // Bloqueado: se deriva en vez de reformular. Reformular con el mismo
      // modelo que acaba de inventar un precio es pedirle que lo invente mejor.
      return this.registrar(
        tenantId,
        input,
        {
          resolution: 'blocked',
          text: null,
          actions: [
            { kind: 'handoff', value: 'Te paso con una persona del equipo.' },
          ],
          trace: {
            sourceIds: fuentes.map((f) => f.sourceId),
            toolsCalled: resultados.map((r) => r.tool),
            validator: { ok: false, reason: veredicto.reason },
            credits,
            budget: presupuesto.state,
            promptVersion: SYSTEM_PROMPT_VERSION,
            inputTokens,
            outputTokens,
          },
        },
        config.id,
        inicio,
        texto,
      );
    }

    await this.knowledge.markUsed(
      tenantId,
      fuentes.map((f) => f.sourceId),
    );

    return this.registrar(
      tenantId,
      input,
      {
        resolution: 'llm',
        text: texto,
        actions: [],
        trace: {
          sourceIds: fuentes.map((f) => f.sourceId),
          toolsCalled: resultados.map((r) => r.tool),
          validator: { ok: true },
          credits,
          budget: presupuesto.state,
          promptVersion: SYSTEM_PROMPT_VERSION,
          inputTokens,
          outputTokens,
        },
      },
      config.id,
      inicio,
    );
  }

  // -------------------------------------------------------------- Internos

  private async derivar(
    tenantId: string,
    input: { conversationId: string; brandId: string; text: string },
    configId: string | null,
    inicio: number,
    motivo: string,
    budget: BudgetDecision['state'],
  ): Promise<AgentReply> {
    // El traspaso lleva su resumen: sin él, el humano abre con «hola, ¿en qué
    // puedo ayudarte?» y el cliente lo cuenta todo otra vez (RN-CNV-02).
    await this.conversations
      .handoffToHuman(tenantId, input.conversationId, {
        intent: input.text.slice(0, 200),
        notes: motivo,
      })
      .catch(() => {
        // Ya estaba traspasada: no es un fallo, es que llegó otro mensaje.
      });

    return this.registrar(
      tenantId,
      input,
      {
        resolution: 'handoff',
        text: null,
        actions: [{ kind: 'handoff', value: motivo }],
        trace: {
          sourceIds: [],
          toolsCalled: [],
          credits: 0,
          budget,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      configId,
      inicio,
    );
  }

  /** Escribe la traza (RN-AIA-05) y devuelve la respuesta tal cual. */
  private async registrar(
    tenantId: string,
    input: { conversationId: string; text: string },
    reply: AgentReply,
    configId: string | null,
    inicio: number,
    textoBloqueado?: string,
  ): Promise<AgentReply> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO ai_traces
           (tenant_id, conversation_id, config_id, inbound_text, outbound_text,
            resolution, rule_id, source_ids, tools_called, validator,
            credits, latency_ms, input_tokens, output_tokens, prompt_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          tenantId,
          input.conversationId,
          configId,
          input.text,
          // En un bloqueo se guarda lo que el modelo QUERÍA decir. Es el dato
          // que hace útil la traza: sin él, «bloqueado» no dice qué se evitó.
          reply.text ?? textoBloqueado ?? null,
          reply.resolution,
          reply.trace.ruleId ?? null,
          reply.trace.sourceIds,
          JSON.stringify(reply.trace.toolsCalled),
          reply.trace.validator ? JSON.stringify(reply.trace.validator) : null,
          reply.trace.credits,
          Date.now() - inicio,
          // Los tokens ya se contaban para cobrar créditos, pero no se
          // guardaban: sin ellos «cuánto cuesta una conversación» (T5.32) solo
          // se puede estimar, y una estimación no sirve para facturar.
          reply.trace.inputTokens,
          reply.trace.outputTokens,
          reply.trace.promptVersion ?? null,
        ],
      );
    });
    return reply;
  }

  private async publishedConfig(
    tenantId: string,
    brandId: string,
  ): Promise<PublishedConfig | null> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        enabled: boolean;
        identity: AgentIdentityFields;
        guidelines: string[];
        limits: { forbiddenTopics?: string[] };
        brand_name: string;
      }>(
        `SELECT c.id, c.enabled, c.identity, c.guidelines, c.limits,
                b.name AS brand_name
           FROM ai_agent_configs c
           JOIN org_brands b ON b.id = c.brand_id
          WHERE c.brand_id = $1 AND c.status = 'published'`,
        [brandId],
      );
      const c = rows[0];
      if (!c) return null;
      return {
        id: c.id,
        enabled: c.enabled,
        identity: c.identity,
        guidelines: c.guidelines,
        limits: c.limits,
        brandName: c.brand_name,
      };
    });
  }

  private async rules(
    tenantId: string,
    configId: string,
  ): Promise<DeterministicRule[]> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        priority: number;
        match_mode: 'any' | 'all';
        conditions: DeterministicRule['conditions'];
        actions: DeterministicRule['actions'];
        enabled: boolean;
        active_from_minute: number | null;
        active_to_minute: number | null;
      }>(
        `SELECT id, name, priority, match_mode, conditions, actions, enabled,
                active_from_minute, active_to_minute
           FROM ai_rules WHERE config_id = $1
          ORDER BY priority, id`,
        [configId],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        priority: r.priority,
        match: r.match_mode,
        conditions: r.conditions,
        actions: r.actions,
        enabled: r.enabled,
        activeFrom: r.active_from_minute,
        activeTo: r.active_to_minute,
      }));
    });
  }

  private async contarDisparo(tenantId: string, ruleId: string): Promise<void> {
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        'UPDATE ai_rules SET hit_count = hit_count + 1 WHERE id = $1',
        [ruleId],
      ),
    );
  }

  async budget(tenantId: string): Promise<BudgetDecision> {
    const fila = await withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        limit_credits: number;
        used_credits: number;
      }>('SELECT limit_credits, used_credits FROM ai_budgets');
      return rows[0];
    });
    return checkAiBudget({
      limitCredits: fila?.limit_credits ?? 0,
      usedCredits: fila?.used_credits ?? 0,
    });
  }

  async setBudget(tenantId: string, limitCredits: number): Promise<void> {
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        `INSERT INTO ai_budgets (tenant_id, limit_credits)
         VALUES ($1,$2)
         ON CONFLICT (tenant_id) DO UPDATE
           SET limit_credits = EXCLUDED.limit_credits, updated_at = now()`,
        [tenantId, limitCredits],
      ),
    );
  }

  private async consumir(tenantId: string, credits: number): Promise<void> {
    await withTenant(this.pool, tenantId, ({ client }) =>
      client.query(
        `INSERT INTO ai_budgets (tenant_id, used_credits)
         VALUES ($1,$2)
         ON CONFLICT (tenant_id) DO UPDATE
           SET used_credits = ai_budgets.used_credits + EXCLUDED.used_credits,
               updated_at = now()`,
        [tenantId, credits],
      ),
    );
  }

  /** Trazas de una conversación, para el sandbox y la auditoría (RN-AIA-05). */
  async traces(
    tenantId: string,
    conversationId: string,
  ): Promise<
    Array<{
      inbound: string;
      outbound: string | null;
      resolution: string;
      ruleId: string | null;
      toolsCalled: unknown;
      validator: unknown;
      credits: number;
      at: string;
    }>
  > {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{
        inbound_text: string;
        outbound_text: string | null;
        resolution: string;
        rule_id: string | null;
        tools_called: unknown;
        validator: unknown;
        credits: number;
        created_at: Date;
      }>(
        `SELECT inbound_text, outbound_text, resolution, rule_id,
                tools_called, validator, credits, created_at
           FROM ai_traces WHERE conversation_id = $1
          ORDER BY created_at`,
        [conversationId],
      );
      return rows.map((r) => ({
        inbound: r.inbound_text,
        outbound: r.outbound_text,
        resolution: r.resolution,
        ruleId: r.rule_id,
        toolsCalled: r.tools_called,
        validator: r.validator,
        credits: r.credits,
        at: r.created_at.toISOString(),
      }));
    });
  }
}

export type { ToolResult };
