import { describe, it, expect } from 'vitest';
import { soles, hayDiferencia } from './dinero';

/**
 * El formateo de dinero del panel.
 *
 * Tiene prueba propia porque es la única aritmética monetaria que ocurre fuera
 * de `@sahana/domain`, y porque la forma obvia —dividir por `10 ** scale`— es
 * la prohibida por CLAUDE.md. Los casos de abajo son justo los que distinguen
 * un corte de cadena correcto de uno que «funciona con los números de hoy».
 */

const PEN = (minorUnits: number, scale = 4) => ({
  minorUnits,
  currency: 'PEN',
  scale,
});

describe('soles()', () => {
  it('corta a dos decimales una escala de cuatro', () => {
    expect(soles(PEN(325_000))).toBe('32.50');
  });

  it('no pierde el cero de la izquierda en importes menores que uno', () => {
    // Con división y `toFixed` esto sale bien; con un corte mal hecho sale
    // «.50» o «5.00», que en un arqueo es una diferencia de cinco soles.
    expect(soles(PEN(5_000))).toBe('0.50');
    expect(soles(PEN(500))).toBe('0.05');
    expect(soles(PEN(0))).toBe('0.00');
  });

  it('conserva el signo: en un arqueo, faltar y sobrar no son lo mismo', () => {
    expect(soles(PEN(-125_000))).toBe('-12.50');
  });

  it('aguanta importes grandes sin redondeo de coma flotante', () => {
    // 99 999 999.99 en escala 4. Dividido en coma flotante, un importe así ya
    // empieza a perder el último céntimo.
    expect(soles(PEN(999_999_999_900))).toBe('99999999.99');
  });

  it('trunca, no redondea: lo mostrado nunca es más de lo que hay', () => {
    // 32.5099 se enseña como 32.50. Redondear hacia arriba enseñaría un
    // céntimo que no está en la gaveta.
    expect(soles(PEN(325_099))).toBe('32.50');
  });

  it('funciona con escala 2, por si la API cambia de precisión', () => {
    expect(soles(PEN(3_250, 2))).toBe('32.50');
  });
});

describe('hayDiferencia()', () => {
  it('un turno sin cerrar no tiene diferencia', () => {
    expect(hayDiferencia(null)).toBe(false);
  });

  it('cero es CUADRA, no diferencia', () => {
    // Pintar el cero como descuadre haría que la pantalla marcara en rojo
    // todos los turnos correctos, y a la semana nadie miraría el rojo.
    expect(hayDiferencia(PEN(0))).toBe(false);
  });

  it('un céntimo ya es diferencia, en los dos sentidos', () => {
    expect(hayDiferencia(PEN(100))).toBe(true);
    expect(hayDiferencia(PEN(-100))).toBe(true);
  });
});
