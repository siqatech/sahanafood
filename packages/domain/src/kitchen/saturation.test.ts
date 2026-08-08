import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateSaturation,
  suggestPauseOrder,
  assertValidPolicy,
  SaturationError,
  type SaturationPolicy,
} from './saturation.js';

const politica = (over: Partial<SaturationPolicy> = {}): SaturationPolicy => ({
  maxConcurrentItems: 20,
  extendMinutes: 15,
  pauseThresholdItems: 35,
  channelPauseOrder: ['rappi', 'pedidosya', 'web'],
  ...over,
});

describe('Saturación de cocina (RN-KIT-04, T5.18)', () => {
  it('dentro de capacidad no hace nada', () => {
    const d = evaluateSaturation({ activeItems: 20 }, politica());
    expect(d.level).toBe('normal');
    expect(d.extendPromiseMinutes).toBe(0);
    expect(d.channelsToPause).toEqual([]);
  });

  it('el umbral es ESTRICTO: 20 no satura, 21 sí', () => {
    // «> max_concurrent», no «>=». Un umbral de 20 significa que 20 caben.
    expect(evaluateSaturation({ activeItems: 20 }, politica()).level).toBe(
      'normal',
    );
    expect(evaluateSaturation({ activeItems: 21 }, politica()).level).toBe(
      'saturated',
    );
  });

  it('SATURADA extiende la promesa pero SIGUE VENDIENDO', () => {
    // Es la mitad que más importa: un cliente al que le dicen 55 min no se va;
    // uno al que le prometen 35 y llega en 55, sí.
    const d = evaluateSaturation({ activeItems: 25 }, politica());
    expect(d.level).toBe('saturated');
    expect(d.extendPromiseMinutes).toBe(15);
    expect(d.channelsToPause).toEqual([]);
    expect(d.reason).toContain('15 min más');
  });

  it('CRÍTICA pausa canales, en el orden declarado', () => {
    const d = evaluateSaturation({ activeItems: 40 }, politica());
    expect(d.level).toBe('critical');
    // Menor margen primero: el orden es el de la política, no el alfabético.
    expect(d.channelsToPause).toEqual(['rappi', 'pedidosya', 'web']);
    // Y sigue extendiendo: cerrar canales no arregla lo que ya está dentro.
    expect(d.extendPromiseMinutes).toBe(15);
  });

  it('sin umbral de pausa NUNCA se cierra un canal solo', () => {
    // La configuración de quien prefiere decidirlo a mano.
    const d = evaluateSaturation(
      { activeItems: 500 },
      politica({ pauseThresholdItems: null }),
    );
    expect(d.level).toBe('saturated');
    expect(d.channelsToPause).toEqual([]);
  });

  it('rechaza una política que se saltaría el aviso', () => {
    // Umbral de pausa por debajo del de saturación: la cocina pasaría de
    // normal a cerrar canales sin avisar por el camino.
    expect(() =>
      assertValidPolicy(
        politica({ maxConcurrentItems: 30, pauseThresholdItems: 20 }),
      ),
    ).toThrow(SaturationError);
  });

  it('rechaza declararse saturado sin hacer nada', () => {
    // Extender 0 minutos pone el KDS en rojo sin cambiar ninguna promesa.
    expect(() => assertValidPolicy(politica({ extendMinutes: 0 }))).toThrow(
      SaturationError,
    );
  });

  it('rechaza pausar sin decir en qué orden', () => {
    expect(() =>
      assertValidPolicy(politica({ channelPauseOrder: [] })),
    ).toThrow(SaturationError);
  });

  it('la sugerencia ordena por comisión: más caro, se cierra antes', () => {
    const orden = suggestPauseOrder([
      { channel: 'web', commissionBps: 0 },
      { channel: 'rappi', commissionBps: 2800 },
      { channel: 'pedidosya', commissionBps: 2200 },
      { channel: 'pos', commissionBps: 0 },
    ]);
    expect(orden).toEqual(['rappi', 'pedidosya', 'pos', 'web']);
  });

  it('PROPIEDAD: la decisión es estable y monótona en la carga', () => {
    // Más carga nunca puede relajar la decisión. Sin esto, un pico podría
    // hacer que la cocina se declarase MENOS saturada que un segundo antes.
    const orden = { normal: 0, saturated: 1, critical: 2 } as const;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (a, b) => {
          const menor = Math.min(a, b);
          const mayor = Math.max(a, b);
          const d1 = evaluateSaturation({ activeItems: menor }, politica());
          const d2 = evaluateSaturation({ activeItems: mayor }, politica());
          expect(orden[d2.level]).toBeGreaterThanOrEqual(orden[d1.level]);

          // Y es pura: dos llamadas iguales dan lo mismo.
          const otraVez = evaluateSaturation(
            { activeItems: menor },
            politica(),
          );
          expect(otraVez).toEqual(d1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
