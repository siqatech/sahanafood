import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money } from '../money/money.js';
import { verifyPaidAmount, amountConfirms } from './amount-check.js';

const soles = (decimal: string): Money => Money.parse(decimal);

describe('Verificación del importe del webhook', () => {
  it('el importe exacto confirma', () => {
    const v = verifyPaidAmount(soles('38.50'), soles('38.50'));
    expect(v.kind).toBe('match');
    expect(amountConfirms(v)).toBe(true);
  });

  it('UN CÉNTIMO DE MENOS NO CONFIRMA', () => {
    // Sin tolerancia, a propósito. Un céntimo por pedido «por redondeo» es,
    // a volumen de dark kitchen, una nómina al año.
    const v = verifyPaidAmount(soles('38.50'), soles('38.49'));
    expect(v.kind).toBe('short');
    expect(amountConfirms(v)).toBe(false);
    if (v.kind === 'short') expect(v.missing).toBe('0.0100');
  });

  it('un pago de MÁS tampoco confirma, y se distingue del de menos', () => {
    // Los dos son «no cuadra», pero la acción es opuesta: aquí hay que
    // devolver dinero, no reclamarlo.
    const v = verifyPaidAmount(soles('38.50'), soles('40.00'));
    expect(v.kind).toBe('over');
    expect(amountConfirms(v)).toBe(false);
    if (v.kind === 'over') expect(v.excess).toBe('1.5000');
  });

  it('otra moneda NUNCA es un redondeo', () => {
    const v = verifyPaidAmount(
      Money.parse('38.50', 'PEN'),
      Money.parse('38.50', 'USD'),
    );
    expect(v.kind).toBe('currency');
    expect(amountConfirms(v)).toBe(false);
  });

  it('PROPIEDAD: solo la igualdad exacta confirma', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (esperado, recibido) => {
          const v = verifyPaidAmount(
            Money.fromMinor(esperado, 'PEN'),
            Money.fromMinor(recibido, 'PEN'),
          );
          expect(amountConfirms(v)).toBe(esperado === recibido);
        },
      ),
      { numRuns: 500 },
    );
  });
});
