/**
 * Reglas de envío por WhatsApp (spec 12, RN-WA-01/02/04).
 *
 * Vive en el dominio porque decide sobre DINERO y sobre consentimiento, y las
 * dos cosas tienen que resolverse igual en cualquier punto del sistema.
 *
 * Meta cobra por mensaje fuera de la ventana de 24 horas. Un sistema que manda
 * plantilla cuando podía mandar texto libre paga de más en cada pedido; uno que
 * intenta texto libre fuera de ventana simplemente no entrega, y el cliente se
 * queda sin saber que su comida salió. La diferencia entre las dos cosas es una
 * resta de fechas, y por eso está aquí y no repartida por tres servicios.
 *
 * El opt-out (RN-WA-04) es lo único que no admite excepción: si alguien pidió
 * no recibir mensajes, no se le manda ninguno. Ni de estado, ni de nada.
 */

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

/** Ventana de servicio de Meta: 24 h desde el último mensaje DEL CLIENTE. */
export const SERVICE_WINDOW_HOURS = 24;

export type MessageKind = 'freeform' | 'template';

export interface ContactState {
  /** Último mensaje entrante del cliente. `null` si nunca escribió. */
  lastInboundAt?: Date | null;
  /** RN-WA-04: opt-out inmediato y persistente. */
  optedOut: boolean;
}

/**
 * ¿Está abierta la ventana de 24 h?
 *
 * Se cuenta desde el último mensaje ENTRANTE. Contarla desde el último saliente
 * la mantendría abierta para siempre: bastaría con escribirle al cliente para
 * poder volver a escribirle, que es justo lo que la regla de Meta impide.
 */
export function isWindowOpen(
  contacto: ContactState,
  now: Date,
  windowHours = SERVICE_WINDOW_HOURS,
): boolean {
  if (!contacto.lastInboundAt) return false;
  const horas = (now.getTime() - contacto.lastInboundAt.getTime()) / 3_600_000;
  // Un mensaje "del futuro" (reloj desajustado en el webhook) no abre una
  // ventana infinita: se trata como recién llegado.
  return horas >= 0 ? horas < windowHours : true;
}

export type SendDecision =
  | { allowed: true; kind: MessageKind; reason: string }
  | { allowed: false; reason: string; code: string };

/**
 * Decide si se puede enviar y de qué forma.
 *
 * El orden de las comprobaciones importa: el opt-out se mira ANTES que la
 * ventana. Un contacto que se dio de baja hace cinco minutos tiene la ventana
 * abierta, y preguntar primero por la ventana daría permiso para escribirle.
 */
export function decideSend(
  contacto: ContactState,
  now: Date,
  windowHours = SERVICE_WINDOW_HOURS,
): SendDecision {
  if (contacto.optedOut) {
    return {
      allowed: false,
      reason: 'El contacto pidió no recibir mensajes.',
      code: 'WA_OPTED_OUT',
    };
  }

  if (isWindowOpen(contacto, now, windowHours)) {
    // Dentro de ventana el texto libre es gratis: usar plantilla aquí es pagar
    // por nada, en cada pedido y en cada estado.
    return {
      allowed: true,
      kind: 'freeform',
      reason: 'Ventana de servicio abierta.',
    };
  }

  // Fuera de ventana SOLO caben plantillas aprobadas (RN-WA-02). Intentar
  // texto libre no da error visible: Meta lo descarta y el cliente se queda
  // sin enterarse de que su comida salió.
  return {
    allowed: true,
    kind: 'template',
    reason: 'Fuera de la ventana de 24 h: solo plantilla aprobada.',
  };
}

/**
 * Presupuesto de mensajes por pedido (RN-WA-01).
 *
 * El objetivo de la spec para F5 es ≤ 8 mensajes por pedido. No es una métrica
 * de vanidad: a partir del cambio de precios de Meta del 01-10-2026 cada
 * mensaje de servicio se cobra, y un pedido de S/ 35 con doce notificaciones
 * puede comerse su propio margen.
 *
 * Se evalúa aquí para que el mismo número lo vea el panel de costos y el
 * servicio que decide si mandar una notificación más.
 */
export interface MessageBudget {
  /** Objetivo por pedido. */
  target: number;
  /** A partir de cuántos se avisa. */
  warnAt: number;
}

export const DEFAULT_MESSAGE_BUDGET: MessageBudget = {
  target: 8,
  warnAt: 6,
};

export type BudgetStatus = 'ok' | 'warning' | 'over';

export function checkMessageBudget(
  sentForOrder: number,
  budget: MessageBudget = DEFAULT_MESSAGE_BUDGET,
): { status: BudgetStatus; sent: number; remaining: number } {
  if (!Number.isInteger(sentForOrder) || sentForOrder < 0) {
    throw new MessagingError(
      `Contador de mensajes inválido: ${sentForOrder}.`,
      'WA_INVALID_COUNT',
    );
  }
  if (budget.warnAt > budget.target) {
    throw new MessagingError(
      'El aviso de presupuesto debe llegar antes del objetivo, no después.',
      'WA_INVALID_BUDGET',
    );
  }

  const status: BudgetStatus =
    sentForOrder >= budget.target
      ? 'over'
      : sentForOrder >= budget.warnAt
        ? 'warning'
        : 'ok';

  return {
    status,
    sent: sentForOrder,
    remaining: budget.target - sentForOrder,
  };
}

/**
 * Estados de pedido que MERECEN un mensaje.
 *
 * La lista es corta a propósito. La tentación es notificar cada transición
 * —son doce— y eso multiplica el costo por cuatro sin decirle al cliente nada
 * que le importe: nadie necesita saber que su pedido pasó de «empacado» a
 * «despachado». Se avisa de lo que cambia lo que el cliente puede hacer:
 * confirmado, en preparación, en camino, entregado.
 */
export const NOTIFIABLE_ORDER_STATES = [
  'accepted',
  'preparing',
  'dispatched',
  'delivered',
  'rejected',
  'cancelled',
] as const;

export type NotifiableOrderState = (typeof NOTIFIABLE_ORDER_STATES)[number];

export function isNotifiable(state: string): state is NotifiableOrderState {
  return (NOTIFIABLE_ORDER_STATES as readonly string[]).includes(state);
}

/** Nombre de la plantilla aprobada para cada estado. */
export const STATE_TEMPLATES: Record<NotifiableOrderState, string> = {
  accepted: 'pedido_confirmado',
  preparing: 'pedido_en_preparacion',
  dispatched: 'pedido_en_camino',
  delivered: 'pedido_entregado',
  rejected: 'pedido_rechazado',
  cancelled: 'pedido_cancelado',
};
