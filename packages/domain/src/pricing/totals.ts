import { Money, sumMoney, type CurrencyCode } from '../money/money.js';
import { extractInclusiveTax, IGV_PERU_BPS } from '../money/tax.js';
import {
  validateAndPriceModifiers,
  type ModifierGroup,
  type ModifierSelection,
} from './modifiers.js';

/**
 * Cálculo de totales de un pedido (RN-T04, RN-T05, RN-CAT-04).
 *
 * ESTE ES EL ÚNICO LUGAR DONDE SE CALCULA UN TOTAL. Corre idéntico en el
 * servidor y en el POS offline (ADR-0006). Si divergieran, el comprobante
 * electrónico saldría con un importe distinto al cobrado, que en Perú es un
 * problema tributario y no un error de software.
 *
 * Orden de operaciones (importa, y por eso está fijado aquí y no en cada
 * llamador):
 *   1. Línea = (precio unitario + modificadores) × cantidad
 *   2. Subtotal = Σ líneas, a escala 4 sin redondear
 *   3. Descuentos: primero los de línea, luego los de pedido sobre el subtotal
 *      ya descontado (nunca sobre el bruto: aplicar dos porcentajes sobre el
 *      bruto regala dinero)
 *   4. + envío + propina
 *   5. Redondeo half-up a 2 decimales SOLO AQUÍ, al total
 *   6. IGV desglosado hacia atrás desde el total (el precio ya lo incluye)
 */

export class PricingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

/** Descuento como monto fijo o como porcentaje en puntos básicos. */
export type Discount =
  | {
      readonly kind: 'amount';
      readonly amountMinor: number;
      readonly reason?: string;
    }
  | {
      readonly kind: 'percentage';
      readonly bps: number;
      readonly reason?: string;
    };

export interface OrderLineInput {
  readonly lineId: string;
  readonly productId: string;
  readonly productName: string;
  /** Precio unitario del producto en unidades menores (ya incluye IGV). */
  readonly unitPriceMinor: number;
  readonly quantity: number;
  /** Grupos definidos por el catálogo para este producto. */
  readonly modifierGroups?: readonly ModifierGroup[];
  /** Lo que eligió el cliente. */
  readonly modifierSelections?: readonly ModifierSelection[];
  readonly discount?: Discount;
}

export interface OrderTotalsInput {
  readonly lines: readonly OrderLineInput[];
  readonly currency?: CurrencyCode;
  /** Descuento sobre el pedido completo (cupón, promoción). */
  readonly orderDiscount?: Discount;
  readonly deliveryFeeMinor?: number;
  readonly tipMinor?: number;
  /** Tasa de impuesto en puntos básicos. Por defecto IGV Perú (18 %). */
  readonly taxRateBps?: number;
}

export interface LineTotals {
  readonly lineId: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  /** Precio unitario base, sin modificadores. */
  readonly unitPrice: Money;
  /** Ajuste por modificadores, por unidad. */
  readonly modifiersPerUnit: Money;
  /** (unitPrice + modifiersPerUnit) × quantity, antes de descuento. */
  readonly grossTotal: Money;
  readonly discount: Money;
  /** grossTotal − discount. Escala 4, sin redondear. */
  readonly total: Money;
}

export interface OrderTotals {
  readonly lines: readonly LineTotals[];
  /** Σ de los totales de línea (ya con descuentos de línea). */
  readonly subtotal: Money;
  readonly orderDiscount: Money;
  readonly deliveryFee: Money;
  readonly tip: Money;
  /** Importe final a cobrar, redondeado a céntimos (RN-T04). */
  readonly total: Money;
  /** Base imponible del total (sin propina: la propina no tributa). */
  readonly taxableBase: Money;
  readonly tax: Money;
  readonly taxRateBps: number;
  readonly currency: CurrencyCode;
}

/** Aplica un descuento a una base, sin permitir que el resultado sea negativo. */
function applyDiscount(base: Money, discount: Discount | undefined): Money {
  if (!discount) return Money.zero(base.currency);

  let amount: Money;
  if (discount.kind === 'amount') {
    if (discount.amountMinor < 0) {
      throw new PricingError(
        'Un descuento no puede ser negativo.',
        'DISCOUNT_NEGATIVE',
      );
    }
    amount = Money.fromMinor(discount.amountMinor, base.currency);
  } else {
    if (!Number.isInteger(discount.bps) || discount.bps < 0) {
      throw new PricingError(
        'El porcentaje de descuento debe ser un entero no negativo en puntos básicos.',
        'DISCOUNT_INVALID',
      );
    }
    if (discount.bps > 10_000) {
      throw new PricingError(
        'Un descuento no puede superar el 100 %.',
        'DISCOUNT_ABOVE_100',
      );
    }
    amount = base.multiplyByRatio(discount.bps, 10_000);
  }

  // Un descuento mayor que la base dejaría un total negativo: se topa. Es
  // preferible a cobrar en negativo o a rechazar la venta en caja.
  return amount.greaterThan(base) ? base : amount;
}

/**
 * Calcula los totales de un pedido. Función pura: mismas entradas, mismas
 * salidas, en servidor y en PWA.
 */
export function calculateOrderTotals(input: OrderTotalsInput): OrderTotals {
  const currency = input.currency ?? 'PEN';
  const taxRateBps = input.taxRateBps ?? IGV_PERU_BPS;

  if (input.lines.length === 0) {
    throw new PricingError(
      'Un pedido necesita al menos una línea.',
      'ORDER_EMPTY',
    );
  }

  const lines: LineTotals[] = input.lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new PricingError(
        `Cantidad inválida en "${line.productName}": debe ser un entero positivo.`,
        'QUANTITY_INVALID',
      );
    }

    const unitPrice = Money.fromMinor(line.unitPriceMinor, currency);
    if (unitPrice.isNegative()) {
      throw new PricingError(
        `El precio de "${line.productName}" no puede ser negativo.`,
        'PRICE_NEGATIVE',
      );
    }

    const modifiersPerUnit = validateAndPriceModifiers(
      line.modifierGroups ?? [],
      line.modifierSelections ?? [],
      currency,
    );

    const unitWithModifiers = unitPrice.add(modifiersPerUnit);
    if (unitWithModifiers.isNegative()) {
      // Modificadores con descuento que superan el precio del producto.
      throw new PricingError(
        `Los modificadores dejan "${line.productName}" con precio negativo.`,
        'LINE_PRICE_NEGATIVE',
      );
    }

    const grossTotal = unitWithModifiers.multiplyByQuantity(line.quantity);
    const discount = applyDiscount(grossTotal, line.discount);

    return {
      lineId: line.lineId,
      productId: line.productId,
      productName: line.productName,
      quantity: line.quantity,
      unitPrice,
      modifiersPerUnit,
      grossTotal,
      discount,
      total: grossTotal.subtract(discount),
    };
  });

  // Subtotal a escala 4: los subtotales conservan 4 decimales (RN-T04).
  const subtotal = sumMoney(lines.map((l) => l.total));

  // El descuento de pedido se aplica sobre el subtotal YA descontado por línea.
  const orderDiscount = applyDiscount(subtotal, input.orderDiscount);
  const afterDiscount = subtotal.subtract(orderDiscount);

  const deliveryFee = Money.fromMinor(input.deliveryFeeMinor ?? 0, currency);
  const tip = Money.fromMinor(input.tipMinor ?? 0, currency);
  if (deliveryFee.isNegative()) {
    throw new PricingError(
      'El envío no puede ser negativo.',
      'DELIVERY_NEGATIVE',
    );
  }
  if (tip.isNegative()) {
    throw new PricingError('La propina no puede ser negativa.', 'TIP_NEGATIVE');
  }

  // Redondeo half-up a céntimos SOLO aquí, sobre el total (RN-T04).
  const total = afterDiscount.add(deliveryFee).add(tip).roundToCents();

  // La propina NO forma parte de la base imponible: es una liberalidad del
  // cliente, no una contraprestación por el servicio.
  const taxableBase = afterDiscount.add(deliveryFee).roundToCents();
  const breakdown = extractInclusiveTax(taxableBase, taxRateBps);

  return {
    lines,
    subtotal,
    orderDiscount,
    deliveryFee,
    tip,
    total,
    taxableBase: breakdown.net,
    tax: breakdown.tax,
    taxRateBps,
    currency,
  };
}

/**
 * Comprueba que un total calculado en otro lado (p. ej. el POS offline)
 * coincide con el que produce este dominio. Es la defensa de la sincronización:
 * si el POS envía un total que no cuadra, se acepta la venta (RN-T07) pero se
 * levanta una alerta con la diferencia exacta.
 */
export function compareTotals(
  expected: Money,
  received: Money,
): { matches: boolean; difference: Money } {
  const difference = received.subtract(expected);
  return { matches: difference.isZero(), difference };
}
