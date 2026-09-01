import { describe, it, expect } from 'vitest';
import { leerLiquidacion, importeDeTexto, COLUMNAS } from './liquidacion';

/**
 * Leer la liquidación de la pasarela.
 *
 * Lo que se defiende es lo mismo en las tres formas: **ningún importe pasa por
 * coma flotante**. Este archivo decide si se le reclama dinero a la pasarela; un
 * redondeo aquí es una varianza inventada, o —peor— una real que desaparece.
 */

const CABECERA = COLUMNAS.join(';');

describe('importeDeTexto', () => {
  it('acepta punto decimal, que es lo inequívoco', () => {
    expect(importeDeTexto('32.50')).toBe('32.50');
    expect(importeDeTexto('0.0001')).toBe('0.0001');
  });

  it('acepta coma decimal y punto de millar: es lo que escribe un Excel en español', () => {
    expect(importeDeTexto('1.234,56')).toBe('1234.56');
    expect(importeDeTexto('32,50')).toBe('32.50');
  });

  it('acepta negativos: una devolución llega en negativo', () => {
    expect(importeDeTexto('-12.00')).toBe('-12.00');
  });

  it('rechaza lo que no es un importe en vez de adivinarlo', () => {
    // `Number('S/ 32')` da NaN y `parseFloat` da 32: las dos formas de
    // adivinar acaban conciliando contra una cifra que nadie escribió.
    expect(importeDeTexto('S/ 32')).toBeNull();
    expect(importeDeTexto('treinta')).toBeNull();
    expect(importeDeTexto('')).toBeNull();
    expect(importeDeTexto('32.123456')).toBeNull();
  });
});

describe('leerLiquidacion', () => {
  it('lee las líneas y SUMA los totales con aritmética entera', () => {
    const r = leerLiquidacion(
      `${CABECERA}\nABC-1;32.50;1.14;31.36\nABC-2;0.10;0.01;0.09`,
    );
    expect('liquidacion' in r).toBe(true);
    if (!('liquidacion' in r)) return;

    expect(r.liquidacion.lines).toHaveLength(2);
    // 32.50 + 0.10. Con coma flotante esto es 32.599999999999994.
    expect(r.liquidacion.grossAmount).toBe('32.6000');
    expect(r.liquidacion.feeAmount).toBe('1.1500');
    expect(r.liquidacion.netAmount).toBe('31.4500');
  });

  it('nombra la columna que falta, en vez de fallar sin decir cuál', () => {
    const r = leerLiquidacion('referencia;bruto;neto\nABC-1;10.00;9.00');
    expect('error' in r && r.error).toContain('comision');
  });

  it('dice el NÚMERO DE FILA del importe que no entiende', () => {
    const r = leerLiquidacion(
      `${CABECERA}\nABC-1;32.50;1.14;31.36\nABC-2;mucho;0.01;0.09`,
    );
    expect('error' in r && r.error).toContain('fila 3');
    expect('error' in r && r.error).toContain('bruto');
  });

  it('una fila sin referencia se para: sin ella no se puede casar el cobro', () => {
    const r = leerLiquidacion(`${CABECERA}\n;32.50;1.14;31.36`);
    expect('error' in r && r.error).toContain('referencia');
  });

  it('UNA REFERENCIA REPETIDA se para antes de importar', () => {
    // Conciliaría dos veces el mismo cobro, y el resultado diría que la
    // pasarela pagó de más cuando no.
    const r = leerLiquidacion(
      `${CABECERA}\nABC-1;10.00;0.35;9.65\nABC-1;10.00;0.35;9.65`,
    );
    expect('error' in r && r.error).toContain('dos veces');
  });

  it('un archivo sin líneas no se importa', () => {
    expect('error' in leerLiquidacion(CABECERA)).toBe(true);
    expect('error' in leerLiquidacion('')).toBe(true);
  });

  it('aguanta el BOM y las comillas de Excel', () => {
    const r = leerLiquidacion(
      `\uFEFF"referencia";"bruto";"comision";"neto"\n"ABC-1";"10,00";"0,35";"9,65"`,
    );
    expect('liquidacion' in r && r.liquidacion.lines[0]?.providerRef).toBe(
      'ABC-1',
    );
    expect('liquidacion' in r && r.liquidacion.netAmount).toBe('9.6500');
  });

  it('las columnas pueden venir en otro orden', () => {
    // Cada pasarela ordena el suyo. Se casan por NOMBRE, no por posición: leer
    // el neto donde está el bruto no da error, da una conciliación falsa.
    const r = leerLiquidacion(
      'neto;referencia;comision;bruto\n9.65;ABC-1;0.35;10.00',
    );
    expect('liquidacion' in r && r.liquidacion.lines[0]).toEqual({
      providerRef: 'ABC-1',
      grossAmount: '10.00',
      feeAmount: '0.35',
      netAmount: '9.65',
    });
  });
});
