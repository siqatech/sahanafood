import { Money } from '../money/money.js';
import type { Discount } from './totals.js';

/**
 * Política de descuentos (RN-T08, RN-POS-03).
 *
 * «Un descuento sobre el umbral exige PIN de supervisor» suena a una
 * comparación trivial, y es justo donde se cuela el fraude clásico del
 * mostrador: aplicar descuentos por debajo del umbral, uno detrás de otro,
 * hasta regalar el pedido. Por eso la decisión vive aquí, en el dominio
 * compartido, y compara SIEMPRE el descuento ACUMULADO del pedido — no el que
 * se está aplicando ahora.
 *
 * Y vive en `@sahana/domain` por el mismo motivo que el cálculo de totales: el
 * POS offline tiene que llegar a la misma conclusión que el servidor. Si el
 * POS decidiera por su cuenta que no hace falta PIN, el descuento entraría al
 * sincronizar sin que nadie lo hubiera autorizado.
 */

export interface DiscountPolicy {
  /**
   * Umbral en puntos básicos sobre el subtotal. 1500 bps = 15 %, el valor por
   * defecto de RN-T08.
   */
  readonly thresholdBps: number;
  /**
   * Umbral en importe absoluto (unidades menores). Un 10 % sobre un pedido de
   * empresa puede ser mucho dinero aunque quede bajo el porcentaje.
   * `undefined` = sin límite por importe.
   */
  readonly thresholdAmountMinor?: number | undefined;
}

export const DEFAULT_DISCOUNT_POLICY: DiscountPolicy = {
  thresholdBps: 1500,
};

export interface DiscountApprovalCheck {
  /** Subtotal del pedido ANTES de descuentos, en unidades menores. */
  readonly subtotalMinor: number;
  /** Descuento ya aplicado al pedido, en unidades menores. */
  readonly alreadyDiscountedMinor?: number | undefined;
  /** Descuento que se pretende aplicar ahora. */
  readonly discount: Discount;
  readonly policy?: DiscountPolicy | undefined;
}

export interface DiscountApprovalResult {
  /** Importe del descuento que se está aplicando. */
  readonly amount: Money;
  /** Descuento total del pedido si se aplica este. */
  readonly totalAfter: Money;
  /** Porcentaje acumulado sobre el subtotal, en puntos básicos. */
  readonly totalBps: number;
  readonly requiresApproval: boolean;
  /** Por qué hace falta aprobación; `null` si no hace falta. */
  readonly reason: 'percentage' | 'amount' | null;
}

export class DiscountError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DiscountError';
  }
}

/** Convierte un descuento a importe sobre un subtotal dado. */
export function discountAmount(
  discount: Discount,
  subtotalMinor: number,
): Money {
  const subtotal = Money.fromMinor(subtotalMinor);

  if (discount.kind === 'amount') {
    if (discount.amountMinor < 0) {
      throw new DiscountError(
        'Un descuento negativo es un recargo encubierto.',
        'DISCOUNT_NEGATIVE',
      );
    }
    if (discount.amountMinor > subtotalMinor) {
      // Descontar más que el subtotal deja un total negativo: el negocio
      // pagando al cliente. Casi siempre es un cero de más al teclear.
      throw new DiscountError(
        'El descuento no puede superar el subtotal del pedido.',
        'DISCOUNT_EXCEEDS_SUBTOTAL',
      );
    }
    return Money.fromMinor(discount.amountMinor);
  }

  if (discount.bps < 0) {
    throw new DiscountError(
      'Un descuento negativo es un recargo encubierto.',
      'DISCOUNT_NEGATIVE',
    );
  }
  if (discount.bps > 10_000) {
    throw new DiscountError(
      'Un descuento no puede pasar del 100 %.',
      'DISCOUNT_EXCEEDS_SUBTOTAL',
    );
  }
  // multiplyByRatio con redondeo half-up (RN-T04), el mismo que usa el resto
  // del cálculo de totales: un descuento redondeado de otra manera produciría
  // un total que no cuadra con sus partes.
  return subtotal.multiplyByRatio(discount.bps, 10_000);
}

/**
 * ¿Este descuento exige aprobación de un supervisor?
 *
 * Compara el ACUMULADO, no el descuento suelto: tres descuentos del 10 % sobre
 * un umbral del 15 % son un 30 % sin que nadie firme nada.
 */
export function checkDiscountApproval(
  input: DiscountApprovalCheck,
): DiscountApprovalResult {
  const policy = input.policy ?? DEFAULT_DISCOUNT_POLICY;
  if (input.subtotalMinor <= 0) {
    throw new DiscountError(
      'No se puede descontar sobre un pedido sin importe.',
      'DISCOUNT_NO_SUBTOTAL',
    );
  }

  const amount = discountAmount(input.discount, input.subtotalMinor);
  const previo = Money.fromMinor(input.alreadyDiscountedMinor ?? 0);
  const totalAfter = previo.add(amount);

  if (totalAfter.minorUnits > input.subtotalMinor) {
    throw new DiscountError(
      'El descuento acumulado supera el subtotal del pedido.',
      'DISCOUNT_EXCEEDS_SUBTOTAL',
    );
  }

  // Redondeo hacia arriba a propósito: un 15,004 % debe contar como «pasa del
  // 15 %». Truncar dejaría un resquicio sistemático justo en el umbral.
  const totalBps = Math.ceil(
    (totalAfter.minorUnits * 10_000) / input.subtotalMinor,
  );

  const superaPorcentaje = totalBps > policy.thresholdBps;
  const superaImporte =
    policy.thresholdAmountMinor !== undefined &&
    totalAfter.minorUnits > policy.thresholdAmountMinor;

  return {
    amount,
    totalAfter,
    totalBps,
    requiresApproval: superaPorcentaje || superaImporte,
    reason: superaPorcentaje ? 'percentage' : superaImporte ? 'amount' : null,
  };
}
