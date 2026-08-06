import { describe, it, expect } from 'vitest';
import { StateMachine, InvalidTransitionError } from './state-machine.js';

// Ejemplo mínimo tipo pedido para ejercitar la base (el orquestador real llega en F4).
type S =
  'pending' | 'accepted' | 'preparing' | 'ready' | 'delivered' | 'cancelled';
type E = 'accept' | 'start' | 'finish' | 'deliver' | 'cancel';

const sm = new StateMachine<S, E>({
  initial: 'pending',
  transitions: {
    pending: { accept: 'accepted', cancel: 'cancelled' },
    accepted: { start: 'preparing', cancel: 'cancelled' },
    preparing: { finish: 'ready' },
    ready: { deliver: 'delivered' },
  },
  finalStates: ['delivered', 'cancelled'],
});

describe('StateMachine', () => {
  it('expone el estado inicial', () => {
    expect(sm.initial).toBe('pending');
  });

  it('can indica transiciones válidas', () => {
    expect(sm.can('pending', 'accept')).toBe(true);
    expect(sm.can('pending', 'deliver')).toBe(false);
    expect(sm.can('delivered', 'cancel')).toBe(false);
  });

  it('next devuelve el destino', () => {
    expect(sm.next('pending', 'accept')).toBe('accepted');
    expect(sm.next('accepted', 'start')).toBe('preparing');
  });

  it('next lanza en transición inválida', () => {
    expect(() => sm.next('pending', 'deliver')).toThrow(InvalidTransitionError);
    try {
      sm.next('ready', 'accept');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError<S, E>).from).toBe('ready');
      expect((e as InvalidTransitionError<S, E>).event).toBe('accept');
    }
  });

  it('isFinal reconoce estados terminales', () => {
    expect(sm.isFinal('delivered')).toBe(true);
    expect(sm.isFinal('cancelled')).toBe(true);
    expect(sm.isFinal('pending')).toBe(false);
  });

  it('isFinal es true para estado sin transiciones aunque no esté declarado', () => {
    const bare = new StateMachine<'a' | 'b', 'go'>({
      initial: 'a',
      transitions: { a: { go: 'b' } },
    });
    expect(bare.isFinal('b')).toBe(true);
  });

  it('allowedEvents lista los eventos aplicables', () => {
    expect(sm.allowedEvents('pending').sort()).toEqual(['accept', 'cancel']);
    expect(sm.allowedEvents('delivered')).toEqual([]);
  });
});
