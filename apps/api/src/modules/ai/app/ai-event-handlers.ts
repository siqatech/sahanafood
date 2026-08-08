import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '../../../database/rls.js';
import {
  ConversationsService,
  WindowExpiredError,
} from '../../conversations/index.js';
import { AgentService } from './agent.service.js';

/**
 * El agente REACCIONA a los mensajes que llegan (spec 19 §1, ADR-0007).
 *
 * Sin este consumidor, el agente entero era inalcanzable desde fuera: la única
 * ruta que llamaba a `AgentService.respond` era el **sandbox**, que es la
 * pantalla de pruebas del dueño. Un cliente escribiendo por WhatsApp entraba en
 * `receiveInbound`, se guardaba su mensaje, se publicaba
 * `conversation.message_received`… y **no lo escuchaba nadie**. Toda la
 * plataforma de T5.22–T5.31 —reglas, herramientas, RAG, validador,
 * presupuesto— existía, estaba probada y no contestaba a nadie.
 *
 * Es la misma forma del fallo que ya destaparon T4.30 (`processPending` sin
 * llamar), T5.07 (las columnas de comisión sin escritor) y T5.31 (el prompt
 * versionado sin usar). Aquí llegaba más lejos: no faltaba una llamada dentro
 * de un flujo, faltaba el flujo entero.
 *
 * Va por evento y no por llamada directa desde `receiveInbound` porque
 * Conversations NO puede depender de AI: la flecha ya va al revés, y ADR-0011
 * exige que apagar la IA deje el sistema entero en pie. Con el consumidor,
 * apagar la IA es no arrancar este consumidor — la bandeja sigue funcionando
 * exactamente igual, con personas.
 */

export interface DomainEventMessage {
  eventId: string;
  tenantId: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  traceId?: string | null;
}

export type DomainEventHandler = (
  ctx: TenantContext,
  event: DomainEventMessage,
) => Promise<void>;

/** Nombre del consumidor en la tabla `inbox`. Cambiarlo reprocesa todo. */
export const AI_CONSUMER = 'ai';

@Injectable()
export class AiEventHandlers {
  private readonly logger = new Logger(AiEventHandlers.name);

  constructor(
    private readonly agent: AgentService,
    private readonly conversations: ConversationsService,
  ) {}

  handlers(): Record<string, DomainEventHandler> {
    return {
      'conversation.message_received': async (ctx, event) => {
        const conversationId = String(
          event.payload['conversationId'] ?? event.aggregateId,
        );

        const { rows } = await ctx.client.query<{
          brand_id: string;
          status: string;
          ai_enabled: boolean;
          ya_contestado: boolean;
        }>(
          `SELECT c.brand_id, c.status, c.ai_enabled,
                  EXISTS (
                    SELECT 1 FROM cnv_messages m
                     WHERE m.conversation_id = c.id
                       AND m.direction = 'outbound'
                       AND m.author_type = 'bot'
                       AND m.created_at >= (
                         SELECT created_at FROM cnv_messages
                          WHERE id = $2
                       )
                  ) AS ya_contestado
             FROM cnv_conversations c
            WHERE c.id = $1`,
          [conversationId, event.payload['messageId'] ?? null],
        );
        const conv = rows[0];
        if (!conv) return;

        // Una persona ya se hizo cargo: el bot NO vuelve a meterse. Es la
        // mitad de RN-CNV-02 que hace útil el traspaso — si el agente siguiera
        // contestando después de derivar, el cliente vería a dos
        // interlocutores a la vez.
        if (conv.status !== 'bot' || !conv.ai_enabled) return;

        // Idempotencia. El `inbox` marca el evento procesado en ESTA
        // transacción, pero la respuesta se genera fuera de ella (necesita sus
        // propios cerrojos), así que una caída entre medias reentregaría el
        // evento. Sin esta comprobación, el cliente recibiría la misma
        // respuesta dos veces — que en WhatsApp se ve exactamente como un bot
        // roto.
        if (conv.ya_contestado) {
          this.logger.debug(
            `Mensaje de ${conversationId} ya contestado: entrega repetida.`,
          );
          return;
        }

        const texto = await this.textoDelMensaje(ctx, event);
        if (!texto) return;

        const respuesta = await this.agent.respond(event.tenantId, {
          conversationId,
          brandId: conv.brand_id,
          text: texto,
        });

        // Una derivación NO escribe: `respond` ya llamó a `handoffToHuman` con
        // su resumen, y el cliente tiene que recibir a la persona, no una
        // despedida del bot.
        if (respuesta.resolution === 'handoff' || !respuesta.text) return;

        try {
          await this.conversations.sendMessage(event.tenantId, conversationId, {
            kind: 'text',
            text: respuesta.text,
            authorType: 'bot',
          });
        } catch (error) {
          if (error instanceof WindowExpiredError) {
            // No debería pasar —se acaba de recibir un mensaje del cliente,
            // así que la ventana está abierta— pero si el reloj o la ventana
            // dicen otra cosa, esto NO puede envenenar la cola: el evento se
            // da por procesado y queda el registro.
            this.logger.warn(
              `Ventana cerrada al responder en ${conversationId}: no se envía.`,
            );
            return;
          }
          throw error;
        }
      },
    };
  }

  /** El texto del mensaje que disparó el evento. */
  private async textoDelMensaje(
    ctx: TenantContext,
    event: DomainEventMessage,
  ): Promise<string | null> {
    const messageId = event.payload['messageId'];
    if (typeof messageId !== 'string' || messageId === '') return null;

    const { rows } = await ctx.client.query<{ payload: { text?: string } }>(
      `SELECT payload FROM cnv_messages WHERE id = $1 AND direction = 'inbound'`,
      [messageId],
    );
    const texto = rows[0]?.payload?.text?.trim();
    return texto ? texto : null;
  }
}
