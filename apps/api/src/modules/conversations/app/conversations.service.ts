import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money, windowCountdown, type WindowCountdown } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { recordAudit } from '../../audit/index.js';
import { MessagingService } from '../../messaging/index.js';
import { OrderingService } from '../../ordering/index.js';

/**
 * Bandeja omnicanal (spec 18, T5.19–T5.21).
 *
 * Existe ANTES que el agente de IA y no al revés, y eso no es orden de
 * conveniencia: el agente escribe EN una conversación. Construirlo primero le
 * obligaría a tener su propio almacén de mensajes y luego habría que fusionarlo
 * con el histórico ya escrito — una migración de datos con conversaciones de
 * clientes reales dentro.
 *
 * La decisión que ordena el módulo es **RN-CNV-01**: la conversación es de
 * (tenant, marca, canal, contacto). El mismo teléfono escribiendo a dos marcas
 * del mismo tenant son DOS conversaciones. Va contra lo que hace un help desk
 * normal —una por persona— por dos motivos concretos: el branding de la
 * respuesta, y que el coste de atención tiene que poder imputarse a una marca.
 */

/** Un mensaje libre fuera de la ventana de 24 h (RN-CNV-03). */
export class WindowExpiredError extends DomainError {
  readonly status = 422;
  readonly type = 'https://errors.sahana.food/wa-window-expired';
  readonly title = 'La ventana de 24 h está cerrada';
  readonly code = 'WA_WINDOW_EXPIRED';
}

export interface ConversationView {
  id: string;
  brandId: string;
  brandName: string;
  channel: string;
  contactId: string;
  contactPhone: string;
  contactName: string | null;
  status: string;
  assigneeId: string | null;
  queue: string;
  aiEnabled: boolean;
  lastMsgAt: string | null;
  /** Estado de la ventana, ya redactado para la UI (RN-CNV-03). */
  window: WindowCountdown;
  messageCount: number;
  /** Coste acumulado de los mensajes de pago (RN-CNV-04). */
  costTotal: string;
  tags: string[];
  /**
   * Cuándo el bot pidió pasar la conversación a una persona, y con qué
   * contexto (RN-CNV-02).
   *
   * Se escribían desde T5.28 y **no los devolvía ninguna ruta**. El traspaso
   * con resumen —lo que evita que el cliente lo cuente todo otra vez, que es el
   * momento exacto en el que la gente abandona— existía en la base de datos y
   * era inalcanzable para cualquier pantalla. Un traspaso cuyo contexto no se
   * puede leer es un traspaso que no ocurrió.
   */
  handoffAt: string | null;
  handoffSummary: HandoffSummary | null;
}

export interface MessageView {
  id: string;
  direction: string;
  authorType: string;
  authorId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  costEstimate: string | null;
  createdAt: string;
}

/** Lo que el bot entrega al humano. Sin esto no hay traspaso (RN-CNV-02). */
export interface HandoffSummary {
  /** Qué venía buscando el cliente, en una frase. */
  intent: string;
  /** Datos ya capturados: no se vuelven a preguntar. */
  captured?: Record<string, unknown>;
  /** Carrito en curso, si lo hay. */
  cartToken?: string;
  /** Últimos mensajes relevantes, ya resumidos. */
  notes?: string;
}

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly messaging: MessagingService,
    private readonly ordering: OrderingService,
  ) {}

  // ------------------------------------------------------------ Conversación

  /**
   * Abre o recupera la conversación de (marca, canal, contacto).
   *
   * IDEMPOTENTE: dos mensajes seguidos del mismo cliente entran en la misma
   * conversación. La garantía la da el índice único parcial sobre las no
   * resueltas, no un `SELECT` previo — dos webhooks a la vez son dos filas y
   * dos agentes contestándole al mismo cliente.
   */
  async openOrGet(
    tenantId: string,
    input: {
      brandId: string;
      channel: 'whatsapp' | 'web' | 'email';
      contactId: string;
    },
  ): Promise<string> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO cnv_conversations (tenant_id, brand_id, channel, contact_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, brand_id, channel, contact_id)
           WHERE status <> 'resolved'
           DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, input.brandId, input.channel, input.contactId],
      );
      return rows[0]!.id;
    });
  }

  /**
   * Registra un mensaje ENTRANTE y lo enruta a su conversación.
   *
   * Aquí se reabre una conversación resuelta (RN-CNV-02): un cliente que
   * escribe otra vez no empieza de cero, vuelve a su hilo. Y se recalcula la
   * ventana, que es lo que alimenta la cuenta regresiva de la bandeja.
   */
  async receiveInbound(
    tenantId: string,
    input: {
      brandId: string;
      channel: 'whatsapp' | 'web' | 'email';
      phone: string;
      text: string;
      displayName?: string | undefined;
      waMessageId?: string | undefined;
      at?: Date | undefined;
    },
  ): Promise<{
    conversationId: string;
    messageId: string;
    duplicate: boolean;
  }> {
    const at = input.at ?? new Date();

    return withTenant(this.pool, tenantId, async (ctx) => {
      const contacto = await this.messaging.upsertContact(
        ctx,
        input.phone,
        input.displayName,
      );

      await ctx.client.query(
        'UPDATE wa_contacts SET last_inbound_at = $2, updated_at = now() WHERE id = $1',
        [contacto.id, at],
      );

      const { rows: conv } = await ctx.client.query<{ id: string }>(
        `INSERT INTO cnv_conversations
           (tenant_id, brand_id, channel, contact_id, last_msg_at,
            last_inbound_at, window_expires_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz,
                 $5::timestamptz + interval '24 hours')
         ON CONFLICT (tenant_id, brand_id, channel, contact_id)
           WHERE status <> 'resolved'
           DO UPDATE SET last_msg_at = EXCLUDED.last_msg_at,
                         last_inbound_at = EXCLUDED.last_inbound_at,
                         window_expires_at = EXCLUDED.window_expires_at,
                         updated_at = now()
         RETURNING id`,
        [tenantId, input.brandId, input.channel, contacto.id, at],
      );
      const conversationId = conv[0]!.id;

      const { rows: msg } = await ctx.client.query<{ id: string }>(
        `INSERT INTO cnv_messages
           (tenant_id, conversation_id, direction, author_type, kind,
            payload, wa_message_id, status, created_at)
         VALUES ($1,$2,'inbound','customer','text',$3,$4,'delivered',$5)
         ON CONFLICT (tenant_id, wa_message_id)
           WHERE wa_message_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          tenantId,
          conversationId,
          JSON.stringify({ text: input.text }),
          input.waMessageId ?? null,
          at,
        ],
      );

      // Sin fila devuelta, el mensaje ya estaba: los webhooks de Meta
      // reintentan, y duplicar dejaría al cliente viendo su pregunta dos veces.
      if (!msg[0]) {
        const { rows: previo } = await ctx.client.query<{ id: string }>(
          'SELECT id FROM cnv_messages WHERE wa_message_id = $1',
          [input.waMessageId],
        );
        return {
          conversationId,
          messageId: previo[0]?.id ?? '',
          duplicate: true,
        };
      }

      await enqueueEvent(ctx, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'conversation.message_received',
        payload: {
          conversationId,
          messageId: msg[0].id,
          channel: input.channel,
        },
      });

      return { conversationId, messageId: msg[0].id, duplicate: false };
    });
  }

  /**
   * Envía un mensaje del AGENTE o del bot.
   *
   * Aquí vive la mitad dura de RN-CNV-03: **fuera de la ventana no se deja
   * escribir libre y fallar**. Dejar pasar el texto y que Meta lo descarte en
   * silencio es el peor de los dos mundos —el agente cree que contestó, el
   * cliente no recibe nada, y nadie se entera hasta que el cliente reclama—.
   * Por eso esto devuelve un error con las plantillas disponibles, no un `ok`.
   */
  async sendMessage(
    tenantId: string,
    conversationId: string,
    input: {
      kind: 'text' | 'template' | 'note';
      text?: string | undefined;
      templateName?: string | undefined;
      authorType: 'bot' | 'agent' | 'system';
      authorId?: string | undefined;
      costEstimateMinor?: number | undefined;
      now?: Date | undefined;
    },
  ): Promise<MessageView> {
    const now = input.now ?? new Date();

    return withTenant(this.pool, tenantId, async (ctx) => {
      const conv = await this.loadRow(ctx, conversationId);

      // Una NOTA no sale: es para el equipo (RN-CNV-07). No pasa por la
      // ventana porque no viaja a ningún sitio.
      if (input.kind !== 'note') {
        const ventana = windowCountdown(
          {
            lastInboundAt: conv.last_inbound_at,
            optedOut: conv.opted_out,
          },
          now,
        );
        if (input.kind === 'text' && !ventana.canSendFreeform) {
          const plantillas = await this.quickReplies(tenantId, conv.brand_id);
          throw new WindowExpiredError(ventana.label, {
            window: ventana,
            // Se devuelve QUÉ SÍ se puede mandar. Un error que solo dice «no»
            // deja al agente sin salida y termina en un «te escribo por
            // privado» que no queda registrado en ninguna parte.
            availableTemplates: plantillas.map((q) => q.shortcut),
          });
        }
      }

      if (input.kind === 'text' && !input.text?.trim()) {
        throw new ValidationError('El mensaje no puede ir vacío.');
      }
      if (input.kind === 'template' && !input.templateName) {
        throw new ValidationError('Una plantilla necesita su nombre.');
      }

      const { rows } = await ctx.client.query<FilaMensaje>(
        `INSERT INTO cnv_messages
           (tenant_id, conversation_id, direction, author_type, author_id,
            kind, payload, template_name, status, cost_estimate)
         VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, direction, author_type, author_id, kind, payload,
                   status, cost_estimate, created_at`,
        [
          tenantId,
          conversationId,
          input.authorType,
          input.authorId ?? null,
          input.kind,
          JSON.stringify({ text: input.text ?? '' }),
          input.templateName ?? null,
          input.kind === 'note' ? 'sent' : 'queued',
          input.costEstimateMinor !== undefined
            ? Money.fromMinor(input.costEstimateMinor).toDecimalString()
            : null,
        ],
      );

      if (input.kind !== 'note') {
        await ctx.client.query(
          'UPDATE cnv_conversations SET last_msg_at = now(), updated_at = now() WHERE id = $1',
          [conversationId],
        );
      }

      return this.toMessageView(rows[0]!);
    });
  }

  // -------------------------------------------------------- Traspaso y colas

  /**
   * El bot entrega la conversación a una persona (RN-CNV-02).
   *
   * **El resumen es obligatorio**, y la restricción está en la base además de
   * aquí. La regla existe porque la alternativa es lo que hace todo el mundo:
   * el humano abre con «hola, ¿en qué puedo ayudarte?» y el cliente tiene que
   * contarlo todo otra vez. Es el momento exacto en el que la gente abandona.
   */
  async handoffToHuman(
    tenantId: string,
    conversationId: string,
    summary: HandoffSummary,
  ): Promise<void> {
    if (!summary.intent?.trim()) {
      throw new ValidationError(
        'El traspaso a un humano exige el resumen de contexto: sin él, el cliente tiene que repetirlo todo.',
      );
    }

    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `UPDATE cnv_conversations
            SET status = 'waiting_human',
                handoff_summary = $2,
                handoff_at = now(),
                -- La IA se apaga en ESTA conversación: si siguiera contestando
                -- mientras el humano escribe, el cliente vería dos respuestas
                -- distintas a la misma pregunta.
                ai_enabled = false,
                updated_at = now()
          WHERE id = $1 AND status IN ('bot','assigned')`,
        [conversationId, JSON.stringify(summary)],
      );
      if ((rowCount ?? 0) === 0) {
        throw new NotFoundError('Conversación no encontrada o ya traspasada.');
      }

      await enqueueEvent(ctx, {
        aggregateType: 'conversation',
        aggregateId: conversationId,
        eventType: 'conversation.handoff_requested',
        payload: { conversationId, intent: summary.intent },
      });
    });
  }

  async assign(
    tenantId: string,
    conversationId: string,
    assigneeId: string,
    actorId?: string,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `UPDATE cnv_conversations
            SET status = 'assigned', assignee_id = $2, ai_enabled = false,
                updated_at = now()
          WHERE id = $1 AND status <> 'resolved'`,
        [conversationId, assigneeId],
      );
      if ((rowCount ?? 0) === 0) {
        throw new NotFoundError('Conversación no encontrada o ya resuelta.');
      }
      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'conversation.assigned',
        resourceType: 'conversation',
        resourceId: conversationId,
        data: { assigneeId },
      });
    });
  }

  async resolve(
    tenantId: string,
    conversationId: string,
    actorId?: string,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `UPDATE cnv_conversations
            SET status = 'resolved', resolved_at = now(), updated_at = now()
          WHERE id = $1 AND status <> 'resolved'`,
        [conversationId],
      );
      if ((rowCount ?? 0) === 0) {
        throw new NotFoundError('Conversación no encontrada o ya resuelta.');
      }
      await recordAudit(ctx, {
        actorType: 'user',
        ...(actorId !== undefined ? { actorId } : {}),
        action: 'conversation.resolved',
        resourceType: 'conversation',
        resourceId: conversationId,
      });
    });
  }

  // ------------------------------------------- Acciones del agente (RN-CNV-05)

  /**
   * Crea un pedido en nombre del cliente, desde la bandeja.
   *
   * Pasa por `OrderingService.submit` con `channel='whatsapp'`, **nunca por
   * SQL** (RN-ORD-01). Es lo que garantiza que este pedido lleve las mismas
   * validaciones, el mismo cálculo de totales y los mismos eventos que uno de
   * la tienda: un atajo aquí daría pedidos que la cocina no ve y que la caja no
   * cuadra.
   */
  async createOrderFromInbox(
    tenantId: string,
    conversationId: string,
    input: {
      locationId: string;
      lines: Array<{
        productId: string;
        quantity: number;
        modifierOptionIds?: string[] | undefined;
        notes?: string | undefined;
      }>;
      agentId: string;
      customerName?: string | undefined;
    },
  ): Promise<{ orderId: string }> {
    const conv = await withTenant(this.pool, tenantId, (ctx) =>
      this.loadRow(ctx, conversationId),
    );

    const pedido = await this.ordering.submit(tenantId, {
      brandId: conv.brand_id,
      locationId: input.locationId,
      channel: 'whatsapp',
      lines: input.lines,
      ...(input.customerName ? { customerName: input.customerName } : {}),
      ...(conv.contact_phone ? { customerPhone: conv.contact_phone } : {}),
    });

    await withTenant(this.pool, tenantId, async (ctx) => {
      // El vínculo, en una tabla y no solo dentro de un JSON de mensaje
      // (T5.32). El mensaje de abajo sirve para que un agente lo LEA; esto
      // sirve para contarlo, y «¿cuántas conversaciones que atendió la IA
      // acabaron en pedido?» es la métrica que decide si el agente se queda
      // encendido. Rebuscar dentro de un payload no es medir: es estimar.
      await ctx.client.query(
        `INSERT INTO cnv_conversation_orders (tenant_id, conversation_id, order_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, order_id) DO NOTHING`,
        [tenantId, conversationId, pedido.id],
      );

      // Queda como mensaje de SISTEMA en el hilo: quien abra la conversación
      // mañana tiene que ver que de aquí salió un pedido, y cuál.
      await ctx.client.query(
        `INSERT INTO cnv_messages
           (tenant_id, conversation_id, direction, author_type, author_id,
            kind, payload, status)
         VALUES ($1,$2,'outbound','agent',$3,'system',$4,'sent')`,
        [
          tenantId,
          conversationId,
          input.agentId,
          JSON.stringify({
            text: `Pedido creado desde la bandeja: ${pedido.id}`,
            orderId: pedido.id,
          }),
        ],
      );
      await recordAudit(ctx, {
        actorType: 'user',
        actorId: input.agentId,
        action: 'conversation.order_created',
        resourceType: 'conversation',
        resourceId: conversationId,
        data: { orderId: pedido.id, channel: 'whatsapp' },
      });
    });

    return { orderId: pedido.id };
  }

  // ------------------------------------------------------------------ Lectura

  /**
   * La bandeja. Filtrable por cola, estado y agente, y buscable (RN-CNV-08).
   *
   * La búsqueda usa el índice de texto de Postgres y no un motor dedicado: la
   * spec lo pide explícitamente hasta que haya una necesidad **medida**.
   */
  async listConversations(
    tenantId: string,
    filter: {
      status?: string | undefined;
      queue?: string | undefined;
      assigneeId?: string | undefined;
      brandId?: string | undefined;
      search?: string | undefined;
      now?: Date | undefined;
    } = {},
  ): Promise<ConversationView[]> {
    const now = filter.now ?? new Date();

    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<FilaConversacion>(
        `SELECT c.id, c.brand_id, b.name AS brand_name, c.channel,
                c.contact_id, ct.phone AS contact_phone,
                ct.display_name AS contact_name, ct.opted_out,
                c.status, c.assignee_id, c.queue, c.ai_enabled,
                c.last_msg_at, c.last_inbound_at,
                c.handoff_at, c.handoff_summary,
                (SELECT count(*) FROM cnv_messages m
                  WHERE m.conversation_id = c.id AND m.kind <> 'note')
                  AS message_count,
                COALESCE((SELECT sum(m.cost_estimate) FROM cnv_messages m
                  WHERE m.conversation_id = c.id), 0) AS cost_total,
                COALESCE((SELECT array_agg(t.name) FROM cnv_conversation_tags ct2
                   JOIN cnv_tags t ON t.id = ct2.tag_id
                  WHERE ct2.conversation_id = c.id), '{}') AS tags
           FROM cnv_conversations c
           JOIN org_brands b ON b.id = c.brand_id
           JOIN wa_contacts ct ON ct.id = c.contact_id
          WHERE ($1::text IS NULL OR c.status = $1)
            AND ($2::text IS NULL OR c.queue = $2)
            AND ($3::uuid IS NULL OR c.assignee_id = $3)
            AND ($4::uuid IS NULL OR c.brand_id = $4)
            AND ($5::text IS NULL
                 OR ct.phone ILIKE '%' || $5 || '%'
                 OR ct.display_name ILIKE '%' || $5 || '%'
                 OR EXISTS (
                      SELECT 1 FROM cnv_messages m
                       WHERE m.conversation_id = c.id
                         AND to_tsvector('spanish', COALESCE(m.payload->>'text',''))
                             @@ plainto_tsquery('spanish', $5)))
          ORDER BY c.last_msg_at DESC NULLS LAST
          LIMIT 200`,
        [
          filter.status ?? null,
          filter.queue ?? null,
          filter.assigneeId ?? null,
          filter.brandId ?? null,
          filter.search ?? null,
        ],
      );
      return rows.map((r) => this.toConversationView(r, now));
    });
  }

  async getConversation(
    tenantId: string,
    conversationId: string,
    now = new Date(),
  ): Promise<ConversationView> {
    const todas = await this.listConversations(tenantId, { now });
    const encontrada = todas.find((c) => c.id === conversationId);
    if (!encontrada) throw new NotFoundError('Conversación no encontrada.');
    return encontrada;
  }

  /**
   * El hilo. `includeNotes` decide si salen las notas internas.
   *
   * Por defecto **NO salen**: quien lo pide sin declararlo suele ser un cliente
   * de la API que va a enseñar el hilo a alguien. Que haya que pedirlas
   * explícitamente hace difícil filtrarlas por accidente (RN-CNV-07).
   */
  async listMessages(
    tenantId: string,
    conversationId: string,
    options: { includeNotes?: boolean } = {},
  ): Promise<MessageView[]> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<FilaMensaje>(
        `SELECT id, direction, author_type, author_id, kind, payload,
                status, cost_estimate, created_at
           FROM cnv_messages
          WHERE conversation_id = $1
            AND ($2::boolean OR kind <> 'note')
          ORDER BY created_at`,
        [conversationId, options.includeNotes ?? false],
      );
      return rows.map((r) => this.toMessageView(r));
    });
  }

  async quickReplies(
    tenantId: string,
    brandId?: string,
  ): Promise<Array<{ shortcut: string; body: string }>> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ shortcut: string; body: string }>(
        `SELECT shortcut, body FROM cnv_quick_replies
          WHERE brand_id IS NULL OR brand_id = $1
          ORDER BY shortcut`,
        [brandId ?? null],
      );
      return rows;
    });
  }

  // ----------------------------------------------------------------- Apoyo

  private async loadRow(
    ctx: TenantContext,
    conversationId: string,
  ): Promise<{
    id: string;
    brand_id: string;
    contact_id: string;
    contact_phone: string;
    last_inbound_at: Date | null;
    opted_out: boolean;
    status: string;
  }> {
    const { rows } = await ctx.client.query<{
      id: string;
      brand_id: string;
      contact_id: string;
      contact_phone: string;
      last_inbound_at: Date | null;
      opted_out: boolean;
      status: string;
    }>(
      `SELECT c.id, c.brand_id, c.contact_id, ct.phone AS contact_phone,
              c.last_inbound_at, ct.opted_out, c.status
         FROM cnv_conversations c
         JOIN wa_contacts ct ON ct.id = c.contact_id
        WHERE c.id = $1`,
      [conversationId],
    );
    const fila = rows[0];
    if (!fila) throw new NotFoundError('Conversación no encontrada.');
    return fila;
  }

  private toConversationView(r: FilaConversacion, now: Date): ConversationView {
    return {
      id: r.id,
      brandId: r.brand_id,
      brandName: r.brand_name,
      channel: r.channel,
      contactId: r.contact_id,
      contactPhone: r.contact_phone,
      contactName: r.contact_name,
      status: r.status,
      assigneeId: r.assignee_id,
      queue: r.queue,
      aiEnabled: r.ai_enabled,
      lastMsgAt: r.last_msg_at?.toISOString() ?? null,
      window: windowCountdown(
        { lastInboundAt: r.last_inbound_at, optedOut: r.opted_out },
        now,
      ),
      messageCount: Number(r.message_count),
      costTotal: Money.parse(r.cost_total ?? '0').toDecimalString(),
      tags: r.tags ?? [],
      handoffAt: r.handoff_at?.toISOString() ?? null,
      handoffSummary: r.handoff_summary,
    };
  }

  private toMessageView(r: FilaMensaje): MessageView {
    return {
      id: r.id,
      direction: r.direction,
      authorType: r.author_type,
      authorId: r.author_id,
      kind: r.kind,
      payload: r.payload,
      status: r.status,
      costEstimate: r.cost_estimate
        ? Money.parse(r.cost_estimate).toDecimalString()
        : null,
      createdAt: r.created_at.toISOString(),
    };
  }
}

interface FilaConversacion {
  id: string;
  brand_id: string;
  brand_name: string;
  channel: string;
  contact_id: string;
  contact_phone: string;
  contact_name: string | null;
  opted_out: boolean;
  status: string;
  assignee_id: string | null;
  queue: string;
  ai_enabled: boolean;
  last_msg_at: Date | null;
  last_inbound_at: Date | null;
  handoff_at: Date | null;
  handoff_summary: HandoffSummary | null;
  message_count: string;
  cost_total: string | null;
  tags: string[] | null;
}

interface FilaMensaje {
  id: string;
  direction: string;
  author_type: string;
  author_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  cost_estimate: string | null;
  created_at: Date;
}
