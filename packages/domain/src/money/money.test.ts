import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money, MoneyError, MINOR_SCALE, sumMoney } from './money.js';

describe('Money — construcción', () => {
  it('fromMinor guarda unidades menores enteras', () => {
    expect(Money.fromMinor(125000).minorUnits).toBe(125000);
    expect(Money.fromMinor(125000).currency).toBe('PEN');
  });

  it('parse acepta enteros y hasta 4 decimales', () => {
    expect(Money.parse('12.50').minorUnits).toBe(125000);
    expect(Money.parse('12').minorUnits).toBe(120000);
    expect(Money.parse('0.0001').minorUnits).toBe(1);
    expect(Money.parse('-3.1234').minorUnits).toBe(-31234);
    expect(Money.parse('  7.5  ').minorUnits).toBe(75000);
  });

  it('parse rechaza formato inválido y exceso de decimales', () => {
    expect(() => Money.parse('12.505050')).toThrow(MoneyError);
    expect(() => Money.parse('abc')).toThrow(MoneyError);
    expect(() => Money.parse('1.2.3')).toThrow(MoneyError);
    expect(() => Money.parse('')).toThrow(MoneyError);
  });

  it('rechaza minorUnits no entero', () => {
    expect(() => Money.fromMinor(1.5)).toThrow(MoneyError);
  });

  it('rechaza moneda no soportada', () => {
    // @ts-expect-error probando validación en runtime
    expect(() => Money.fromMinor(100, 'EUR')).toThrow(MoneyError);
  });

  it('rechaza desbordamiento (entero no seguro)', () => {
    expect(() => Money.fromMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      MoneyError,
    );
  });

  it('zero devuelve 0 en la moneda dada', () => {
    expect(Money.zero('USD').isZero()).toBe(true);
    expect(Money.zero('USD').currency).toBe('USD');
  });

  it('es inmutable (congelado)', () => {
    const m = Money.fromMinor(100);
    expect(Object.isFrozen(m)).toBe(true);
  });
});

describe('Money — aritmética', () => {
  it('suma y resta', () => {
    const a = Money.parse('10.00');
    const b = Money.parse('2.50');
    expect(a.add(b).toDecimalString()).toBe('12.5000');
    expect(a.subtract(b).toDecimalString()).toBe('7.5000');
  });

  it('rechaza operar monedas distintas', () => {
    const pen = Money.parse('10', 'PEN');
    const usd = Money.parse('10', 'USD');
    expect(() => pen.add(usd)).toThrow(MoneyError);
    expect(() => pen.subtract(usd)).toThrow(MoneyError);
    expect(() => pen.compareTo(usd)).toThrow(MoneyError);
  });

  it('multiplyByQuantity con enteros', () => {
    expect(Money.parse('3.50').multiplyByQuantity(4).toDecimalString()).toBe(
      '14.0000',
    );
    expect(Money.parse('3.50').multiplyByQuantity(0).isZero()).toBe(true);
    expect(() => Money.parse('3.50').multiplyByQuantity(1.5)).toThrow(
      MoneyError,
    );
  });

  it('multiplyByRatio aplica porcentaje con half-up', () => {
    // 15% de 10.00 = 1.50
    expect(
      Money.parse('10.00').multiplyByRatio(15, 100).toDecimalString(),
    ).toBe('1.5000');
    // 1/3 de 0.0001 = 0.00003 -> half-up en escala 4 = 0.0000
    expect(Money.parse('0.0001').multiplyByRatio(1, 3).minorUnits).toBe(0);
    // 2/3 de 0.0001 = 0.0000666 -> half-up escala 4 = 0.0001
    expect(Money.parse('0.0001').multiplyByRatio(2, 3).minorUnits).toBe(1);
  });

  it('multiplyByRatio rechaza no-enteros', () => {
    expect(() => Money.parse('10').multiplyByRatio(1.5, 100)).toThrow(
      MoneyError,
    );
    expect(() => Money.parse('10').multiplyByRatio(1, 0)).toThrow(MoneyError);
  });

  it('negate y abs', () => {
    expect(Money.parse('5').negate().toDecimalString()).toBe('-5.0000');
    expect(Money.parse('-5').abs().toDecimalString()).toBe('5.0000');
    expect(Money.parse('5').abs().toDecimalString()).toBe('5.0000');
  });
});

describe('Money — redondeo half-up (RN-T04)', () => {
  it('redondea a céntimos con ties away from zero', () => {
    expect(Money.parse('1.2350').roundToCents().toDecimalString()).toBe(
      '1.2400',
    );
    expect(Money.parse('1.2250').roundToCents().toDecimalString()).toBe(
      '1.2300',
    );
    expect(Money.parse('1.2349').roundToCents().toDecimalString()).toBe(
      '1.2300',
    );
    // Negativos: away from zero
    expect(Money.parse('-1.2350').roundToCents().toDecimalString()).toBe(
      '-1.2400',
    );
  });

  it('roundTo(4) es identidad (misma escala interna)', () => {
    const m = Money.parse('1.2345');
    expect(m.roundTo(4)).toBe(m);
  });

  it('roundTo(0) redondea a unidades', () => {
    expect(Money.parse('2.5').roundTo(0).toDecimalString()).toBe('3.0000');
    expect(Money.parse('2.4999').roundTo(0).toDecimalString()).toBe('2.0000');
  });

  it('rechaza decimales fuera de rango', () => {
    expect(() => Money.parse('1').roundTo(-1)).toThrow(MoneyError);
    expect(() => Money.parse('1').roundTo(5)).toThrow(MoneyError);
    expect(() => Money.parse('1').roundTo(2.5)).toThrow(MoneyError);
  });
});

describe('Money — allocate (reparto sin pérdida)', () => {
  it('reparte céntimos sin perder ni inventar', () => {
    const parts = Money.parse('10.00').allocate(3);
    expect(parts).toHaveLength(3);
    expect(sumMoney(parts).equals(Money.parse('10.00'))).toBe(true);
    // El resto va a la primera porción
    expect(parts[0]!.minorUnits).toBeGreaterThanOrEqual(parts[2]!.minorUnits);
  });

  it('reparte montos negativos conservando el total', () => {
    const parts = Money.parse('-0.0005').allocate(2);
    expect(sumMoney(parts).minorUnits).toBe(-5);
  });

  it('rechaza porciones no positivas', () => {
    expect(() => Money.parse('10').allocate(0)).toThrow(MoneyError);
    expect(() => Money.parse('10').allocate(-1)).toThrow(MoneyError);
    expect(() => Money.parse('10').allocate(1.5)).toThrow(MoneyError);
  });
});

describe('Money — comparación', () => {
  const a = Money.parse('5');
  const b = Money.parse('10');
  it('compareTo / greater / less', () => {
    expect(a.compareTo(b)).toBe(-1);
    expect(b.compareTo(a)).toBe(1);
    expect(a.compareTo(Money.parse('5'))).toBe(0);
    expect(b.greaterThan(a)).toBe(true);
    expect(a.lessThan(b)).toBe(true);
    expect(b.greaterThanOrEqual(b)).toBe(true);
    expect(a.greaterThanOrEqual(b)).toBe(false);
  });
  it('equals compara monto y moneda', () => {
    expect(a.equals(Money.parse('5'))).toBe(true);
    expect(a.equals(Money.parse('5', 'USD'))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });
  it('predicados de signo', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.parse('-1').isNegative()).toBe(true);
    expect(Money.parse('1').isPositive()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
    expect(Money.zero().isNegative()).toBe(false);
  });
});

describe('Money — serialización', () => {
  it('toCents redondea a 2 decimales', () => {
    expect(Money.parse('12.3450').toCents()).toBe(1235);
    expect(Money.parse('12.3449').toCents()).toBe(1234);
    expect(Money.parse('-12.3450').toCents()).toBe(-1235);
  });
  it('toDecimalString da 4 decimales', () => {
    expect(Money.parse('12.5').toDecimalString()).toBe('12.5000');
    expect(Money.parse('-0.0001').toDecimalString()).toBe('-0.0001');
  });
  it('toJSON expone minorUnits, moneda y escala', () => {
    expect(Money.parse('12.50', 'USD').toJSON()).toEqual({
      minorUnits: 125000,
      currency: 'USD',
      scale: MINOR_SCALE,
    });
  });
  it('toString es legible', () => {
    expect(Money.parse('12.5').toString()).toBe('PEN 12.5000');
  });
});

describe('sumMoney', () => {
  it('suma una lista', () => {
    expect(
      sumMoney([
        Money.parse('1'),
        Money.parse('2'),
        Money.parse('3'),
      ]).toDecimalString(),
    ).toBe('6.0000');
  });
  it('lista vacía es error (moneda ambigua)', () => {
    expect(() => sumMoney([])).toThrow(MoneyError);
  });
});

describe('Money — propiedades (fast-check)', () => {
  const minor = () => fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

  it('suma conmutativa', () => {
    fc.assert(
      fc.property(minor(), minor(), (x, y) => {
        const a = Money.fromMinor(x);
        const b = Money.fromMinor(y);
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
    );
  });

  it('a + b - b === a (sin pérdida)', () => {
    fc.assert(
      fc.property(minor(), minor(), (x, y) => {
        const a = Money.fromMinor(x);
        const b = Money.fromMinor(y);
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
    );
  });

  it('allocate nunca pierde ni inventa céntimos', () => {
    fc.assert(
      fc.property(minor(), fc.integer({ min: 1, max: 50 }), (x, parts) => {
        const total = Money.fromMinor(x);
        const pieces = total.allocate(parts);
        expect(pieces).toHaveLength(parts);
        expect(sumMoney(pieces).equals(total)).toBe(true);
      }),
    );
  });

  it('redondear a céntimos difiere del original en < 1 céntimo', () => {
    fc.assert(
      fc.property(minor(), (x) => {
        const m = Money.fromMinor(x);
        const diff = Math.abs(m.subtract(m.roundToCents()).minorUnits);
        expect(diff).toBeLessThan(100);
      }),
    );
  });

  it('multiplyByQuantity equivale a suma repetida', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 20 }),
        (x, q) => {
          const m = Money.fromMinor(x);
          let acc = Money.zero();
          for (let i = 0; i < q; i++) acc = acc.add(m);
          expect(m.multiplyByQuantity(q).equals(acc)).toBe(true);
        },
      ),
    );
  });
});
