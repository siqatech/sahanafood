import { describe, it, expect } from 'vitest';
import { Money } from '@sahana/domain';
import {
  diferencia,
  exigeAprobacion,
  lineasDelConteo,
  totalContado,
} from './arqueo';

/**
 * El conteo de la gaveta.
 *
 * Es aritmética sencilla y por eso mismo se prueba: un error aquí no se ve en
 * ningún log, se ve en una caja que no cuadra al final del turno y en una
 * conversación incómoda con quien la contó.
 */
describe('Arqueo por denominación', () => {
  it('suma billetes y monedas con Money, sin coma flotante', () => {
    // 2×100 + 3×50 + 1×20 + 4×0.10 = 370.40
    const contado = totalContado({
      1_000_000: 2,
      500_000: 3,
      200_000: 1,
      1_000: 4,
    });
    expect(contado.toDecimalString()).toBe('370.4000');
  });

  it('una gaveta vacía cuenta cero, no NaN', () => {
    expect(totalContado({}).minorUnits).toBe(0);
  });

  it('la diferencia lleva signo: sobra o falta', () => {
    const esperado = Money.fromMinor(1_000_000);
    expect(
      diferencia(Money.fromMinor(1_050_000), esperado).toDecimalString(),
    ).toBe('5.0000');
    expect(
      diferencia(Money.fromMinor(950_000), esperado).toDecimalString(),
    ).toBe('-5.0000');
  });

  it('CUALQUIER descuadre exige firma, aunque sea de diez céntimos', () => {
    // Diez céntimos repetidos cada día son un fraude pequeño y constante, que
    // es el que nunca se detecta (RN-POS-02).
    expect(exigeAprobacion(Money.fromMinor(0))).toBe(false);
    expect(exigeAprobacion(Money.fromMinor(1_000))).toBe(true);
    expect(exigeAprobacion(Money.fromMinor(-1_000))).toBe(true);
  });

  it('el desglose solo lista lo que se contó', () => {
    const lineas = lineasDelConteo({ 1_000_000: 2, 500_000: 0, 10_000: 3 });
    expect(lineas.map((l) => l.rotulo)).toEqual(['S/ 100', 'S/ 1']);
    expect(lineas[0]!.subtotal.toDecimalString()).toBe('200.0000');
  });
});
