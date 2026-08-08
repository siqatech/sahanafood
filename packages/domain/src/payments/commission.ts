import { Money } from '../money/money.js';

/**
 * Comisión de canal: estimada al aceptar, liquidada al conciliar (RN-BIL-04).
 *
 * Vive en `@sahana/domain` porque es dinero, y el dinero se calcula en un solo
 * sitio. Pero hay una razón más específica: **este número decide si una marca
 * es rentable**. El panel de rentabilidad resta la comisión al ingreso, y si la
 * estimación se calculara distinto en el servidor que en el informe, el dueño
 * vería dos márgenes distintos para el mismo pedido y dejaría de creerse los
 * dos.
 *
 * La estimación NO es la verdad. Es lo que el tarifario dice que debería
 * cobrarse; lo que de verdad se cobró llega semanas después en la liquidación
 * de la pasarela, y casi nunca coincide al céntimo: hay mínimos, hay
 * redondeos por transacción, hay promociones y hay errores. Por eso se guardan
 * las dos y la diferencia es un dato de negocio, no un fallo que corregir.
 */

/**
 * Tarifa de un canal o pasarela.
 *
 * Porcentaje en **puntos básicos** y no en decimales: un 3,5 % es 350 bps, un
 * entero exacto. Con `0.035` en coma flotante, mil pedidos acumulan una deriva
 * que aparece justo en la conciliación y que nadie sabe explicar.
 */
export interface CommissionTariff {
  /** Porcentaje sobre el importe, en puntos básicos (350 = 3,5 %). */
  percentBps: number;
  /** Cargo fijo por transacción, en unidades menores. */
  fixedMinor: number;
  /** Mínimo por transacción, en unidades menores. 0 = sin mínimo. */
  minimumMinor?: number | undefined;
}

export class CommissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommissionError';
  }
}

export function assertValidTariff(tariff: CommissionTariff): void {
  if (!Number.isInteger(tariff.percentBps) || tariff.percentBps < 0) {
    throw new CommissionError(
      'El porcentaje de comisión debe ser un entero de puntos básicos no negativo.',
    );
  }
  // 10 000 bps = 100 %. Una comisión mayor que la venta no es una tarifa: es un
  // dedo de más al teclear, y aceptarla produce márgenes negativos que alguien
  // interpretará como que el negocio va mal.
  if (tariff.percentBps > 10_000) {
    throw new CommissionError(
      'Una comisión superior al 100 % del importe es casi siempre un error de captura.',
    );
  }
  if (!Number.isInteger(tariff.fixedMinor) || tariff.fixedMinor < 0) {
    throw new CommissionError('El cargo fijo debe ser un entero no negativo.');
  }
  if (
    tariff.minimumMinor !== undefined &&
    (!Number.isInteger(tariff.minimumMinor) || tariff.minimumMinor < 0)
  ) {
    throw new CommissionError('El mínimo debe ser un entero no negativo.');
  }
}

/**
 * Comisión estimada de un cobro.
 *
 * `porcentaje + fijo`, y nunca por debajo del mínimo. El redondeo es half-up y
 * **solo al final**: redondear el porcentaje antes de sumar el fijo produce una
 * diferencia de un céntimo que, multiplicada por el volumen de un mes, es
 * exactamente el tipo de descuadre que hace desconfiar de un informe entero.
 */
export function estimateCommission(
  amount: Money,
  tariff: CommissionTariff,
): Money {
  assertValidTariff(tariff);
  if (amount.minorUnits < 0) {
    throw new CommissionError(
      'No se estima comisión sobre un importe negativo.',
    );
  }

  // División entera con redondeo half-up sobre unidades menores enteras: sin
  // coma flotante en ningún punto del camino.
  const porcentaje = redondearMitadArriba(
    amount.minorUnits * tariff.percentBps,
    10_000,
  );
  const bruto = porcentaje + tariff.fixedMinor;
  const conMinimo = Math.max(bruto, tariff.minimumMinor ?? 0);

  // La comisión no puede superar el importe. Pasa con pedidos muy pequeños y un
  // fijo alto: un pedido de S/ 2 con S/ 1,50 fijo dejaría al local pagando por
  // vender. Se topa y la diferencia se ve en la liquidación, que es donde tiene
  // que discutirse con la pasarela.
  const topado = Math.min(conMinimo, amount.minorUnits);

  return Money.fromMinor(topado, amount.currency);
}

/**
 * Diferencia entre lo estimado y lo liquidado.
 *
 * Positiva = la pasarela cobró MÁS de lo previsto, que es la que duele y la que
 * hay que reclamar. Negativa = cobró menos, que también interesa porque suele
 * significar que el tarifario está desactualizado.
 */
export interface CommissionVariance {
  estimated: string;
  settled: string;
  /** Liquidado − estimado, como cadena decimal con signo. */
  difference: string;
  /** Diferencia en puntos básicos sobre lo estimado. 0 si lo estimado era 0. */
  differenceBps: number;
  /** true si la diferencia supera la tolerancia dada. */
  significant: boolean;
}

/**
 * Compara estimado con liquidado.
 *
 * La tolerancia se expresa en bps sobre lo estimado y no en dinero absoluto: un
 * céntimo de diferencia sobre una comisión de S/ 0,50 es un 2 % y merece una
 * mirada; el mismo céntimo sobre S/ 5 000 es ruido de redondeo. Una tolerancia
 * en soles trataría los dos casos igual y acabaría enseñando cien alertas
 * irrelevantes al día, que es la forma más segura de que no se lea ninguna.
 */
export function compareCommission(
  estimated: Money,
  settled: Money,
  toleranceBps = 100,
): CommissionVariance {
  if (estimated.currency !== settled.currency) {
    throw new CommissionError(
      `No se comparan comisiones en monedas distintas (${estimated.currency} vs ${settled.currency}).`,
    );
  }

  const diferencia = settled.subtract(estimated);
  const bps =
    estimated.minorUnits === 0
      ? 0
      : redondearMitadArriba(
          Math.abs(diferencia.minorUnits) * 10_000,
          estimated.minorUnits,
        );

  return {
    estimated: estimated.toDecimalString(),
    settled: settled.toDecimalString(),
    difference: diferencia.toDecimalString(),
    differenceBps: diferencia.minorUnits < 0 ? -bps : bps,
    // Si no había estimación (tarifario sin configurar) cualquier liquidación
    // distinta de cero es significativa: es justo el caso que hay que ver.
    significant:
      estimated.minorUnits === 0
        ? diferencia.minorUnits !== 0
        : bps > toleranceBps,
  };
}

/** División entera con redondeo half-up. Sin coma flotante (RN-T04). */
function redondearMitadArriba(numerador: number, denominador: number): number {
  return Math.floor((numerador + Math.floor(denominador / 2)) / denominador);
}
