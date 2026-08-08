/**
 * Estados de una intención de pago (spec 10, ADR-0016).
 *
 * Vive en `@sahana/domain` por el mismo motivo que la máquina del pedido: la
 * decisión de si un webhook puede aplicarse **no puede depender de en qué
 * proceso llegó**. El webhook entra por la API, el barrido de expiración corre
 * en el worker y el panel consulta desde otro sitio; los tres tienen que
 * coincidir sobre qué es una transición legítima.
 *
 * La propiedad que de verdad importa aquí no es cuáles son los estados, sino
 * que el avance es **MONÓTONO**: un pago capturado no vuelve nunca atrás. Las
 * pasarelas reintentan sus notificaciones y **no garantizan el orden**; el
 * webhook de `authorized` puede aterrizar diez minutos después del de
 * `captured` porque el primero falló y se reintentó. Sin monotonía, ese
 * reintento tardío desconfirmaría una venta ya entregada.
 */

export const PAYMENT_STATES = [
  /** Creada, esperando que el cliente pague. */
  'pending',
  /** La pasarela retuvo los fondos pero aún no los cobró. */
  'authorized',
  /** Cobrado. Es el único estado que confirma un pedido. */
  'captured',
  /** El cliente no pagó o la pasarela rechazó. */
  'failed',
  /** Nadie pagó a tiempo. */
  'expired',
  /** Se devolvió el dinero, total o parcialmente. */
  'refunded',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * Orden de avance. Un estado solo acepta lo que está POR ENCIMA de él.
 *
 * Los finales comparten rango: desde `captured` se puede ir a `refunded`, pero
 * `failed` y `expired` no llevan a ninguna parte — un pago fallido que
 * «se recupera» es un pago nuevo, con su propia intención y su propia
 * trazabilidad, no el mismo resucitado.
 */
const RANGO: Record<PaymentState, number> = {
  pending: 0,
  authorized: 1,
  captured: 2,
  refunded: 3,
  // Terminales que cortan el camino. Mismo rango que `captured` a propósito:
  // no se llega a ellos desde un cobro hecho, ni se sale de ellos.
  failed: 2,
  expired: 2,
};

/** Estados desde los que ya no se acepta ningún webhook nuevo. */
const TERMINALES: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'failed',
  'expired',
  'refunded',
]);

export class PaymentTransitionError extends Error {
  constructor(
    readonly from: PaymentState,
    readonly to: PaymentState,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentTransitionError';
  }
}

/**
 * ¿Se puede aplicar este estado sobre el actual?
 *
 * Devuelve una de tres cosas, y las tres significan algo distinto para el que
 * llama:
 *
 * · `apply`  — hay cambio de estado, hay que escribirlo.
 * · `ignore` — el webhook es viejo o repetido. **No es un error**: es lo que
 *   pasa cuando la pasarela reintenta, y responder 4xx haría que siguiera
 *   reintentando para siempre.
 * · `reject` — el salto no tiene sentido en ningún orden (de `failed` a
 *   `captured`). Eso sí merece alarma: o el proveedor se equivocó de pago, o
 *   alguien está probando cosas.
 */
export type PaymentDecision =
  | { kind: 'apply'; to: PaymentState }
  | { kind: 'ignore'; reason: string }
  | { kind: 'reject'; reason: string };

export function decidePaymentTransition(
  from: PaymentState,
  to: PaymentState,
): PaymentDecision {
  if (from === to) {
    return { kind: 'ignore', reason: 'El pago ya está en ese estado.' };
  }

  if (TERMINALES.has(from)) {
    // `refunded` viene DESPUÉS de `captured`, así que un webhook de captura que
    // llega tarde sobre un reembolso ya hecho es ruido, no un ataque.
    if (from === 'refunded' && (to === 'captured' || to === 'authorized')) {
      return {
        kind: 'ignore',
        reason: 'El pago ya fue reembolsado; el aviso llega tarde.',
      };
    }
    return {
      kind: 'reject',
      reason: `Un pago en "${from}" ya no admite cambios.`,
    };
  }

  if (RANGO[to] > RANGO[from]) return { kind: 'apply', to };

  return {
    kind: 'ignore',
    reason: `Aviso de "${to}" recibido con el pago ya en "${from}": llega tarde.`,
  };
}

/**
 * Aplica la transición o lanza.
 *
 * Se separa de `decidePaymentTransition` porque el webhook necesita distinguir
 * «ignorar» de «fallar» —y responder 200 en el primer caso— mientras que quien
 * transiciona a mano (un reembolso desde el panel) quiere que un salto
 * imposible reviente en su cara.
 */
export function applyPaymentTransition(
  from: PaymentState,
  to: PaymentState,
): PaymentState {
  const decision = decidePaymentTransition(from, to);
  if (decision.kind === 'apply') return decision.to;
  throw new PaymentTransitionError(from, to, decision.reason);
}

/** Solo un pago capturado confirma un pedido (RN-PAY-01). */
export function confirmsOrder(state: PaymentState): boolean {
  return state === 'captured';
}

/** ¿Este pago admite todavía que llegue dinero? */
export function isOpen(state: PaymentState): boolean {
  return state === 'pending' || state === 'authorized';
}
