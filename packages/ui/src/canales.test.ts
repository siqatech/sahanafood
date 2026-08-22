import { describe, it, expect } from 'vitest';
import { aspectoDeCanal, canalesConocidos } from './canales.js';

/**
 * Lo que se prueba es el caso que rompe la promesa de docs/25: un canal que el
 * sistema no reconoce. Es el único que puede desaparecer de la pantalla sin que
 * nadie lo note, y es justo el que hay que mirar.
 */
describe('aspectoDeCanal', () => {
  it('cada canal conocido trae rótulo en español y su clase de color', () => {
    expect(aspectoDeCanal('rappi')).toEqual({
      rotulo: 'Rappi',
      clase: 'canal--rappi',
    });
    expect(aspectoDeCanal('web').rotulo).toBe('Tienda web');
    expect(aspectoDeCanal('pos').rotulo).toBe('Mostrador');
  });

  it('un canal DESCONOCIDO enseña su identificador crudo, no se esconde', () => {
    // Un pedido cuyo origen no sabemos es el que más falta hace mirar.
    // Inventarle un nombre bonito escondería que el sistema no lo reconoce.
    expect(aspectoDeCanal('glovo')).toEqual({
      rotulo: 'glovo',
      clase: 'canal--otro',
    });
  });

  it('la cadena vacía tampoco revienta ni pinta una píldora fantasma', () => {
    expect(aspectoDeCanal('').clase).toBe('canal--otro');
  });

  it('cada canal conocido tiene una clase DISTINTA', () => {
    // Dos canales del mismo color son dos canales que el operador no distingue,
    // que es exactamente lo que este archivo existe para evitar.
    const clases = canalesConocidos().map((c) => c.clase);
    expect(new Set(clases).size).toBe(clases.length);
  });

  it('los cinco canales de docs/25 están', () => {
    const ids = canalesConocidos().map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(['web', 'pos', 'whatsapp', 'rappi', 'pedidosya']),
    );
  });
});
