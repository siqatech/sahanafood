import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money } from '../money/money.js';
import { applyCoupon, CouponError, type Coupon } from './coupon.js';

const soles = (d: string): Money => Money.parse(d);
const ENVIO = soles('6.00');

const cupon = (over: Partial<Coupon> = {}): Coupon => ({
  code: 'BIENVENIDO',
  kind: 'percent',
  percentBps: 1000,
  ...over,
});

describe('Cupones (spec 11, T5.12)', () => {
  it('descuenta un porcentaje del subtotal', () => {
    const r = applyCoupon(cupon(), soles('50.00'), ENVIO);
    expect(r.applies).toBe(true);
    if (r.applies) expect(r.discount.toDecimalString()).toBe('5.0000');
  });

  it('descuenta un importe fijo', () => {
    const r = applyCoupon(
      cupon({ kind: 'fixed', amountMinor: 100_000 }),
      soles('50.00'),
      ENVIO,
    );
    if (r.applies) expect(r.discount.toDecimalString()).toBe('10.0000');
  });

  it('el envío gratis descuenta exactamente el envío', () => {
    const r = applyCoupon(
      cupon({ kind: 'free_delivery' }),
      soles('50.00'),
      ENVIO,
    );
    expect(r.applies).toBe(true);
    if (r.applies) {
      expect(r.discount.toDecimalString()).toBe('6.0000');
      expect(r.freeDelivery).toBe(true);
    }
  });

  it('SE CALCULA SOBRE EL SUBTOTAL, no sobre el total con envío', () => {
    // Descontar sobre el envío regala margen del repartidor. El 10 % de 50 es
    // 5, no 5,60.
    const r = applyCoupon(cupon(), soles('50.00'), soles('6.00'));
    if (r.applies) expect(r.discount.toDecimalString()).toBe('5.0000');
  });

  it('respeta el tope de descuento', () => {
    const r = applyCoupon(
      cupon({ percentBps: 5000, maxDiscountMinor: 100_000 }),
      soles('200.00'),
      ENVIO,
    );
    // 50 % de 200 = 100, topado a 10.
    if (r.applies) expect(r.discount.toDecimalString()).toBe('10.0000');
  });

  it('NUNCA deja el total negativo', () => {
    // Un cupón de S/ 50 sobre un pedido de S/ 30 sería pagarle al cliente por
    // comprar, y en un sistema que factura a SUNAT es un comprobante imposible.
    const r = applyCoupon(
      cupon({ kind: 'fixed', amountMinor: 500_000 }),
      soles('30.00'),
      ENVIO,
    );
    if (r.applies) expect(r.discount.toDecimalString()).toBe('30.0000');
  });

  it('POR DEBAJO DEL MÍNIMO dice CUÁNTO FALTA, no solo que no puede', () => {
    // Es la diferencia entre «cupón inválido» —que hace abandonar el carrito— y
    // «añade S/ 12 y lo tienes».
    const r = applyCoupon(
      cupon({ minOrderMinor: 500_000 }),
      soles('38.00'),
      ENVIO,
    );
    expect(r.applies).toBe(false);
    if (!r.applies && r.rejection.code === 'COUPON_BELOW_MINIMUM') {
      expect(r.rejection.minOrder).toBe('50.0000');
      expect(r.rejection.missing).toBe('12.0000');
    } else {
      throw new Error('se esperaba rechazo por mínimo');
    }
  });

  it('rechaza un cupón inactivo, caducado o aún no vigente', () => {
    const ahora = new Date('2026-06-15T12:00:00Z');
    expect(
      applyCoupon(cupon({ active: false }), soles('50.00'), ENVIO).applies,
    ).toBe(false);
    expect(
      applyCoupon(
        cupon({ validUntil: new Date('2026-01-01T00:00:00Z') }),
        soles('50.00'),
        ENVIO,
        ahora,
      ).applies,
    ).toBe(false);
    expect(
      applyCoupon(
        cupon({ validFrom: new Date('2026-12-01T00:00:00Z') }),
        soles('50.00'),
        ENVIO,
        ahora,
      ).applies,
    ).toBe(false);
  });

  it('rechaza un cupón agotado', () => {
    const r = applyCoupon(
      cupon({ maxUses: 100, usedCount: 100 }),
      soles('50.00'),
      ENVIO,
    );
    expect(r.applies).toBe(false);
    if (!r.applies) expect(r.rejection.code).toBe('COUPON_EXHAUSTED');
  });

  it('rechaza un porcentaje imposible', () => {
    expect(() =>
      applyCoupon(cupon({ percentBps: 20_000 }), soles('50.00'), ENVIO),
    ).toThrow(CouponError);
  });

  it('PROPIEDAD: el descuento nunca excede el subtotal ni es negativo', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (subtotalMinor, bps, fijoMinor) => {
          for (const c of [
            cupon({ percentBps: bps }),
            cupon({ kind: 'fixed' as const, amountMinor: fijoMinor }),
          ]) {
            const r = applyCoupon(c, Money.fromMinor(subtotalMinor), ENVIO);
            if (r.applies) {
              expect(r.discount.minorUnits).toBeGreaterThanOrEqual(0);
              expect(r.discount.minorUnits).toBeLessThanOrEqual(subtotalMinor);
            }
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
