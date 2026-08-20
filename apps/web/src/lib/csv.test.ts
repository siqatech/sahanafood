import { describe, it, expect } from 'vitest';
import { aCsv } from './csv';

/**
 * Lo que se prueba aquí no es «genera un CSV»: es que **no lo rompa un dato de
 * verdad**. Un separador dentro de un nombre, un salto de línea en una nota de
 * cocina o unas comillas en el nombre de un plato desplazan todas las columnas
 * siguientes, y el fallo aparece en la fila 87 de un archivo que alguien ya
 * está usando para declarar impuestos.
 */
describe('aCsv', () => {
  it('separa con `;`, que es lo que abre Excel en español', () => {
    const csv = aCsv(['a', 'b'], [[1, 2]]);
    expect(csv).toContain('a;b');
    expect(csv).toContain('1;2');
  });

  it('empieza con BOM: sin él, «Pollería» se lee «PollerÃ­a»', () => {
    expect(aCsv(['x'], [['Pollería']]).charCodeAt(0)).toBe(0xfeff);
  });

  it('entrecomilla la celda que lleva el SEPARADOR dentro', () => {
    const csv = aCsv(['nombre'], [['Ramos; Luis']]);
    expect(csv).toContain('"Ramos; Luis"');
    // Y sigue siendo UNA sola columna: si no, la fila entera se desplaza.
    const fila = csv.trimEnd().split('\r\n')[1]!;
    expect(fila.split(';').length).toBeGreaterThan(1); // está partido…
    expect(fila.startsWith('"')).toBe(true); // …pero dentro de comillas.
  });

  it('duplica las comillas, como manda RFC 4180', () => {
    expect(aCsv(['p'], [['Pollo "a la brasa"']])).toContain(
      '"Pollo ""a la brasa"""',
    );
  });

  it('entrecomilla los saltos de línea de una nota de cocina', () => {
    const csv = aCsv(['nota'], [['Sin ají.\nTocar el timbre 2 veces']]);
    expect(csv).toContain('"Sin ají.\nTocar el timbre 2 veces"');
  });

  it('un nulo es una celda VACÍA, no la palabra «null»', () => {
    expect(aCsv(['t'], [[null]])).toContain('\r\n\r\n');
    expect(aCsv(['t'], [[undefined]])).not.toContain('undefined');
  });
});
