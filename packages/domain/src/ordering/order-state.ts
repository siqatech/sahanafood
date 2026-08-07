import {
  StateMachine,
  InvalidTransitionError,
} from '../state-machine/state-machine.js';

/**
 * Máquina de estados del pedido (spec 05 §4 — spec canónica).
 *
 * Vive en `@sahana/domain` y NO en el servidor por una razón concreta: el POS
 * offline transiciona pedidos sin red (acepta, marca en preparación, cobra) y
 * al sincronizar el servidor debe considerar válidas exactamente las mismas
 * transiciones. Dos definiciones separadas divergirían, y el POS acabaría
 * enviando pedidos que el servidor rechaza con la comida ya hecha.
 *
 * El test de simetría (spec 05 §11.5) verifica que ambos importan este mismo
 * módulo.
 */

export const ORDER_STATES = [
  'received',
  'needs_review',
  'scheduled',
  'accepted',
  'preparing',
  'ready',
  'packed',
  'dispatched',
  'delivered',
  'picked_up',
  'rejected',
  'cancelled',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export const ORDER_EVENTS = [
  'mapping_failed',
  'mapping_resolved',
  'schedule',
  'release',
  'accept',
  'reject',
  'start_preparing',
  'finish_preparing',
  'pack',
  'dispatch',
  'deliver',
  'pick_up',
  'cancel',
] as const;

export type OrderEvent = (typeof ORDER_EVENTS)[number];

/**
 * Transiciones declaradas. Lo que NO está aquí es inválido: la máquina falla
 * en vez de permitir un salto silencioso (p. ej. de `received` a `delivered`,
 * que dejaría un pedido facturado sin haber pasado por cocina).
 */
export const orderStateMachine = new StateMachine<OrderState, OrderEvent>({
  initial: 'received',
  transitions: {
    received: {
      mapping_failed: 'needs_review',
      schedule: 'scheduled',
      accept: 'accepted',
      reject: 'rejected',
      cancel: 'cancelled',
    },
    // RN-ORD-10: un pedido con mapeo fallido NUNCA se descarta; espera en la
    // bandeja de excepciones hasta que alguien lo resuelva.
    needs_review: {
      mapping_resolved: 'received',
      reject: 'rejected',
      cancel: 'cancelled',
    },
    // RN-ORD-05: el programado vuelve a `received` en su ventana de preparación.
    scheduled: {
      release: 'received',
      cancel: 'cancelled',
    },
    accepted: {
      start_preparing: 'preparing',
      cancel: 'cancelled',
    },
    // RN-ORD-06: cancelar en preparación exige permiso y motivo; la máquina lo
    // permite y la capa de aplicación exige el permiso.
    preparing: {
      finish_preparing: 'ready',
      cancel: 'cancelled',
    },
    ready: {
      pack: 'packed',
      cancel: 'cancelled',
    },
    packed: {
      dispatch: 'dispatched',
      pick_up: 'picked_up',
      cancel: 'cancelled',
    },
    dispatched: {
      deliver: 'delivered',
    },
  },
  finalStates: ['delivered', 'picked_up', 'rejected', 'cancelled'],
});

/** Estados desde los que el pedido ya no puede cancelarse. */
export function canCancel(state: OrderState): boolean {
  return orderStateMachine.can(state, 'cancel');
}

/**
 * ¿La cancelación desde este estado tiene costo de insumos? (RN-ORD-06)
 * Antes de `preparing` no se consumió nada; desde ahí sí.
 */
export function cancellationHasCost(state: OrderState): boolean {
  return (
    state === 'preparing' ||
    state === 'ready' ||
    state === 'packed' ||
    state === 'dispatched'
  );
}

/**
 * ¿Requiere permiso especial para cancelar? (RN-ORD-06)
 * `orders.cancel_in_progress` a partir de `preparing`.
 */
export function cancellationNeedsElevatedPermission(
  state: OrderState,
): boolean {
  return cancellationHasCost(state);
}

/** ¿El pedido admite modificación? (RN-ORD-07: solo hasta `preparing`) */
export function canModify(state: OrderState): boolean {
  return state === 'received' || state === 'scheduled' || state === 'accepted';
}

/** ¿Está el pedido en un estado terminal? */
export function isFinalState(state: OrderState): boolean {
  return orderStateMachine.isFinal(state);
}

/** Eventos aplicables desde un estado, para que la UI muestre solo lo posible. */
export function allowedEvents(state: OrderState): OrderEvent[] {
  return orderStateMachine.allowedEvents(state);
}

/**
 * Aplica una transición. Lanza `InvalidTransitionError` si no está declarada
 * (la API la traduce a 409 ORDER_INVALID_TRANSITION).
 */
export function transition(state: OrderState, event: OrderEvent): OrderState {
  return orderStateMachine.next(state, event);
}

export { InvalidTransitionError };
