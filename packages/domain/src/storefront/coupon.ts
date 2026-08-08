import { Money } from '../money/money.js';

/**
 * Cupones v1 (spec 11, T5.12).
 *
 * Vive en `@sahana/domain` por la regla de siempre —el descuento es dinero— y
 * por una razón que se ve en cuanto uno se imagina el fallo: si el cupón se
 * calculara en el navegador, el cliente vería «-S/ 10» en pantalla y el
 * servidor cobraría otra cosa. Da igual quién tenga razón; la venta se pierde
 * en ese instante y con mal sabor.
 *
 * v1 a propósito: porcentaje, importe fijo y envío gratis. **No hay** compra
 * mínima por producto, ni límite por cliente, ni combinación de varios cupones.
 * Todo eso existe en los sistemas maduros y todo eso multiplica los casos
 * borde; entra cuando alguien lo pida con un caso real delante, no antes.
 */

export type CouponKind = 'percent' | 'fixed' | 'free_delivery';

export interface Coupon {
  code: string;
  kind: CouponKind;
  /** Descuento en puntos básicos, para `percent`. 1000 = 10 %. */
  percentBps?: number | undefined;
  /** Descuento fijo en unidades menores, para `fixed`. */
  amountMinor?: number | undefined;
  /** Pedido mínimo para que aplique, en unidades menores. */
  minOrderMinor?: number | undefined;
  /** Tope del descuento, en unidades menores. 0/undefined = sin tope. */
  maxDiscountMinor?: number | undefined;
  validFrom?: Date | undefined;
  validUntil?: Date | undefined;
  /** Usos totales permitidos. undefined = ilimitado. */
  maxUses?: number | undefined;
  usedCount?: number | undefined;
  active?: boolean | undefined;
}

/**
 * Motivo por el que un cupón no aplica.
 *
 * Códigos estables y no frases: la tienda tiene que poder decirle al cliente
 * «te faltan S/ 12 para usarlo» en vez de «cupón inválido», que es la respuesta
 * que hace abandonar el carrito. La frase la pone la interfaz; el motivo lo
 * pone el dominio.
 */
export type CouponRejection =
  | { code: 'COUPON_UNKNOWN' }
  | { code: 'COUPON_INACTIVE' }
  | { code: 'COUPON_NOT_STARTED'; validFrom: string }
  | { code: 'COUPON_EXPIRED'; validUntil: string }
  | { code: 'COUPON_EXHAUSTED' }
  | { code: 'COUPON_BELOW_MINIMUM'; minOrder: string; missing: string };

export type CouponResult =
  | { applies: true; discount: Money; freeDelivery: boolean }
  | { applies: false; rejection: CouponRejection };

export class CouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouponError';
  }
}

/**
 * Aplica un cupón a un subtotal.
 *
 * El descuento se calcula sobre el SUBTOTAL de productos, nunca sobre el total
 * con envío e IGV incluidos. Dos motivos y los dos son de negocio: descontar
 * sobre el envío regala margen del repartidor, y descontar sobre el IGV es
 * descontar sobre un impuesto que hay que declarar igual.
 */
export function applyCoupon(
  coupon: Coupon,
  subtotal: Money,
  deliveryFee: Money,
  now = new Date(),
): CouponResult {
  if (coupon.active === false) {
    return { applies: false, rejection: { code: 'COUPON_INACTIVE' } };
  }
  if (coupon.validFrom && now < coupon.validFrom) {
    return {
      applies: false,
      rejection: {
        code: 'COUPON_NOT_STARTED',
        validFrom: coupon.validFrom.toISOString(),
      },
    };
  }
  if (coupon.validUntil && now > coupon.validUntil) {
    return {
      applies: false,
      rejection: {
        code: 'COUPON_EXPIRED',
        validUntil: coupon.validUntil.toISOString(),
      },
    };
  }
  if (
    coupon.maxUses !== undefined &&
    (coupon.usedCount ?? 0) >= coupon.maxUses
  ) {
    return { applies: false, rejection: { code: 'COUPON_EXHAUSTED' } };
  }

  const minimo = coupon.minOrderMinor ?? 0;
  if (subtotal.minorUnits < minimo) {
    return {
      applies: false,
      rejection: {
        code: 'COUPON_BELOW_MINIMUM',
        minOrder: Money.fromMinor(minimo, subtotal.currency).toDecimalString(),
        // Cuánto falta, no solo cuál es el mínimo: es la diferencia entre
        // «no puedes» y «añade S/ 12 y lo tienes».
        missing: Money.fromMinor(
          minimo - subtotal.minorUnits,
          subtotal.currency,
        ).toDecimalString(),
      },
    };
  }

  if (coupon.kind === 'free_delivery') {
    return {
      applies: true,
      discount: deliveryFee,
      freeDelivery: true,
    };
  }

  let bruto: number;
  if (coupon.kind === 'percent') {
    const bps = coupon.percentBps ?? 0;
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      throw new CouponError(
        'El porcentaje del cupón debe ser un entero de puntos básicos entre 0 y 10000.',
      );
    }
    // Redondeo half-up sobre enteros, sin coma flotante (RN-T04).
    bruto = Math.floor((subtotal.minorUnits * bps + 5_000) / 10_000);
  } else {
    bruto = coupon.amountMinor ?? 0;
    if (!Number.isInteger(bruto) || bruto < 0) {
      throw new CouponError('El importe del cupón debe ser un entero no negativo.');
    }
  }

  const conTope =
    coupon.maxDiscountMinor && coupon.maxDiscountMinor > 0
      ? Math.min(bruto, coupon.maxDiscountMinor)
      : bruto;

  // El descuento NUNCA supera el subtotal. Un cupón de S/ 50 sobre un pedido de
  // S/ 30 no puede dejar un total negativo: eso sería pagarle al cliente por
  // comprar, y en un sistema que factura a SUNAT es un comprobante imposible.
  const final = Math.min(conTope, subtotal.minorUnits);

  return {
    applies: true,
    discount: Money.fromMinor(final, subtotal.currency),
    freeDelivery: false,
  };
}
