import { describe, it, expect } from 'vitest';
import {
  ORDER_STATES,
  ORDER_EVENTS,
  orderStateMachine,
  transition,
  canCancel,
  canModify,
  cancellationHasCost,
  cancellationNeedsElevatedPermission,
  isFinalState,
  allowedEvents,
  InvalidTransitionError,
  type OrderState,
  type OrderEvent,
} from './order-state.js';

/**
 * La spec 05 §10 exige probar «toda transición válida/inválida». Escribirlas a
 * mano dejaría huecos, así que se recorre el producto cartesiano completo
 * (12 estados × 13 eventos = 156 combinaciones) y se comprueba que cada una
 * hace exactamente una de dos cosas: transicionar a un destino declarado, o
 * lanzar. No hay tercera opción — un salto silencioso sería un pedido perdido
 * o facturado sin pasar por cocina.
 */

/** Camino feliz de la spec: recepción → entrega a domicilio. */
const CAMINO_DELIVERY: Array<[OrderState, OrderEvent, OrderState]> = [
  ['received', 'accept', 'accepted'],
  ['accepted', 'start_preparing', 'preparing'],
  ['preparing', 'finish_preparing', 'ready'],
  ['ready', 'pack', 'packed'],
  ['packed', 'dispatch', 'dispatched'],
  ['dispatched', 'deliver', 'delivered'],
];

describe('Máquina de estados del pedido — cobertura EXHAUSTIVA', () => {
  it('las 156 combinaciones estado×evento están definidas o lanzan', () => {
    let validas = 0;
    let invalidas = 0;

    for (const state of ORDER_STATES) {
      for (const event of ORDER_EVENTS) {
        if (orderStateMachine.can(state, event)) {
          const destino = transition(state, event);
          expect(
            ORDER_STATES,
            `${state} --${event}--> ${destino} apunta a un estado inexistente`,
          ).toContain(destino);
          validas++;
        } else {
          expect(
            () => transition(state, event),
            `${state} --${event}--> debería lanzar y no lo hizo`,
          ).toThrow(InvalidTransitionError);
          invalidas++;
        }
      }
    }

    expect(validas + invalidas).toBe(ORDER_STATES.length * ORDER_EVENTS.length);
    // Referencia de la spec §4: hay bastantes más inválidas que válidas, que es
    // lo esperable en una máquina restrictiva.
    expect(validas).toBeGreaterThan(0);
    expect(invalidas).toBeGreaterThan(validas);
  });

  it('ningún estado final admite transiciones de salida', () => {
    for (const state of [
      'delivered',
      'picked_up',
      'rejected',
      'cancelled',
    ] as const) {
      expect(isFinalState(state), `${state} debería ser final`).toBe(true);
      expect(allowedEvents(state)).toEqual([]);
    }
  });

  it('todo estado no final tiene al menos una salida (no hay callejones sin salida)', () => {
    for (const state of ORDER_STATES) {
      if (isFinalState(state)) continue;
      expect(
        allowedEvents(state).length,
        `${state} no es final pero no tiene salidas: el pedido quedaría atascado`,
      ).toBeGreaterThan(0);
    }
  });

  it('todo estado es alcanzable desde el inicial', () => {
    // Recorrido en anchura desde `received`. Un estado inalcanzable sería
    // código muerto que aparentaría cubrir un caso de negocio inexistente.
    const alcanzados = new Set<OrderState>([orderStateMachine.initial]);
    const cola: OrderState[] = [orderStateMachine.initial];
    while (cola.length > 0) {
      const actual = cola.shift()!;
      for (const event of allowedEvents(actual)) {
        const destino = transition(actual, event);
        if (!alcanzados.has(destino)) {
          alcanzados.add(destino);
          cola.push(destino);
        }
      }
    }
    for (const state of ORDER_STATES) {
      expect(alcanzados.has(state), `${state} es inalcanzable`).toBe(true);
    }
  });
});

describe('Camino feliz (spec 05 §4)', () => {
  it('recorre recepción → entrega a domicilio', () => {
    let estado: OrderState = orderStateMachine.initial;
    expect(estado).toBe('received');
    for (const [desde, evento, hasta] of CAMINO_DELIVERY) {
      expect(estado).toBe(desde);
      estado = transition(estado, evento);
      expect(estado).toBe(hasta);
    }
    expect(isFinalState(estado)).toBe(true);
  });

  it('recorre el camino de recojo en tienda', () => {
    let estado: OrderState = 'packed';
    estado = transition(estado, 'pick_up');
    expect(estado).toBe('picked_up');
    expect(isFinalState(estado)).toBe(true);
  });
});

describe('Saltos prohibidos que costarían dinero', () => {
  it('NO se puede entregar un pedido que no pasó por cocina', () => {
    expect(() => transition('received', 'deliver')).toThrow(
      InvalidTransitionError,
    );
    expect(() => transition('accepted', 'deliver')).toThrow(
      InvalidTransitionError,
    );
  });

  it('NO se puede empacar antes de terminar la preparación', () => {
    expect(() => transition('preparing', 'pack')).toThrow(
      InvalidTransitionError,
    );
  });

  it('NO se puede reactivar un pedido cancelado o rechazado', () => {
    for (const evento of ORDER_EVENTS) {
      expect(() => transition('cancelled', evento)).toThrow(
        InvalidTransitionError,
      );
      expect(() => transition('rejected', evento)).toThrow(
        InvalidTransitionError,
      );
    }
  });

  it('NO se puede cancelar un pedido ya entregado', () => {
    expect(() => transition('delivered', 'cancel')).toThrow(
      InvalidTransitionError,
    );
    expect(() => transition('picked_up', 'cancel')).toThrow(
      InvalidTransitionError,
    );
  });

  it('NO se puede aceptar dos veces', () => {
    expect(() => transition('accepted', 'accept')).toThrow(
      InvalidTransitionError,
    );
  });

  it('un pedido en reparto ya no se cancela: la comida salió', () => {
    expect(canCancel('dispatched')).toBe(false);
    expect(() => transition('dispatched', 'cancel')).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('Bandeja de excepciones (RN-ORD-10)', () => {
  it('un mapeo fallido NO descarta el pedido: lo aparta', () => {
    const estado = transition('received', 'mapping_failed');
    expect(estado).toBe('needs_review');
    expect(isFinalState(estado)).toBe(false); // sigue vivo
  });

  it('resolver el mapeo lo devuelve al flujo normal', () => {
    let estado = transition('received', 'mapping_failed');
    estado = transition(estado, 'mapping_resolved');
    expect(estado).toBe('received');
    // Y desde ahí sigue el camino habitual.
    expect(transition(estado, 'accept')).toBe('accepted');
  });

  it('un pedido en revisión puede rechazarse si no hay forma de resolverlo', () => {
    expect(transition('needs_review', 'reject')).toBe('rejected');
  });
});

describe('Pedidos programados (RN-ORD-05)', () => {
  it('se aparcan en scheduled y se liberan en su ventana', () => {
    const aparcado = transition('received', 'schedule');
    expect(aparcado).toBe('scheduled');
    expect(transition(aparcado, 'release')).toBe('received');
  });

  it('un programado puede cancelarse antes de liberarse', () => {
    expect(transition('scheduled', 'cancel')).toBe('cancelled');
  });

  it('un programado NO puede aceptarse sin liberarse antes', () => {
    expect(() => transition('scheduled', 'accept')).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('Reglas de cancelación (RN-ORD-06)', () => {
  it('antes de preparar, cancelar no tiene costo ni permiso especial', () => {
    for (const state of ['received', 'scheduled', 'accepted'] as const) {
      expect(canCancel(state)).toBe(true);
      expect(cancellationHasCost(state)).toBe(false);
      expect(cancellationNeedsElevatedPermission(state)).toBe(false);
    }
  });

  it('desde preparing hay costo de insumos y exige permiso elevado', () => {
    for (const state of ['preparing', 'ready', 'packed'] as const) {
      expect(cancellationHasCost(state)).toBe(true);
      expect(cancellationNeedsElevatedPermission(state)).toBe(true);
    }
  });

  it('needs_review puede cancelarse sin costo', () => {
    expect(canCancel('needs_review')).toBe(true);
    expect(cancellationHasCost('needs_review')).toBe(false);
  });
});

describe('Reglas de modificación (RN-ORD-07)', () => {
  it('solo se modifica hasta accepted', () => {
    expect(canModify('received')).toBe(true);
    expect(canModify('scheduled')).toBe(true);
    expect(canModify('accepted')).toBe(true);
  });

  it('una vez en cocina ya no se modifica', () => {
    for (const state of [
      'preparing',
      'ready',
      'packed',
      'dispatched',
    ] as const) {
      expect(canModify(state), `${state} no debería admitir modificación`).toBe(
        false,
      );
    }
  });

  it('un pedido terminado no se modifica', () => {
    for (const state of [
      'delivered',
      'picked_up',
      'cancelled',
      'rejected',
    ] as const) {
      expect(canModify(state)).toBe(false);
    }
  });
});

describe('Errores', () => {
  it('InvalidTransitionError informa origen y evento para diagnosticar', () => {
    try {
      transition('delivered', 'cancel');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const error = e as InvalidTransitionError<OrderState, OrderEvent>;
      expect(error.from).toBe('delivered');
      expect(error.event).toBe('cancel');
      expect(error.message).toContain('delivered');
      expect(error.message).toContain('cancel');
    }
  });
});

describe('Deshacer del KDS: ready → preparing', () => {
  it('vuelve a preparación, que es el inverso exacto de terminar', () => {
    // Un cocinero toca la tarjeta con el codo. Sin este camino, la única
    // salida era llamar al encargado en mitad del servicio.
    expect(transition('ready', 'resume_preparing')).toBe('preparing');
  });

  it('NO se puede deshacer un pedido ya empacado ni despachado', () => {
    // A partir de ahí el pedido salió de la cocina: retroceder sería
    // reescribir lo que otra persona hizo después.
    for (const estado of ['packed', 'dispatched', 'delivered'] as const) {
      expect(() => transition(estado, 'resume_preparing')).toThrow();
    }
  });

  it('deshacer y volver a terminar deja el pedido donde estaba', () => {
    // La propiedad que hace que esto sea seguro: no abre un ciclo raro, es
    // ida y vuelta por el mismo camino.
    const ida = transition('ready', 'resume_preparing');
    expect(transition(ida, 'finish_preparing')).toBe('ready');
  });
});
