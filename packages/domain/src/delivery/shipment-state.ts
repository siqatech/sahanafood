import {
  StateMachine,
  InvalidTransitionError,
} from '../state-machine/state-machine.js';

/**
 * Máquina de estados del envío (spec 09).
 *
 * Es una máquina APARTE de la del pedido, y conviene decir por qué: un pedido
 * puede estar `dispatched` mientras su envío va por `assigned`, `picked_up` o
 * `failed`, y un reparto fallido **no cancela el pedido** —se reintenta, o se
 * devuelve—. Meter los dos ciclos en una sola máquina obligaría a inventar
 * estados como `dispatched_failed_retrying` y a que cocina entendiera de
 * repartidores.
 *
 * Vive en `@sahana/domain` porque el repartidor marcará entregas desde el móvil
 * con la red de la calle: la app tiene que saber qué transición es válida antes
 * de mandarla, igual que el POS offline con los pedidos.
 */

export const SHIPMENT_STATES = [
  /** Creado, sin repartidor. Lo normal nada más despachar cocina. */
  'pending',
  'assigned',
  'picked_up',
  'delivered',
  /** Intento fallido: el cliente no estaba, la dirección no existe… */
  'failed',
  /** Se devuelve al local tras uno o varios intentos fallidos. */
  'returned',
  'cancelled',
] as const;

export type ShipmentState = (typeof SHIPMENT_STATES)[number];

export const SHIPMENT_EVENTS = [
  'assign',
  /** Reasignar sin pasar por `pending`: el repartidor se puso malo. */
  'reassign',
  'pick_up',
  'deliver',
  'fail',
  /** Nuevo intento tras un fallo (RN-DLV-03). */
  'retry',
  'return',
  'cancel',
] as const;

export type ShipmentEvent = (typeof SHIPMENT_EVENTS)[number];

export const shipmentStateMachine = new StateMachine<
  ShipmentState,
  ShipmentEvent
>({
  initial: 'pending',
  transitions: {
    pending: {
      assign: 'assigned',
      cancel: 'cancelled',
    },
    assigned: {
      // Reasignar sin volver a la cola: el repartidor se puso malo a mitad.
      reassign: 'assigned',
      pick_up: 'picked_up',
      // Se puede fallar ANTES de recoger: el repartidor llega al local y el
      // pedido no está, o se le avería la moto.
      fail: 'failed',
      cancel: 'cancelled',
    },
    picked_up: {
      deliver: 'delivered',
      fail: 'failed',
    },
    // Tras fallar se reintenta —vuelve a la cola sin repartidor— o se devuelve.
    // Un fallo NO es terminal: es la diferencia entre perder la venta y
    // recuperarla (RN-DLV-03).
    failed: {
      retry: 'pending',
      return: 'returned',
    },
  },
  finalStates: ['delivered', 'returned', 'cancelled'],
});

/** Estados desde los que ya no se mueve nada. */
export const SHIPMENT_TERMINAL: readonly ShipmentState[] = [
  'delivered',
  'returned',
  'cancelled',
];

export function isShipmentTerminal(state: ShipmentState): boolean {
  return SHIPMENT_TERMINAL.includes(state);
}

/**
 * Aplica un evento. Lanza `InvalidTransitionError` si no está declarado.
 *
 * Lo importante es lo que NO se puede hacer: entregar sin haber recogido. Sin
 * esa restricción, un toque de más en el móvil marca entregado un pedido que
 * sigue en el mostrador, y con cobro contra entrega eso es dinero que el
 * sistema da por cobrado y que nadie ha cobrado.
 */
export function applyShipmentEvent(
  state: ShipmentState,
  event: ShipmentEvent,
): ShipmentState {
  return shipmentStateMachine.next(state, event);
}

export { InvalidTransitionError };
