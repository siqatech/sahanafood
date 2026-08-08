import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  messagesPerOrder,
  conversionBps,
  unansweredTopics,
  type MessagesPerOrderResult,
  type TopicCount,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';

/**
 * Analítica del agente (spec 19 §6, T5.32).
 *
 * Contesta la única pregunta que decide si el agente se queda encendido:
 * **¿vende, y a qué coste?** Todo lo demás del panel es contexto de esa.
 *
 * Consulta directa y no proyección, a diferencia de la analítica de
 * rentabilidad (T4.29). La regla de la spec 16 —«leer de proyecciones, nunca de
 * las tablas transaccionales en caliente»— existe porque un `GROUP BY` sobre
 * `ord_orders` un viernes a las 20:30 compite con la caja. Aquí no aplica:
 * `ai_traces` y `cnv_messages` no están en el camino de ningún cobro, el
 * volumen por tenant es el de sus conversaciones, y el panel del agente no se
 * mira en hora punta. Montar una proyección para esto sería una tabla más que
 * mantener y otra que puede quedarse atrás sin que nadie lo note.
 *
 * **Coste en créditos y no en soles.** No hay precio del crédito configurado en
 * ninguna parte, y ponerle uno aquí sería inventar el dato más delicado del
 * panel: el dueño lo leería como su factura. Los créditos son la unidad real
 * que se consume y con la que el presupuesto de T5.30 corta. Convertirlos a
 * soles necesita una tarifa del plan, que es decisión de negocio — anotada como
 * PA-06.
 */

export interface AgentAnalyticsRange {
  from: Date;
  to: Date;
  brandId?: string | undefined;
}

export interface OriginConversion {
  /** `ai` (solo bot), `human` (nunca contestó el bot), `mixed` (los dos). */
  origin: 'ai' | 'human' | 'mixed';
  conversations: number;
  converted: number;
  conversionBps: number;
}

export interface AgentAnalytics {
  from: string;
  to: string;

  conversations: {
    // `count` y no `total`: la regla de ESLint que prohíbe `number` en campos
    // monetarios va por NOMBRE, y `total: number` la dispara. Aquí no hay
    // dinero —son conversaciones— pero renombrar es mejor que silenciar la
    // regla: la excepción de hoy es la que mañana deja pasar un importe.
    count: number;
    /** Resueltas SIN que interviniera una persona. */
    aiOnly: number;
    /** Derivadas a humano en algún momento. */
    handedOff: number;
    handoffBps: number;
  };

  conversionByOrigin: OriginConversion[];

  cost: {
    /** Créditos consumidos en el rango. */
    credits: number;
    inputTokens: number;
    outputTokens: number;
    /** Créditos ÷ conversaciones con actividad del agente. */
    creditsPerConversation: number | null;
    /** Créditos ÷ pedidos salidos de conversaciones. */
    creditsPerOrder: number | null;
  };

  /** Cuántas resoluciones de cada tipo: `rule` gratis, `llm` de pago… */
  resolutions: Array<{ resolution: string; count: number }>;

  /** El KPI de la fase: mensajes/pedido ≤ 8, medido. */
  messagesPerOrder: MessagesPerOrderResult;

  topRules: Array<{ ruleId: string; name: string; hits: number }>;

  /** Temas preguntados que ninguna fuente ni herramienta respaldó. */
  topicsWithoutSource: TopicCount[];
}

@Injectable()
export class AgentAnalyticsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async overview(
    tenantId: string,
    range: AgentAnalyticsRange,
  ): Promise<AgentAnalytics> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const conversaciones = await this.conversaciones(ctx, range);
      const origenes = await this.porOrigen(ctx, range);
      const coste = await this.coste(ctx, range);
      const resoluciones = await this.resoluciones(ctx, range);
      const kpi = await this.mensajesPorPedido(ctx, range);
      const reglas = await this.reglasMasDisparadas(ctx, range);
      const temas = await this.temasSinFuente(ctx, range);

      const conConversaciones = coste.conversationsWithAgent;
      const pedidos = kpi.orders;

      return {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        conversations: conversaciones,
        conversionByOrigin: origenes,
        cost: {
          credits: coste.credits,
          inputTokens: coste.inputTokens,
          outputTokens: coste.outputTokens,
          creditsPerConversation:
            conConversaciones > 0
              ? Math.round((coste.credits / conConversaciones) * 100) / 100
              : null,
          // `null` y no cero cuando no hubo pedidos: un cero se lee como
          // «gratis», y lo que pasó es que se gastaron créditos sin vender —
          // que es lo contrario y lo que hay que mirar.
          creditsPerOrder:
            pedidos > 0
              ? Math.round((coste.credits / pedidos) * 100) / 100
              : null,
        },
        resolutions: resoluciones,
        messagesPerOrder: kpi.result,
        topRules: reglas,
        topicsWithoutSource: temas,
      };
    });
  }

  // ------------------------------------------------------------------ Piezas

  private async conversaciones(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<AgentAnalytics['conversations']> {
    const { rows } = await ctx.client.query<{
      total: string;
      handed_off: string;
    }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE handoff_at IS NOT NULL) AS handed_off
         FROM cnv_conversations
        WHERE created_at >= $1 AND created_at < $2
          AND ($3::uuid IS NULL OR brand_id = $3)`,
      [range.from, range.to, range.brandId ?? null],
    );
    const total = Number(rows[0]?.total ?? 0);
    const handedOff = Number(rows[0]?.handed_off ?? 0);
    return {
      count: total,
      aiOnly: total - handedOff,
      handedOff,
      handoffBps: total > 0 ? Math.round((handedOff / total) * 10_000) : 0,
    };
  }

  /**
   * Conversión a pedido por origen.
   *
   * El origen se DERIVA de quién escribió en el hilo y no se guarda en una
   * columna: una conversación empieza siendo del bot y se vuelve mixta cuando
   * entra una persona, así que un valor guardado al crearla sería falso a los
   * diez minutos y nadie lo actualizaría.
   */
  private async porOrigen(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<OriginConversion[]> {
    const { rows } = await ctx.client.query<{
      origin: string;
      conversations: string;
      converted: string;
    }>(
      `WITH autores AS (
         SELECT c.id,
                -- «Intervino la IA» se mide por TRAZA y no por mensaje del bot:
                -- una derivación es intervención del agente —decidió que esto
                -- iba a una persona— y no escribe nada en el hilo. Contándola
                -- por mensajes, la conversación que el bot derivó bien saldría
                -- como atendida solo por humanos, y el agente no se llevaría el
                -- mérito de lo que hizo mejor.
                EXISTS (
                  SELECT 1 FROM ai_traces t WHERE t.conversation_id = c.id
                ) AS hubo_bot,
                bool_or(m.author_type = 'agent') AS hubo_persona
           FROM cnv_conversations c
           LEFT JOIN cnv_messages m ON m.conversation_id = c.id
          WHERE c.created_at >= $1 AND c.created_at < $2
            AND ($3::uuid IS NULL OR c.brand_id = $3)
          GROUP BY c.id
       ),
       clasificadas AS (
         SELECT id,
                CASE
                  WHEN hubo_bot AND hubo_persona THEN 'mixed'
                  WHEN hubo_bot THEN 'ai'
                  ELSE 'human'
                END AS origin
           FROM autores
       )
       SELECT cl.origin,
              count(*) AS conversations,
              count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM cnv_conversation_orders o
                   WHERE o.conversation_id = cl.id
                )
              ) AS converted
         FROM clasificadas cl
        GROUP BY cl.origin`,
      [range.from, range.to, range.brandId ?? null],
    );

    // Se devuelven SIEMPRE los tres orígenes, aunque uno esté a cero: una fila
    // ausente en el panel se lee como «no hay datos», y cero conversiones por
    // IA es un dato, no una ausencia.
    const porClave = new Map(rows.map((r) => [r.origin, r]));
    return (['ai', 'human', 'mixed'] as const).map((origin) => {
      const conversations = Number(porClave.get(origin)?.conversations ?? 0);
      const converted = Number(porClave.get(origin)?.converted ?? 0);
      return {
        origin,
        conversations,
        converted,
        conversionBps: conversionBps({ conversations, converted }),
      };
    });
  }

  private async coste(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<{
    credits: number;
    inputTokens: number;
    outputTokens: number;
    conversationsWithAgent: number;
  }> {
    const { rows } = await ctx.client.query<{
      credits: string;
      input_tokens: string;
      output_tokens: string;
      conversaciones: string;
    }>(
      `SELECT COALESCE(sum(t.credits), 0)       AS credits,
              COALESCE(sum(t.input_tokens), 0)  AS input_tokens,
              COALESCE(sum(t.output_tokens), 0) AS output_tokens,
              count(DISTINCT t.conversation_id) AS conversaciones
         FROM ai_traces t
         LEFT JOIN cnv_conversations c ON c.id = t.conversation_id
        WHERE t.created_at >= $1 AND t.created_at < $2
          AND ($3::uuid IS NULL OR c.brand_id = $3)`,
      [range.from, range.to, range.brandId ?? null],
    );
    return {
      credits: Number(rows[0]?.credits ?? 0),
      inputTokens: Number(rows[0]?.input_tokens ?? 0),
      outputTokens: Number(rows[0]?.output_tokens ?? 0),
      conversationsWithAgent: Number(rows[0]?.conversaciones ?? 0),
    };
  }

  private async resoluciones(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<Array<{ resolution: string; count: number }>> {
    const { rows } = await ctx.client.query<{
      resolution: string;
      count: string;
    }>(
      `SELECT t.resolution, count(*) AS count
         FROM ai_traces t
         LEFT JOIN cnv_conversations c ON c.id = t.conversation_id
        WHERE t.created_at >= $1 AND t.created_at < $2
          AND ($3::uuid IS NULL OR c.brand_id = $3)
        GROUP BY t.resolution
        ORDER BY count DESC`,
      [range.from, range.to, range.brandId ?? null],
    );
    return rows.map((r) => ({
      resolution: r.resolution,
      count: Number(r.count),
    }));
  }

  /**
   * El KPI de la fase: mensajes por pedido.
   *
   * Cuenta los mensajes de las conversaciones **que acabaron en pedido**, no de
   * todas. Incluir las que no vendieron mezclaría dos cosas distintas —cuánto
   * cuesta cerrar una venta y cuánta gente pregunta sin comprar— y el número
   * dejaría de significar nada.
   */
  private async mensajesPorPedido(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<{ result: MessagesPerOrderResult; orders: number }> {
    const { rows } = await ctx.client.query<{
      mensajes: string;
      pedidos: string;
    }>(
      `WITH convertidas AS (
         SELECT DISTINCT c.id
           FROM cnv_conversations c
           JOIN cnv_conversation_orders o ON o.conversation_id = c.id
          WHERE c.created_at >= $1 AND c.created_at < $2
            AND ($3::uuid IS NULL OR c.brand_id = $3)
       )
       SELECT
         (SELECT count(*) FROM cnv_messages m
           WHERE m.conversation_id IN (SELECT id FROM convertidas)
             -- Los mensajes de SISTEMA no los escribe nadie: contarlos haría
             -- que crear el pedido subiera el KPI que mide crear el pedido.
             AND m.kind <> 'system') AS mensajes,
         (SELECT count(*) FROM cnv_conversation_orders o
           WHERE o.conversation_id IN (SELECT id FROM convertidas)) AS pedidos`,
      [range.from, range.to, range.brandId ?? null],
    );
    const mensajes = Number(rows[0]?.mensajes ?? 0);
    const pedidos = Number(rows[0]?.pedidos ?? 0);
    return {
      result: messagesPerOrder({ messages: mensajes, orders: pedidos }),
      orders: pedidos,
    };
  }

  private async reglasMasDisparadas(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<Array<{ ruleId: string; name: string; hits: number }>> {
    // Se cuentan los disparos DEL RANGO desde las trazas, no el `hit_count`
    // acumulado de la regla: ese contador no sabe de fechas, así que una regla
    // creada hace un año siempre ganaría a la que el dueño acaba de añadir.
    const { rows } = await ctx.client.query<{
      rule_id: string;
      name: string;
      hits: string;
    }>(
      `SELECT t.rule_id, r.name, count(*) AS hits
         FROM ai_traces t
         JOIN ai_rules r ON r.id = t.rule_id
         LEFT JOIN cnv_conversations c ON c.id = t.conversation_id
        WHERE t.rule_id IS NOT NULL
          AND t.created_at >= $1 AND t.created_at < $2
          AND ($3::uuid IS NULL OR c.brand_id = $3)
        GROUP BY t.rule_id, r.name
        ORDER BY hits DESC, r.name
        LIMIT 10`,
      [range.from, range.to, range.brandId ?? null],
    );
    return rows.map((r) => ({
      ruleId: r.rule_id,
      name: r.name,
      hits: Number(r.hits),
    }));
  }

  private async temasSinFuente(
    ctx: TenantContext,
    range: AgentAnalyticsRange,
  ): Promise<TopicCount[]> {
    // Mensajes que el agente contestó SIN nada detrás: ni fuente del tenant ni
    // herramienta. Son los que el dueño puede convertir en respuesta preparada
    // —gratis y sin riesgo de invención— añadiendo una fuente.
    const { rows } = await ctx.client.query<{ inbound_text: string }>(
      `SELECT t.inbound_text
         FROM ai_traces t
         LEFT JOIN cnv_conversations c ON c.id = t.conversation_id
        WHERE t.created_at >= $1 AND t.created_at < $2
          AND ($3::uuid IS NULL OR c.brand_id = $3)
          AND t.resolution = 'llm'
          AND cardinality(t.source_ids) = 0
          AND t.tools_called = '[]'::jsonb
        -- Tope alto pero tope: sin él, un tenant con medio millón de trazas se
        -- trae medio millón de cadenas a memoria para contar palabras.
        LIMIT 5000`,
      [range.from, range.to, range.brandId ?? null],
    );
    return unansweredTopics(
      rows.map((r) => r.inbound_text),
      { limit: 10 },
    );
  }
}
