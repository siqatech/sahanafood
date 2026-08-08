import { describe, it, expect } from 'vitest';
import {
  applyShipmentEvent,
  isShipmentTerminal,
  shipmentStateMachine,
  InvalidTransitionError,
  SHIPMENT_STATES,
  type ShipmentState,
} from './shipment-state.js';

describe('Máquina de estados del envío (spec 09, T5.15)', () => {
  it('el camino feliz llega a entregado', () => {
    let s: ShipmentState = 'pending';
    s = applyShipmentEvent(s, 'assign');
    s = applyShipmentEvent(s, 'pick_up');
    s = applyShipmentEvent(s, 'deliver');
    expect(s).toBe('delivered');
    expect(isShipmentTerminal(s)).toBe(true);
  });

  it('NO SE PUEDE ENTREGAR SIN HABER RECOGIDO', () => {
    // Con cobro contra entrega, un toque de más marcaría cobrado un pedido que
    // sigue en el mostrador: dinero que el sistema da por recibido y que nadie
    // tiene.
    expect(() => applyShipmentEvent('assigned', 'deliver')).toThrow(
      InvalidTransitionError,
    );
    expect(() => applyShipmentEvent('pending', 'deliver')).toThrow(
      InvalidTransitionError,
    );
  });

  it('un fallo NO es terminal: se reintenta o se devuelve (RN-DLV-03)', () => {
    expect(applyShipmentEvent('failed', 'retry')).toBe('pending');
    expect(applyShipmentEvent('failed', 'return')).toBe('returned');
    expect(isShipmentTerminal('failed')).toBe(false);
    expect(isShipmentTerminal('returned')).toBe(true);
  });

  it('se puede fallar antes de recoger', () => {
    // El repartidor llega al local y el pedido no está, o se avería la moto.
    expect(applyShipmentEvent('assigned', 'fail')).toBe('failed');
  });

  it('se reasigna sin volver a la cola', () => {
    expect(applyShipmentEvent('assigned', 'reassign')).toBe('assigned');
  });

  it('un envío entregado ya no se mueve', () => {
    for (const evento of ['assign', 'pick_up', 'deliver', 'fail', 'cancel'] as const) {
      expect(() => applyShipmentEvent('delivered', evento)).toThrow(
        InvalidTransitionError,
      );
    }
  });

  it('cancelar solo antes de recoger', () => {
    expect(applyShipmentEvent('pending', 'cancel')).toBe('cancelled');
    expect(applyShipmentEvent('assigned', 'cancel')).toBe('cancelled');
    // Ya recogido, el pedido va en la moto: se falla y se devuelve, no se
    // «cancela», porque la comida existe y hay que decidir qué se hace con ella.
    expect(() => applyShipmentEvent('picked_up', 'cancel')).toThrow(
      InvalidTransitionError,
    );
  });

  it('todo estado es alcanzable desde el inicial', () => {
    // Un estado declarado y no alcanzable es una rama muerta que alguien
    // acabará intentando usar.
    const vistos = new Set<ShipmentState>(['pending']);
    const cola: ShipmentState[] = ['pending'];
    while (cola.length > 0) {
      const actual = cola.shift()!;
      for (const evento of shipmentStateMachine.allowedEvents(actual)) {
        const siguiente = shipmentStateMachine.next(actual, evento);
        if (!vistos.has(siguiente)) {
          vistos.add(siguiente);
          cola.push(siguiente);
        }
      }
    }
    expect([...vistos].sort()).toEqual([...SHIPMENT_STATES].sort());
  });
});
