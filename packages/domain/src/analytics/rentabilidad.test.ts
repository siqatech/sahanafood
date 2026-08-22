import { describe, it, expect } from 'vitest';
import {
  totalizarRentabilidad,
  pesoEnPuntosBasicos,
  type FilaDeRentabilidad,
} from './rentabilidad.js';

/**
 * Lo que se prueba es que el total **no mienta**. Es el número con el que un
 * dueño decide si cierra una marca o se sale de un marketplace, y las dos
 * formas de que salga mal —coma flotante y promediar porcentajes— dan las dos
 * un resultado plausible, que es lo que las hace peligrosas.
 */
function fila(p: Partial<FilaDeRentabilidad> = {}): FilaDeRentabilidad {
  return {
    orders: 0,
    cancelled: 0,
    grossRevenue: '0.0000',
    discounts: '0.0000',
    netRevenue: '0.0000',
    commission: '0.0000',
    foodCost: '0.0000',
    contributionMargin: '0.0000',
    ...p,
  };
}

describe('totalizarRentabilidad', () => {
  it('suma las columnas EXACTAMENTE, sin el error de la coma flotante', () => {
    // 0.1 + 0.2 en coma flotante da 0.30000000000000004. Con tres filas de
    // céntimos que en binario no son exactos, el total se desvía y el informe
    // no cuadra con la suma que el contador hace a mano.
    const total = totalizarRentabilidad([
      fila({ netRevenue: '0.1000', contributionMargin: '0.1000' }),
      fila({ netRevenue: '0.2000', contributionMargin: '0.2000' }),
      fila({ netRevenue: '0.3000', contributionMargin: '0.3000' }),
    ]);
    expect(total.netRevenue).toBe('0.6000');
    expect(total.contributionMargin).toBe('0.6000');
  });

  it('el PORCENTAJE se recalcula sobre los totales, no se promedia', () => {
    // El error que esta prueba impide: promediar los porcentajes de fila daría
    // (60 % + 5 %) / 2 = 32,5 %, un número plausible y falso. La marca de dos
    // pedidos no pesa lo mismo que la de doscientos.
    const total = totalizarRentabilidad([
      // 60 % de margen sobre 10.
      fila({
        orders: 2,
        netRevenue: '10.0000',
        contributionMargin: '6.0000',
      }),
      // 5 % de margen sobre 1000.
      fila({
        orders: 200,
        netRevenue: '1000.0000',
        contributionMargin: '50.0000',
      }),
    ]);
    expect(total.netRevenue).toBe('1010.0000');
    expect(total.contributionMargin).toBe('56.0000');
    // 56 / 1010 = 5,544 %, no 32,5 %.
    expect(total.marginBps).toBe(554);
  });

  it('el TICKET es el neto total entre los pedidos totales', () => {
    // No la media de las medias, por la misma razón que el porcentaje.
    const total = totalizarRentabilidad([
      fila({ orders: 1, netRevenue: '100.0000' }),
      fila({ orders: 9, netRevenue: '900.0000' }),
    ]);
    expect(total.orders).toBe(10);
    expect(total.averageTicket).toBe('100.0000');
  });

  it('un margen NEGATIVO resta de verdad', () => {
    // Una marca que pierde dinero tiene que bajar el total, no ignorarse.
    const total = totalizarRentabilidad([
      fila({ netRevenue: '100.0000', contributionMargin: '30.0000' }),
      fila({ netRevenue: '50.0000', contributionMargin: '-20.0000' }),
    ]);
    expect(total.contributionMargin).toBe('10.0000');
    expect(total.marginBps).toBe(667); // 10 / 150
  });

  it('sin filas devuelve ceros y NO revienta', () => {
    // Un rango sin ventas es un lunes de enero, no un error.
    const total = totalizarRentabilidad([]);
    expect(total.netRevenue).toBe('0.0000');
    expect(total.orders).toBe(0);
    expect(total.marginBps).toBe(0);
    expect(total.averageTicket).toBe('0.0000');
  });

  it('con neto CERO el porcentaje es cero, no infinito', () => {
    const total = totalizarRentabilidad([
      fila({ orders: 3, netRevenue: '0.0000', contributionMargin: '-5.0000' }),
    ]);
    expect(total.marginBps).toBe(0);
  });

  it('los cancelados se suman aparte de los pedidos', () => {
    const total = totalizarRentabilidad([
      fila({ orders: 10, cancelled: 1 }),
      fila({ orders: 5, cancelled: 2 }),
    ]);
    expect(total.orders).toBe(15);
    expect(total.cancelled).toBe(3);
  });
});

describe('pesoEnPuntosBasicos', () => {
  it('la parte sobre el total, en puntos básicos', () => {
    expect(pesoEnPuntosBasicos('25.0000', '100.0000')).toBe(2500);
    expect(pesoEnPuntosBasicos('100.0000', '100.0000')).toBe(10_000);
  });

  it('con total cero es cero, no NaN ni una barra llena', () => {
    expect(pesoEnPuntosBasicos('10.0000', '0.0000')).toBe(0);
  });

  it('una parte negativa no pinta barra hacia atrás', () => {
    expect(pesoEnPuntosBasicos('-10.0000', '100.0000')).toBe(0);
  });
});
