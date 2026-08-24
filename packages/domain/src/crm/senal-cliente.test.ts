import { describe, it, expect } from 'vitest';
import {
  senalDeCliente,
  rotuloDeSenal,
  PEDIDOS_PARA_FRECUENTE,
} from './senal-cliente.js';

describe('senalDeCliente', () => {
  it('el primer pedido es «primera compra»', () => {
    expect(senalDeCliente(1)).toBe('primera');
  });

  it('a partir del umbral es «frecuente»', () => {
    expect(senalDeCliente(PEDIDOS_PARA_FRECUENTE)).toBe('frecuente');
    expect(senalDeCliente(PEDIDOS_PARA_FRECUENTE + 40)).toBe('frecuente');
  });

  it('en medio NO dice nada, que es lo correcto', () => {
    // Un badge en cada pedido no informa de nada: si todos llevan etiqueta,
    // la etiqueta deja de significar «este es distinto».
    for (let n = 2; n < PEDIDOS_PARA_FRECUENTE; n += 1) {
      expect(senalDeCliente(n)).toBeNull();
    }
  });

  it('SIN TELÉFONO se calla, y no dice «primera compra»', () => {
    // Es la distinción que importa: en mostrador casi nunca hay teléfono, y
    // marcar cada venta de mostrador como «primera compra» sería mentir sobre
    // el 80 % de los pedidos de un local con caja.
    expect(senalDeCliente(null)).toBeNull();
    expect(senalDeCliente(undefined)).toBeNull();
  });

  it('un conteo imposible se calla en vez de inventar', () => {
    // Este pedido ya cuenta, así que cero no debería llegar nunca. Si llega,
    // el dato está mal y anunciar algo sobre él sería propagarlo.
    expect(senalDeCliente(0)).toBeNull();
    expect(senalDeCliente(-3)).toBeNull();
  });
});

describe('rotuloDeSenal', () => {
  it('da el texto corto de cada señal', () => {
    expect(rotuloDeSenal('primera')).toBe('Primera compra');
    expect(rotuloDeSenal('frecuente')).toBe('Cliente frecuente');
  });

  it('sin señal no hay rótulo', () => {
    expect(rotuloDeSenal(null)).toBeNull();
  });
});
