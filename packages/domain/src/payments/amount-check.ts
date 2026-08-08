import type { Money } from '../money/money.js';

/**
 * Verificación del importe que trae el webhook de la pasarela (ADR-0016 §5).
 *
 * Existe porque la alternativa —creerse el número que manda el otro lado— es
 * cómoda hasta el día en que llega uno que no es el que se cobró. Y ese día no
 * se nota: el pedido se confirma, la cocina lo prepara y la diferencia aparece
 * semanas después en una conciliación, cuando ya nadie recuerda el pedido.
 *
 * No se compara con tolerancia. `Money` es entero a escala 4 y tanto el importe
 * de la intención como el del webhook pasan por él: si difieren, difieren de
 * verdad. Una tolerancia «por redondeo» aquí sería una puerta abierta a
 * diferencias reales de un céntimo por pedido, que a volumen es una nómina.
 */

export type AmountVerdict =
  | { kind: 'match' }
  /**
   * Llegó MENOS de lo esperado. Es el caso peligroso: si se confirma, se
   * entrega comida cobrada a medias.
   */
  | { kind: 'short'; expected: string; received: string; missing: string }
  /**
   * Llegó MÁS. No confirma tampoco —algo no cuadra— pero se distingue porque
   * la acción es distinta: aquí hay que devolver dinero, no reclamarlo.
   */
  | { kind: 'over'; expected: string; received: string; excess: string }
  /** Otra moneda. Nunca es un redondeo: es un pago que no es de este pedido. */
  | { kind: 'currency'; expected: string; received: string };

export function verifyPaidAmount(
  expected: Money,
  received: Money,
): AmountVerdict {
  if (expected.currency !== received.currency) {
    return {
      kind: 'currency',
      expected: expected.currency,
      received: received.currency,
    };
  }

  const diferencia = received.subtract(expected);
  if (diferencia.minorUnits === 0) return { kind: 'match' };

  if (diferencia.minorUnits < 0) {
    return {
      kind: 'short',
      expected: expected.toDecimalString(),
      received: received.toDecimalString(),
      missing: expected.subtract(received).toDecimalString(),
    };
  }

  return {
    kind: 'over',
    expected: expected.toDecimalString(),
    received: received.toDecimalString(),
    excess: diferencia.toDecimalString(),
  };
}

/**
 * Solo un importe exacto confirma.
 *
 * Se expone aparte para que la decisión no dependa de que el llamador recuerde
 * comparar `kind === 'match'`: un `if (verdict.kind !== 'short')` escrito con
 * prisa confirmaría los pagos de más y los de otra moneda.
 */
export function amountConfirms(verdict: AmountVerdict): boolean {
  return verdict.kind === 'match';
}
