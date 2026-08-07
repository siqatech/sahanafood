import { describe, it, expect } from 'vitest';
import { encodeCp850, fitWidth, twoColumns } from './encoding.js';

/**
 * La codificación es donde el ticket se estropea sin que nadie lo note hasta
 * que sale mal impreso delante de un cliente. Se prueba byte a byte porque es
 * la única forma de saberlo sin tener la impresora delante.
 */

describe('Codificación CP850', () => {
  it('el ASCII pasa tal cual', () => {
    expect([...encodeCp850('Combo 1')]).toEqual([
      0x43, 0x6f, 0x6d, 0x62, 0x6f, 0x20, 0x31,
    ]);
  });

  it('los acentos del español salen en su byte de CP850, no en UTF-8', () => {
    // En UTF-8, «ó» son DOS bytes (0xC3 0xB3) y la impresora imprimiría «Ã³».
    expect([...encodeCp850('ó')]).toEqual([0xa2]);
    expect([...encodeCp850('ñ')]).toEqual([0xa4]);
    expect([...encodeCp850('Ñ')]).toEqual([0xa5]);
    expect([...encodeCp850('á')]).toEqual([0xa0]);
    expect([...encodeCp850('¿')]).toEqual([0xa8]);
    expect([...encodeCp850('¡')]).toEqual([0xad]);
  });

  it('una palabra real del menú se codifica entera', () => {
    // «Ración» impresa como «RaciÃ³n» es el fallo clásico de mandar UTF-8.
    expect([...encodeCp850('Ración')]).toEqual([
      0x52, 0x61, 0x63, 0x69, 0xa2, 0x6e,
    ]);
  });

  it('un carácter fuera de la tabla se degrada SIN TILDE antes de rendirse', () => {
    // «Racion» es legible; «Raci?n» no. La degradación ordenada importa.
    // Ẽ no está en CP850 pero su base E sí.
    expect([...encodeCp850('Ẽ')]).toEqual([0x45]);
  });

  it('lo que no tiene equivalente acaba en «?» y no rompe el ticket', () => {
    // Un emoji en el nombre de un producto pasa de verdad.
    const bytes = [...encodeCp850('🍗')];
    expect(bytes.every((b) => b <= 0xff)).toBe(true);
    expect(bytes).toContain(0x3f);
  });

  it('el salto de línea se normaliza a CRLF', () => {
    // Muchas térmicas ignoran un LF suelto y acaban imprimiendo el ticket
    // entero en una sola línea larguísima.
    expect([...encodeCp850('a\nb')]).toEqual([0x61, 0x0d, 0x0a, 0x62]);
    expect([...encodeCp850('a\r\nb')]).toEqual([0x61, 0x0d, 0x0a, 0x62]);
  });
});

describe('Ajuste de columnas', () => {
  it('rellena hasta el ancho pedido', () => {
    expect(fitWidth('Pollo', 10)).toBe('Pollo     ');
  });

  it('recorta lo que no cabe', () => {
    expect(fitWidth('Pollo a la brasa entero', 10)).toBe('Pollo a la');
  });

  it('cuenta CARACTERES y no bytes', () => {
    // Contar bytes desalinearía cualquier línea con acento, que en un menú en
    // español es casi cualquiera.
    expect(fitWidth('Ración', 10)).toHaveLength(10);
    expect(fitWidth('Ñoquis', 8)).toBe('Ñoquis  ');
  });

  it('normaliza los espacios sobrantes', () => {
    expect(fitWidth('Pollo    a   la brasa', 21)).toBe('Pollo a la brasa     ');
  });
});

describe('Dos columnas (concepto e importe)', () => {
  it('pega el importe al margen derecho', () => {
    const linea = twoColumns('Subtotal', 'S/ 38.00', 32);
    expect(linea).toHaveLength(32);
    expect(linea.endsWith('S/ 38.00')).toBe(true);
    expect(linea.startsWith('Subtotal')).toBe(true);
  });

  it('el IMPORTE nunca se recorta: se recorta el concepto', () => {
    // Es el dato por el que existe la línea. Un total a medias es peor que un
    // nombre de producto abreviado.
    const linea = twoColumns(
      'Pollo a la brasa entero con papas y ensalada',
      'S/ 135.00',
      32,
    );
    expect(linea).toHaveLength(32);
    expect(linea.endsWith('S/ 135.00')).toBe(true);
  });

  it('deja al menos un espacio entre concepto e importe', () => {
    const linea = twoColumns('12345678901234567890123', 'S/ 1.00', 24);
    expect(linea).toMatch(/ S\/ 1\.00$/);
  });
});
