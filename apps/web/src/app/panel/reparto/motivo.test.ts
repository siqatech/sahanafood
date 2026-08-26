import { describe, it, expect } from 'vitest';
import { revisarMotivo, MOTIVOS_FRECUENTES, MOTIVO_MAXIMO } from './motivo';

/**
 * El motivo de una entrega fallida.
 *
 * Lo que se defiende aquí no es el formato: es que quien despacha reciba una
 * frase que le diga qué escribir, en vez del `400` del servidor, y que lo que
 * se guarde se pueda leer después en una tabla.
 */

describe('revisarMotivo', () => {
  it('acepta un motivo normal y lo devuelve limpio', () => {
    expect(revisarMotivo('  El cliente no estaba  ')).toEqual({
      motivo: 'El cliente no estaba',
    });
  });

  it('junta los saltos de línea y los espacios de más', () => {
    // Se escribe con una mano y el teléfono en la otra: llegan saltos de línea
    // y espacios dobles. La lista de fallos se lee en una tabla.
    expect(revisarMotivo('No\n contesta   el\tteléfono')).toEqual({
      motivo: 'No contesta el teléfono',
    });
  });

  it('un motivo vacío dice qué hacer, no «campo requerido»', () => {
    const r = revisarMotivo('   ');
    expect('error' in r && r.error).toContain('Escribe qué pasó');
  });

  it('rechaza lo que el servidor rechazaría, antes de mandarlo', () => {
    // El servidor exige tres caracteres. Descubrirlo con un error del servidor
    // en mitad del servicio no ayuda a nadie.
    expect('error' in revisarMotivo('no')).toBe(true);
    expect('motivo' in revisarMotivo('mal')).toBe(true);
  });

  it('rechaza pasarse del máximo del servidor', () => {
    const r = revisarMotivo('x'.repeat(MOTIVO_MAXIMO + 1));
    expect('error' in r && r.error).toContain(String(MOTIVO_MAXIMO));
    expect('motivo' in revisarMotivo('x'.repeat(MOTIVO_MAXIMO))).toBe(true);
  });

  it('null y undefined no revientan: son un motivo vacío', () => {
    expect('error' in revisarMotivo(null)).toBe(true);
    expect('error' in revisarMotivo(undefined)).toBe(true);
  });

  it('todas las sugerencias que se ofrecen son motivos válidos', () => {
    // Una sugerencia que el propio validador rechaza es una trampa: se elige
    // del desplegable y el envío falla.
    for (const m of MOTIVOS_FRECUENTES) {
      expect(revisarMotivo(m)).toEqual({ motivo: m });
    }
  });
});
