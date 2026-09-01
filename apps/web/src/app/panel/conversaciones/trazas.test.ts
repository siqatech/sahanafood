import { describe, it, expect } from 'vitest';
import type { TrazaDeAgente } from '../../../lib/panel-api';
import {
  leerResolucion,
  herramientas,
  veredicto,
  resumirTrazas,
} from './trazas';

function traza(parcial: Partial<TrazaDeAgente> = {}): TrazaDeAgente {
  return {
    inbound: '¿a qué hora cierran?',
    outbound: 'Hasta las 11 pm.',
    resolution: 'rule',
    ruleId: null,
    ruleName: null,
    toolsCalled: [],
    validator: null,
    sources: 0,
    promptVersion: null,
    latencyMs: 12,
    credits: 0,
    at: '2026-08-30T18:00:00.000Z',
    ...parcial,
  };
}

describe('leerResolucion', () => {
  it('distingue la regla del modelo, que es la distinción que importa', () => {
    expect(leerResolucion('rule').rotulo).toBe('Regla tuya');
    expect(leerResolucion('llm').rotulo).toBe('Redactó el asistente');
    expect(leerResolucion('rule').rotulo).not.toBe(
      leerResolucion('llm').rotulo,
    );
  });

  it('marca para revisar lo bloqueado y lo degradado, y solo eso', () => {
    expect(leerResolucion('blocked').tono).toBe('revision');
    expect(leerResolucion('degraded').tono).toBe('revision');
    expect(leerResolucion('rule').tono).toBe('normal');
    expect(leerResolucion('llm').tono).toBe('normal');
    // Derivar a una persona es el comportamiento CORRECTO ante un reclamo
    // (RN-AIA-03), no una incidencia: pintarlo en rojo enseñaría a ignorarlo.
    expect(leerResolucion('handoff').tono).toBe('normal');
  });

  it('una resolución que no conoce se marca para revisar, no se da por buena', () => {
    const l = leerResolucion('inventada');
    expect(l.rotulo).toBe('inventada');
    expect(l.tono).toBe('revision');
  });

  it('escribe la explicación sin jerga de modelos', () => {
    for (const r of ['rule', 'llm', 'blocked', 'handoff', 'degraded']) {
      const texto = leerResolucion(r).explicacion.toLowerCase();
      expect(texto).not.toMatch(/\bllm\b|\bprompt\b|\btoken/);
      expect(texto.length).toBeGreaterThan(20);
    }
  });
});

describe('herramientas', () => {
  it('devuelve los nombres llamados', () => {
    expect(herramientas(['catalogo.buscar', 'stock.consultar'])).toEqual([
      'catalogo.buscar',
      'stock.consultar',
    ]);
  });

  it('aguanta una traza vieja con otra forma sin romper la pantalla', () => {
    expect(herramientas(null)).toEqual([]);
    expect(herramientas({ tool: 'x' })).toEqual([]);
    expect(herramientas('catalogo.buscar')).toEqual([]);
    expect(herramientas([{ name: 'x' }, 'stock.consultar', ''])).toEqual([
      'stock.consultar',
    ]);
  });
});

describe('veredicto', () => {
  it('lee el visto bueno y el motivo del frenazo', () => {
    expect(veredicto({ ok: true })).toEqual({ ok: true, motivo: null });
    expect(veredicto({ ok: false, reason: 'precio no respaldado' })).toEqual({
      ok: false,
      motivo: 'precio no respaldado',
    });
  });

  it('devuelve null cuando el validador no llegó a correr', () => {
    expect(veredicto(null)).toBeNull();
    expect(veredicto(undefined)).toBeNull();
    // Sin `ok` no hay veredicto: inventarle uno sería afirmar que algo se
    // validó cuando la traza no lo dice.
    expect(veredicto({ reason: 'algo' })).toBeNull();
  });
});

describe('resumirTrazas', () => {
  it('cuenta turnos, reglas, revisiones y créditos', () => {
    const r = resumirTrazas([
      traza({ resolution: 'rule' }),
      traza({ resolution: 'rule' }),
      traza({ resolution: 'llm', credits: 3 }),
      traza({ resolution: 'blocked', credits: 2 }),
    ]);
    expect(r).toEqual({ turnos: 4, porRegla: 2, aRevisar: 1, creditos: 5 });
  });

  it('una conversación sin trazas no rompe la división', () => {
    expect(resumirTrazas([])).toEqual({
      turnos: 0,
      porRegla: 0,
      aRevisar: 0,
      creditos: 0,
    });
  });
});
