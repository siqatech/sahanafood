import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  checkDiscountApproval,
  discountAmount,
  DiscountError,
  DEFAULT_DISCOUNT_POLICY,
} from './discount-policy.js';
import { Money } from '../money/money.js';

/** Subtotal de referencia: S/ 100,00. */
const CIEN = Money.parse('100.00').minorUnits;

describe('Importe del descuento', () => {
  it('calcula el porcentaje sobre el subtotal', () => {
    const d = discountAmount({ kind: 'percentage', bps: 1000 }, CIEN);
    expect(d.toDecimalString()).toBe('10.0000');
  });

  it('un descuento por importe se toma tal cual', () => {
    const d = discountAmount(
      { kind: 'amount', amountMinor: Money.parse('12.50').minorUnits },
      CIEN,
    );
    expect(d.toDecimalString()).toBe('12.5000');
  });

  it('RECHAZA descontar más que el subtotal', () => {
    // Dejaría un total negativo: el negocio pagando al cliente. Casi siempre
    // es un cero de más al teclear.
    expect(() =>
      discountAmount({ kind: 'amount', amountMinor: CIEN + 1 }, CIEN),
    ).toThrow(/no puede superar el subtotal/);
    expect(() =>
      discountAmount({ kind: 'percentage', bps: 10_001 }, CIEN),
    ).toThrow(/100 %/);
  });

  it('RECHAZA un descuento negativo: sería un recargo encubierto', () => {
    expect(() =>
      discountAmount({ kind: 'amount', amountMinor: -100 }, CIEN),
    ).toThrow(DiscountError);
    expect(() =>
      discountAmount({ kind: 'percentage', bps: -50 }, CIEN),
    ).toThrow(DiscountError);
  });
});

describe('Umbral de aprobación (RN-T08)', () => {
  it('por debajo del umbral no hace falta supervisor', () => {
    const r = checkDiscountApproval({
      subtotalMinor: CIEN,
      discount: { kind: 'percentage', bps: 1000 },
    });
    expect(r.requiresApproval).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('justo EN el umbral tampoco: el 15 % está permitido', () => {
    const r = checkDiscountApproval({
      subtotalMinor: CIEN,
      discount: { kind: 'percentage', bps: DEFAULT_DISCOUNT_POLICY.thresholdBps },
    });
    expect(r.totalBps).toBe(1500);
    expect(r.requiresApproval).toBe(false);
  });

  it('un pelo por encima del umbral SÍ exige supervisor', () => {
    const r = checkDiscountApproval({
      subtotalMinor: CIEN,
      discount: { kind: 'percentage', bps: 1501 },
    });
    expect(r.requiresApproval).toBe(true);
    expect(r.reason).toBe('percentage');
  });

  it('EL FRAUDE CLÁSICO: descuentos pequeños encadenados SÍ suman', () => {
    // Tres descuentos del 10 % con umbral del 15 % son un 30 % sin que nadie
    // firme nada. Se compara el ACUMULADO, no el descuento suelto.
    const primero = checkDiscountApproval({
      subtotalMinor: CIEN,
      discount: { kind: 'percentage', bps: 1000 },
    });
    expect(primero.requiresApproval).toBe(false);

    const segundo = checkDiscountApproval({
      subtotalMinor: CIEN,
      alreadyDiscountedMinor: primero.totalAfter.minorUnits,
      discount: { kind: 'percentage', bps: 1000 },
    });
    expect(
      segundo.requiresApproval,
      'el segundo descuento del 10 % pasó sin aprobación: el acumulado ya era del 20 %',
    ).toBe(true);
    expect(segundo.totalBps).toBe(2000);
  });

  it('redondea el acumulado HACIA ARRIBA: 15,004 % ya pasa del umbral', () => {
    // Truncar dejaría un resquicio sistemático justo en el umbral.
    const subtotal = Money.parse('1000.00').minorUnits;
    const r = checkDiscountApproval({
      subtotalMinor: subtotal,
      discount: {
        kind: 'amount',
        amountMinor: Money.parse('150.05').minorUnits,
      },
    });
    expect(r.totalBps).toBe(1501);
    expect(r.requiresApproval).toBe(true);
  });

  it('el umbral por IMPORTE atrapa lo que el porcentaje deja pasar', () => {
    // Un 10 % sobre un pedido de empresa es mucho dinero aunque quede bajo el
    // porcentaje.
    const subtotal = Money.parse('5000.00').minorUnits;
    const r = checkDiscountApproval({
      subtotalMinor: subtotal,
      discount: { kind: 'percentage', bps: 1000 },
      policy: {
        thresholdBps: 1500,
        thresholdAmountMinor: Money.parse('100.00').minorUnits,
      },
    });
    expect(r.requiresApproval).toBe(true);
    expect(r.reason).toBe('amount');
  });

  it('rechaza descontar sobre un pedido sin importe', () => {
    expect(() =>
      checkDiscountApproval({
        subtotalMinor: 0,
        discount: { kind: 'percentage', bps: 500 },
      }),
    ).toThrow(/sin importe/);
  });

  it('rechaza que el ACUMULADO supere el subtotal', () => {
    expect(() =>
      checkDiscountApproval({
        subtotalMinor: CIEN,
        alreadyDiscountedMinor: Money.parse('90.00').minorUnits,
        discount: { kind: 'amount', amountMinor: Money.parse('20.00').minorUnits },
      }),
    ).toThrow(/acumulado supera el subtotal/);
  });

  it('PROPIEDAD: nunca deja pasar sin aprobación un acumulado sobre el umbral', () => {
    // La propiedad que importa: no existe combinación de subtotal y descuento
    // que supere el umbral y quede sin firmar. Los casos escritos a mano
    // dejarían huecos justo en los redondeos.
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000, max: 100_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (subtotalMinor, bps, previoBps) => {
          const previo = Math.floor((subtotalMinor * previoBps) / 10_000);
          let r;
          try {
            r = checkDiscountApproval({
              subtotalMinor,
              alreadyDiscountedMinor: previo,
              discount: { kind: 'percentage', bps },
            });
          } catch {
            // Supera el subtotal: rechazado, que es más estricto todavía.
            return;
          }
          const porcentajeReal =
            (r.totalAfter.minorUnits * 10_000) / subtotalMinor;
          if (porcentajeReal > DEFAULT_DISCOUNT_POLICY.thresholdBps) {
            expect(r.requiresApproval).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
