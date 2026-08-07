import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  decideSend,
  checkMessageBudget,
  isNotifiable,
  STATE_TEMPLATES,
  type ContactState,
  type NotifiableOrderState,
} from '@sahana/domain';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { PG_POOL } from '../../../database/database.module.js';
import { recordAudit } from '../../audit/index.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import type {
  WhatsAppProvider,
  InboundMessage,
} from '../domain/whatsapp-provider.js';
import { WHATSAPP_PROVIDER } from '../messaging.tokens.js';

/**
 * Notificaciones de estado por WhatsApp (spec 12, T4.28).
 *
 * La regla que gobierna el módulo entero: **un fallo de WhatsApp NUNCA puede
 * afectar al pedido**. La comida sale igual aunque el aviso no llegue. Por eso
 * el envío ocurre reaccionando a un evento y no dentro de la transacción que
 * cambia el estado: un timeout de Meta no puede dejar un pedido sin aceptar.
 *
 * Y la que gobierna el gasto: dentro de la ventana de 24 h el texto libre es
 * gratis, fuera solo caben plantillas y se pagan. La decisión vive en
 * `@sahana/domain` porque es la misma en el panel de costos y aquí.
 */

export interface NotifyResult {
  sent: boolean;
  reason: string;
  kind?: 'freeform' | 'template' | undefined;
  messageId?: string | undefined;
}

export interface OrderMessageStats {
  orderId: string;
  messages: number;
  budget: ReturnType<typeof checkMessageBudget>;
}

interface FilaContacto {
  id: string;
  phone: string;
  last_inbound_at: Date | null;
  opted_out: boolean;
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Contactos y consentimiento
  // -------------------------------------------------------------------------

  /** Busca o crea el contacto por teléfono. */
  async upsertContact(
    ctx: TenantContext,
    phone: string,
    displayName?: string,
  ): Promise<FilaContacto> {
    const { rows } = await ctx.client.query<FilaContacto>(
      `INSERT INTO wa_contacts (tenant_id, phone, display_name)
       VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, wa_contacts.display_name),
             updated_at = now()
       RETURNING id, phone, last_inbound_at, opted_out`,
      [ctx.tenantId, phone, displayName ?? null],
    );
    return rows[0]!;
  }

  /**
   * Registra consentimiento o baja.
   *
   * El texto exacto es obligatorio (RN-T10, Ley 29733): si mañana cambia la
   * política y alguien pregunta qué aceptó un cliente en 2026, la respuesta
   * tiene que ser el texto de 2026 — y eso no se reconstruye después.
   */
  async recordConsent(
    tenantId: string,
    datos: {
      phone: string;
      action: 'granted' | 'revoked';
      source: string;
      consentText: string;
      actorId?: string;
      traceId?: string;
    },
  ): Promise<{ contactId: string; optedOut: boolean }> {
    if (!datos.consentText?.trim()) {
      throw new ValidationError(
        'El consentimiento necesita el texto exacto que aceptó la persona (RN-T10).',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const contacto = await this.upsertContact(ctx, datos.phone);

      await ctx.client.query(
        `INSERT INTO wa_consents
           (tenant_id, contact_id, action, source, consent_text, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          ctx.tenantId,
          contacto.id,
          datos.action,
          datos.source,
          datos.consentText,
          datos.actorId ?? null,
        ],
      );

      // El opt-out es un campo, no una lectura del histórico: comprobarlo en
      // cada envío tiene que costar una consulta, no un recorrido.
      const optedOut = datos.action === 'revoked';
      await ctx.client.query(
        `UPDATE wa_contacts
            SET opted_out = $1,
                opted_out_at = CASE WHEN $1 THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $2`,
        [optedOut, contacto.id],
      );

      await recordAudit(ctx, {
        actorType: datos.actorId ? 'user' : 'system',
        ...(datos.actorId ? { actorId: datos.actorId } : {}),
        action:
          datos.action === 'granted'
            ? 'messaging.consent_granted'
            : 'messaging.consent_revoked',
        resourceType: 'wa_contact',
        resourceId: contacto.id,
        data: { source: datos.source },
        ...(datos.traceId ? { traceId: datos.traceId } : {}),
      });

      return { contactId: contacto.id, optedOut };
    });
  }

  // -------------------------------------------------------------------------
  // Notificaciones de estado
  // -------------------------------------------------------------------------

  /**
   * Avisa al cliente del cambio de estado de su pedido.
   *
   * Devuelve por qué NO se envió cuando no se envía, en vez de lanzar: un
   * contacto dado de baja o un pedido sin teléfono son casos normales, no
   * errores. Tratarlos como excepción haría que el consumidor de eventos
   * reintentara en bucle algo que nunca va a cambiar.
   */
  async notifyOrderState(
    tenantId: string,
    orderId: string,
    state: string,
    options: { ctx?: TenantContext; now?: Date; traceId?: string } = {},
  ): Promise<NotifyResult> {
    if (!isNotifiable(state)) {
      return { sent: false, reason: `El estado "${state}" no se notifica.` };
    }

    const preparacion = await this.prepararEnvio(
      tenantId,
      orderId,
      state,
      options,
    );
    if ('reason' in preparacion)
      return { sent: false, reason: preparacion.reason };

    const { contacto, plantilla, parametros, decision, pedidoTelefono } =
      preparacion;

    // El envío ocurre FUERA de cualquier transacción de negocio: un timeout de
    // Meta no puede dejar un pedido a medias.
    const resultado = await this.provider.send({
      to: pedidoTelefono,
      kind: decision.kind,
      ...(decision.kind === 'template'
        ? { templateName: plantilla, templateParams: parametros }
        : { body: this.textoLibre(state, parametros) }),
    });

    return withTenant(this.pool, tenantId, async (ctx) => {
      if (resultado.kind === 'sent') {
        const { rows } = await ctx.client.query<{ id: string }>(
          `INSERT INTO wa_messages
             (tenant_id, contact_id, order_id, direction, kind, template_name,
              body, status, provider_message_id, provider, sent_at)
           VALUES ($1,$2,$3,'outbound',$4,$5,$6,'sent',$7,$8,now())
           ON CONFLICT (tenant_id, order_id, template_name)
             WHERE order_id IS NOT NULL AND direction = 'outbound'
                   AND template_name IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [
            ctx.tenantId,
            contacto.id,
            orderId,
            decision.kind,
            plantilla,
            this.textoLibre(state, parametros),
            resultado.providerMessageId,
            this.provider.name,
          ],
        );
        return {
          sent: true,
          reason: decision.reason,
          kind: decision.kind,
          messageId: rows[0]?.id,
        };
      }

      // Rechazo o error: se registra para el panel y se sigue. El pedido no se
      // entera de esto.
      await ctx.client.query(
        `INSERT INTO wa_messages
           (tenant_id, contact_id, order_id, direction, kind, template_name,
            status, provider, error_code, error_message, attempts)
         VALUES ($1,$2,$3,'outbound',$4,$5,'failed',$6,$7,$8,1)
         ON CONFLICT (tenant_id, order_id, template_name)
           WHERE order_id IS NOT NULL AND direction = 'outbound'
                 AND template_name IS NOT NULL
           DO NOTHING`,
        [
          ctx.tenantId,
          contacto.id,
          orderId,
          decision.kind,
          plantilla,
          this.provider.name,
          resultado.kind === 'rejected' ? resultado.code : null,
          resultado.kind === 'rejected' ? resultado.message : resultado.message,
        ],
      );

      this.logger.warn(
        `Aviso de "${state}" no entregado para el pedido ${orderId}: ${resultado.message}`,
      );
      return { sent: false, reason: resultado.message };
    });
  }

  /**
   * Reúne lo necesario para enviar y aplica las reglas del dominio.
   *
   * Separado del envío porque aquí se decide, y decidir tiene que poder
   * probarse sin proveedor delante.
   */
  private async prepararEnvio(
    tenantId: string,
    orderId: string,
    state: NotifiableOrderState,
    options: { ctx?: TenantContext; now?: Date },
  ): Promise<
    | { reason: string }
    | {
        contacto: FilaContacto;
        pedidoTelefono: string;
        plantilla: string;
        parametros: string[];
        decision: { kind: 'freeform' | 'template'; reason: string };
      }
  > {
    const ejecutar = async (
      ctx: TenantContext,
    ): Promise<
      ReturnType<MessagingService['prepararEnvio']> extends Promise<infer R>
        ? R
        : never
    > => {
      const { rows: pedidos } = await ctx.client.query<{
        customer_phone: string | null;
        customer_name: string | null;
        order_number: number;
        brand_name: string;
      }>(
        `SELECT o.customer_phone, o.customer_name, o.order_number, b.name AS brand_name
           FROM ord_orders o
           JOIN org_brands b ON b.id = o.brand_id
          WHERE o.id = $1`,
        [orderId],
      );
      const pedido = pedidos[0];
      if (!pedido) {
        throw new NotFoundError(
          'No existe ese pedido, o no pertenece a este tenant.',
        );
      }
      if (!pedido.customer_phone) {
        // Normal en mostrador: nadie pide el teléfono para vender un menú.
        return { reason: 'El pedido no tiene teléfono de contacto.' };
      }

      const contacto = await this.upsertContact(
        ctx,
        pedido.customer_phone,
        pedido.customer_name ?? undefined,
      );

      const estado: ContactState = {
        lastInboundAt: contacto.last_inbound_at,
        optedOut: contacto.opted_out,
      };
      const decision = decideSend(estado, options.now ?? new Date());
      if (!decision.allowed) return { reason: decision.reason };

      // Presupuesto (RN-WA-01): se avisa, no se corta. Cortar dejaría al
      // cliente sin el aviso de «tu pedido llegó», que es el que más importa.
      const { rows: contador } = await ctx.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM wa_messages
          WHERE order_id = $1 AND direction = 'outbound'`,
        [orderId],
      );
      const presupuesto = checkMessageBudget(Number(contador[0]?.n ?? 0));
      if (presupuesto.status !== 'ok') {
        this.logger.warn(
          `El pedido ${orderId} lleva ${presupuesto.sent} mensajes (objetivo ${presupuesto.sent + presupuesto.remaining}).`,
        );
      }

      return {
        contacto,
        pedidoTelefono: pedido.customer_phone,
        plantilla: STATE_TEMPLATES[state],
        parametros: [
          pedido.customer_name ?? 'Hola',
          String(pedido.order_number),
          pedido.brand_name,
        ],
        decision: { kind: decision.kind, reason: decision.reason },
      };
    };

    return options.ctx
      ? ejecutar(options.ctx)
      : withTenant(this.pool, tenantId, ejecutar);
  }

  /** Texto equivalente a la plantilla, para dentro de ventana y para el registro. */
  private textoLibre(state: string, [nombre, numero, marca]: string[]): string {
    const frases: Record<string, string> = {
      accepted: `¡Confirmado! Tu pedido #${numero} de ${marca} ya está en cocina.`,
      preparing: `Tu pedido #${numero} se está preparando.`,
      dispatched: `Tu pedido #${numero} va en camino.`,
      delivered: `Tu pedido #${numero} fue entregado. ¡Buen provecho!`,
      rejected: `Lo sentimos: no pudimos tomar tu pedido #${numero}.`,
      cancelled: `Tu pedido #${numero} fue cancelado.`,
    };
    return `${nombre}: ${frases[state] ?? `Tu pedido #${numero} cambió de estado.`}`;
  }

  // -------------------------------------------------------------------------
  // Entrantes (webhook)
  // -------------------------------------------------------------------------

  /**
   * Registra un mensaje entrante y ABRE la ventana de 24 h.
   *
   * Idempotente por `provider_message_id` (RN-WA-05): el webhook de Meta
   * entrega at-least-once, y sin el dedupe un reintento de su lado reabriría
   * una ventana ya cerrada y contaría como un mensaje más en el KPI de costo.
   */
  async receiveInbound(
    tenantId: string,
    mensaje: InboundMessage,
  ): Promise<{ contactId: string; duplicate: boolean }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const contacto = await this.upsertContact(ctx, mensaje.from);

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO wa_messages
           (tenant_id, contact_id, direction, body, status,
            provider_message_id, provider, occurred_at)
         VALUES ($1,$2,'inbound',$3,'received',$4,$5,$6)
         ON CONFLICT (tenant_id, provider_message_id)
           WHERE provider_message_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          ctx.tenantId,
          contacto.id,
          mensaje.body,
          mensaje.providerMessageId,
          this.provider.name,
          mensaje.receivedAt,
        ],
      );

      if (rows.length === 0) {
        return { contactId: contacto.id, duplicate: true };
      }

      // Solo un mensaje NUEVO mueve la ventana.
      await ctx.client.query(
        `UPDATE wa_contacts SET last_inbound_at = $1, updated_at = now()
          WHERE id = $2 AND (last_inbound_at IS NULL OR last_inbound_at < $1)`,
        [mensaje.receivedAt, contacto.id],
      );

      // «BAJA» / «STOP» da de baja en el acto (RN-WA-04). No se pone en una
      // cola ni se manda a un panel: la persona ya dijo que no.
      if (/^\s*(baja|stop|salir|unsubscribe)\s*$/i.test(mensaje.body)) {
        await ctx.client.query(
          `UPDATE wa_contacts SET opted_out = true, opted_out_at = now(),
                                  updated_at = now()
            WHERE id = $1`,
          [contacto.id],
        );
        await ctx.client.query(
          `INSERT INTO wa_consents
             (tenant_id, contact_id, action, source, consent_text)
           VALUES ($1,$2,'revoked','whatsapp_inbound',$3)`,
          [ctx.tenantId, contacto.id, mensaje.body],
        );
      }

      return { contactId: contacto.id, duplicate: false };
    });
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  /** KPI de mensajes por pedido (RN-WA-01), para el panel de costos. */
  async statsForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<OrderMessageStats> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      // Se comprueba que el pedido EXISTE en este tenant antes de contar. Sin
      // esto, pedir el id de otro tenant devuelve un 200 con ceros: RLS impide
      // la fuga, pero la respuesta no distingue «no tiene mensajes» de «no es
      // tuyo», y devuelve el id ajeno dentro del cuerpo.
      const { rows: pedido } = await ctx.client.query<{ id: string }>(
        `SELECT id FROM ord_orders WHERE id = $1`,
        [orderId],
      );
      if (!pedido[0]) {
        throw new NotFoundError(
          'No existe ese pedido, o no pertenece a este tenant.',
        );
      }

      const { rows } = await ctx.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM wa_messages
          WHERE order_id = $1 AND direction = 'outbound'`,
        [orderId],
      );
      const enviados = Number(rows[0]?.n ?? 0);
      return {
        orderId,
        messages: enviados,
        budget: checkMessageBudget(enviados),
      };
    });
  }

  /** Media de mensajes por pedido del periodo. Es el número del panel. */
  async messagesPerOrder(
    tenantId: string,
    desde: Date,
    hasta: Date,
  ): Promise<{ orders: number; messages: number; average: number }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        pedidos: string;
        mensajes: string;
      }>(
        `SELECT count(DISTINCT order_id)::text AS pedidos,
                count(*)::text AS mensajes
           FROM wa_messages
          WHERE direction = 'outbound' AND order_id IS NOT NULL
            AND occurred_at >= $1 AND occurred_at < $2`,
        [desde, hasta],
      );
      const pedidos = Number(rows[0]?.pedidos ?? 0);
      const mensajes = Number(rows[0]?.mensajes ?? 0);
      return {
        orders: pedidos,
        messages: mensajes,
        // Redondeado a dos decimales: es un indicador de costo, no una medida
        // física.
        average:
          pedidos === 0 ? 0 : Math.round((mensajes / pedidos) * 100) / 100,
      };
    });
  }
}
