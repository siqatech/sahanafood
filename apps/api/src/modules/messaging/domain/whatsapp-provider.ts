/**
 * Puerto hacia WhatsApp (spec 12).
 *
 * DP-04 —BSP intermediario o Cloud API directa de Meta— sigue abierto, así que
 * la interfaz se queda en lo que ambos caminos comparten: mandar un mensaje y
 * recibir un id con el que seguirle la pista. Todo lo demás (formato de
 * plantillas, forma del webhook, códigos de error) es dialecto del proveedor y
 * no puede filtrarse hacia dentro.
 *
 * Los fallos se separan en dos, como en facturación y por el mismo motivo:
 * `rejected` no se arregla reintentando —plantilla no aprobada, número
 * inválido, ventana cerrada— y `error` sí. Confundirlos es reintentar mil
 * veces un número que no existe, o rendirse por un corte de diez segundos.
 */

export interface OutboundMessage {
  to: string;
  kind: 'freeform' | 'template';
  /** Obligatorio cuando `kind` es `template`. */
  templateName?: string | undefined;
  /** Variables de la plantilla, en el orden en que las espera. */
  templateParams?: readonly string[] | undefined;
  body?: string | undefined;
}

export type SendResult =
  | { kind: 'sent'; providerMessageId: string }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'error'; message: string; retryable: true };

export interface WhatsAppProvider {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** Mensaje entrante, ya normalizado desde el webhook del proveedor. */
export interface InboundMessage {
  providerMessageId: string;
  from: string;
  body: string;
  receivedAt: Date;
}
