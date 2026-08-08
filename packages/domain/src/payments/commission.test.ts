import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money } from '../money/money.js';
import {
  estimateCommission,
  compareCommission,
  assertValidTariff,
  CommissionError,
  type CommissionTariff,
} from './commission.js';

const soles = (d: string): Money => Money.parse(d);
/** Rappi-ish: 25 % + S/ 0,50 por transacción. */
const TARIFA: CommissionTariff = { percentBps: 2500, fixedMinor: 5000 };

describe('Comisión estimada del canal', () => {
  it('porcentaje más fijo', () => {
    // 25 % de 40 = 10, más 0,50 = 10,50.
    expect(estimateCommission(soles('40.00'), TARIFA).toDecimalString()).toBe(
      '10.5000',
    );
  });

  it('un porcentaje sin fijo es solo el porcentaje', () => {
    expect(
      estimateCommission(soles('100.00'), {
        percentBps: 350,
        fixedMinor: 0,
      }).toDecimalString(),
    ).toBe('3.5000');
  });

  it('respeta el mínimo por transacción', () => {
    // 3,5 % de 10 = 0,35, por debajo del mínimo de 1,00.
    const v = estimateCommission(soles('10.00'), {
      percentBps: 350,
      fixedMinor: 0,
      minimumMinor: 10_000,
    });
    expect(v.toDecimalString()).toBe('1.0000');
  });

  it('REDONDEA UNA SOLA VEZ, al final', () => {
    // 3,33 % de 10,07 = 0,335331; redondear eso antes de sumar el fijo daría
    // un céntimo distinto. Multiplicado por el volumen de un mes, es el
    // descuadre que hace desconfiar de un informe entero.
    const v = estimateCommission(soles('10.07'), {
      percentBps: 333,
      fixedMinor: 1,
    });
    // 100700 * 333 / 10000 = 3353,31 → 3353 (half-up), + 1 = 3354.
    expect(v.minorUnits).toBe(3354);
  });

  it('NUNCA supera el importe cobrado', () => {
    // Un pedido de S/ 2 con S/ 1,50 fijo y 25 % dejaría al local pagando por
    // vender. Se topa, y la diferencia se discute en la liquidación.
    const v = estimateCommission(soles('2.00'), {
      percentBps: 2500,
      fixedMinor: 15_000,
    });
    expect(v.toDecimalString()).toBe('2.0000');
  });

  it('un importe de cero da comisión cero', () => {
    expect(estimateCommission(Money.zero(), TARIFA).minorUnits).toBe(0);
  });

  it('rechaza una comisión mayor que el 100 %', () => {
    // Casi siempre es un dedo de más al teclear, y aceptarla produce márgenes
    // negativos que alguien leerá como que el negocio va mal.
    expect(() =>
      assertValidTariff({ percentBps: 12_000, fixedMinor: 0 }),
    ).toThrow(CommissionError);
  });

  it('rechaza porcentajes no enteros o negativos', () => {
    expect(() => assertValidTariff({ percentBps: 3.5, fixedMinor: 0 })).toThrow(
      CommissionError,
    );
    expect(() =>
      assertValidTariff({ percentBps: -100, fixedMinor: 0 }),
    ).toThrow(CommissionError);
  });

  it('PROPIEDAD: la comisión nunca es negativa ni mayor que el importe', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        (importeMinor, bps, fijo) => {
          const importe = Money.fromMinor(importeMinor);
          const c = estimateCommission(importe, {
            percentBps: bps,
            fixedMinor: fijo,
          });
          expect(c.minorUnits).toBeGreaterThanOrEqual(0);
          expect(c.minorUnits).toBeLessThanOrEqual(importeMinor);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('Comparación estimado vs liquidado (RN-BIL-04)', () => {
  it('sin diferencia no hay nada que mirar', () => {
    const v = compareCommission(soles('10.50'), soles('10.50'));
    expect(v.difference).toBe('0.0000');
    expect(v.significant).toBe(false);
  });

  it('la pasarela cobró de MÁS: diferencia positiva', () => {
    const v = compareCommission(soles('10.00'), soles('12.00'));
    expect(v.difference).toBe('2.0000');
    expect(v.differenceBps).toBe(2000);
    expect(v.significant).toBe(true);
  });

  it('cobró de menos: diferencia negativa, y también interesa', () => {
    // Suele significar que el tarifario está desactualizado, y eso afecta a
    // todas las estimaciones futuras.
    const v = compareCommission(soles('10.00'), soles('9.00'));
    expect(v.difference).toBe('-1.0000');
    expect(v.differenceBps).toBe(-1000);
    expect(v.significant).toBe(true);
  });

  it('LA TOLERANCIA ES RELATIVA, no en soles', () => {
    // Un céntimo sobre S/ 0,50 es un 2 % y merece mirada; el mismo céntimo
    // sobre S/ 5 000 es ruido. Una tolerancia en soles trataría los dos igual y
    // acabaría enseñando cien alertas al día — la forma más segura de que no se
    // lea ninguna.
    const pequena = compareCommission(soles('0.50'), soles('0.51'));
    const grande = compareCommission(soles('5000.00'), soles('5000.01'));
    expect(pequena.significant).toBe(true);
    expect(grande.significant).toBe(false);
  });

  it('sin estimación previa, cualquier cobro es significativo', () => {
    // Es el caso del tarifario sin configurar, y es justo el que hay que ver:
    // se está pagando comisión que nadie previó.
    const v = compareCommission(Money.zero(), soles('7.00'));
    expect(v.significant).toBe(true);
  });

  it('no compara monedas distintas', () => {
    expect(() =>
      compareCommission(
        Money.parse('10.00', 'PEN'),
        Money.parse('10.00', 'USD'),
      ),
    ).toThrow(CommissionError);
  });

  it('PROPIEDAD: la diferencia siempre es liquidado menos estimado', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (est, liq) => {
          const v = compareCommission(
            Money.fromMinor(est),
            Money.fromMinor(liq),
          );
          expect(v.difference).toBe(
            Money.fromMinor(liq - est).toDecimalString(),
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});
