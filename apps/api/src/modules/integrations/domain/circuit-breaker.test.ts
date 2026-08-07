import { describe, it, expect } from 'vitest';
import {
  circuitState,
  circuitAllows,
  afterAttempt,
  DEFAULT_CIRCUIT_POLICY,
  type CircuitSnapshot,
} from './circuit-breaker.js';

/**
 * El cortacircuitos se prueba con un reloj EXPLÍCITO, nunca con esperas reales:
 * una prueba que duerme 30 segundos no se ejecuta en cada commit, y una prueba
 * que no se ejecuta no protege nada.
 */

const T0 = new Date('2026-08-07T12:00:00Z');
const en = (ms: number) => new Date(T0.getTime() + ms);
const cerrado: CircuitSnapshot = {
  consecutiveFailures: 0,
  circuitOpenedAt: null,
};

describe('Cortacircuitos por conector (RN-INT-03)', () => {
  it('arranca cerrado y deja pasar', () => {
    expect(circuitState(cerrado, T0)).toBe('closed');
    expect(circuitAllows(cerrado, T0)).toBe(true);
  });

  it('no se abre antes del umbral: un fallo suelto no corta el canal', () => {
    let estado = cerrado;
    for (let i = 1; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      estado = afterAttempt(estado, 'failure', T0);
      expect(
        circuitState(estado, T0),
        `se abrió con ${i} fallos, antes del umbral de ${DEFAULT_CIRCUIT_POLICY.failureThreshold}`,
      ).toBe('closed');
    }
  });

  it('se abre exactamente al alcanzar el umbral', () => {
    let estado = cerrado;
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      estado = afterAttempt(estado, 'failure', T0);
    }
    expect(circuitState(estado, T0)).toBe('open');
    expect(circuitAllows(estado, T0)).toBe(false);
  });

  it('un éxito por el camino reinicia la cuenta', () => {
    let estado = cerrado;
    estado = afterAttempt(estado, 'failure', T0);
    estado = afterAttempt(estado, 'failure', T0);
    estado = afterAttempt(estado, 'success', T0);
    expect(estado.consecutiveFailures).toBe(0);
    // Y desde cero hacen falta otra vez todos los fallos del umbral.
    for (let i = 1; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      estado = afterAttempt(estado, 'failure', T0);
      expect(circuitState(estado, T0)).toBe('closed');
    }
  });

  it('pasa a half_open al cumplirse el tiempo de espera', () => {
    let estado = cerrado;
    for (let i = 0; i < DEFAULT_CIRCUIT_POLICY.failureThreshold; i++) {
      estado = afterAttempt(estado, 'failure', T0);
    }
    const antes = en(DEFAULT_CIRCUIT_POLICY.openMs - 1);
    const justo = en(DEFAULT_CIRCUIT_POLICY.openMs);

    expect(circuitState(estado, antes)).toBe('open');
    expect(circuitAllows(estado, antes)).toBe(false);
    expect(circuitState(estado, justo)).toBe('half_open');
    // half_open SÍ deja pasar: es la llamada de prueba.
    expect(circuitAllows(estado, justo)).toBe(true);
  });

  it('un éxito en half_open cierra el circuito del todo', () => {
    let estado: CircuitSnapshot = {
      consecutiveFailures: 7,
      circuitOpenedAt: T0,
    };
    const despues = en(DEFAULT_CIRCUIT_POLICY.openMs + 1);
    expect(circuitState(estado, despues)).toBe('half_open');

    estado = afterAttempt(estado, 'success', despues);
    expect(circuitState(estado, despues)).toBe('closed');
    expect(estado.consecutiveFailures).toBe(0);
  });

  it('un fallo en half_open reinicia la espera en vez de martillear', () => {
    const estado: CircuitSnapshot = {
      consecutiveFailures: 5,
      circuitOpenedAt: T0,
    };
    const reintento = en(DEFAULT_CIRCUIT_POLICY.openMs + 1);
    const trasFallo = afterAttempt(estado, 'failure', reintento);

    expect(trasFallo.circuitOpenedAt?.getTime()).toBe(reintento.getTime());
    // Inmediatamente después sigue abierto: no se reintenta en bucle.
    expect(circuitState(trasFallo, reintento)).toBe('open');
    expect(circuitAllows(trasFallo, new Date(reintento.getTime() + 1))).toBe(
      false,
    );
  });

  it('el estado abierto de un conector no dice nada de otro (bulkhead)', () => {
    // El aislamiento es estructural: el estado vive en la fila de CADA conexión
    // y esta función no tiene forma de mirar otra. La prueba fija esa
    // propiedad para que nadie la convierta en un singleton global.
    const rappiCaido: CircuitSnapshot = {
      consecutiveFailures: 9,
      circuitOpenedAt: T0,
    };
    const pedidosYaSano = cerrado;
    expect(circuitAllows(rappiCaido, T0)).toBe(false);
    expect(circuitAllows(pedidosYaSano, T0)).toBe(true);
  });
});
