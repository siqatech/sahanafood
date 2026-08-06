import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money, MoneyError } from './money.js';
import { extractInclusiveTax, addExclusiveTax, IGV_PERU_BPS } from './tax.js';

describe('IGV — desglose hacia atrás (RN-T05)', () => {
  it('desglosa 118.00 en 100.00 + 18.00', () => {
    const b = extractInclusiveTax(Money.parse('118.00'));
    expect(b.net.toDecimalString()).toBe('100.0000');
    expect(b.tax.toDecimalString()).toBe('18.0000');
    expect(b.gross.toDecimalString()).toBe('118.0000');
    expect(b.rateBps).toBe(IGV_PERU_BPS);
  });

  it('neto + impuesto === bruto siempre (sin céntimos perdidos)', () => {
    const b = extractInclusiveTax(Money.parse('35.90'));
    expect(b.net.add(b.tax).equals(b.gross)).toBe(true);
  });

  it('acepta tasa personalizada', () => {
    const b = extractInclusiveTax(Money.parse('110.00'), 1000); // 10%
    expect(b.net.toDecimalString()).toBe('100.0000');
    expect(b.tax.toDecimalString()).toBe('10.0000');
  });

  it('rechaza tasa inválida', () => {
    expect(() => extractInclusiveTax(Money.parse('100'), -1)).toThrow(
      MoneyError,
    );
    expect(() => extractInclusiveTax(Money.parse('100'), 1.5)).toThrow(
      MoneyError,
    );
  });
});

describe('IGV — camino hacia adelante', () => {
  it('agrega 18% a un neto', () => {
    const b = addExclusiveTax(Money.parse('100.00'));
    expect(b.tax.toDecimalString()).toBe('18.0000');
    expect(b.gross.toDecimalString()).toBe('118.0000');
    expect(b.net.add(b.tax).equals(b.gross)).toBe(true);
  });

  it('rechaza tasa inválida', () => {
    expect(() => addExclusiveTax(Money.parse('100'), -5)).toThrow(MoneyError);
    expect(() => addExclusiveTax(Money.parse('100'), 2.2)).toThrow(MoneyError);
  });
});

describe('IGV — propiedades (fast-check)', () => {
  it('el desglose inclusivo siempre reconstituye el bruto', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000_000 }), (cents) => {
        const gross = Money.fromMinor(cents * 100); // valor en céntimos exactos
        const b = extractInclusiveTax(gross);
        expect(b.net.add(b.tax).equals(b.gross)).toBe(true);
        expect(b.tax.isNegative()).toBe(false);
      }),
    );
  });
});
