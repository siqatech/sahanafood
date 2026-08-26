import { describe, it, expect } from 'vitest';
import { filasDeCarta } from './filas';
import type { ProductoDelPanel } from '../../../../lib/panel-api';

const producto = (over: Partial<ProductoDelPanel> = {}): ProductoDelPanel => ({
  id: 'p1',
  categoryId: 'c1',
  categoryName: 'Pollos',
  sku: 'POLLO-1',
  name: 'Pollo a la brasa',
  active: true,
  isCombo: false,
  prepMinutes: 25,
  imageUrl: null,
  rowVersion: 1,
  prices: [{ channel: null, locationId: null, price: '55.0000', active: true }],
  pauses: [],
  modifierGroupIds: [],
  ...over,
});

describe('filasDeCarta', () => {
  it('usa las cabeceras del IMPORTADOR, no rótulos bonitos', () => {
    // Es lo que hace que el archivo se pueda volver a meter: exportas,
    // corriges cincuenta precios en Excel y pegas de vuelta.
    const { cabeceras } = filasDeCarta([producto()]);
    expect(cabeceras.slice(0, 5)).toEqual([
      'sku',
      'nombre',
      'categoria',
      'minutos_preparacion',
      'activo',
    ]);
    expect(cabeceras).toContain('precio_base');
  });

  it('una columna por canal, y TODAS las filas con el mismo ancho', () => {
    // Si las columnas se fueran añadiendo al vuelo, cada fila tendría un
    // número distinto de celdas y el CSV saldría descuadrado en Excel.
    const { cabeceras, filas } = filasDeCarta([
      producto({
        prices: [
          { channel: null, locationId: null, price: '55.0000', active: true },
          { channel: 'web', locationId: null, price: '59.0000', active: true },
        ],
      }),
      producto({
        id: 'p2',
        sku: 'INKA-1',
        name: 'Inka Kola',
        prices: [
          { channel: 'rappi', locationId: null, price: '8.0000', active: true },
        ],
      }),
    ]);

    expect(cabeceras).toEqual([
      'sku',
      'nombre',
      'categoria',
      'minutos_preparacion',
      'activo',
      'precio_base',
      'precio_rappi',
      'precio_web',
    ]);
    for (const f of filas) expect(f).toHaveLength(cabeceras.length);
    // El que no tiene precio en un canal lo deja VACÍO, no en cero: un cero es
    // un precio, y reimportarlo regalaría el plato.
    expect(filas[1]).toEqual([
      'INKA-1',
      'Inka Kola',
      'Pollos',
      '25',
      'SI',
      '',
      '8.0000',
      '',
    ]);
  });

  it('`precio_base` va primero aunque alfabéticamente no toque', () => {
    const { cabeceras } = filasDeCarta([
      producto({
        prices: [
          { channel: 'app', locationId: null, price: '50.0000', active: true },
          { channel: null, locationId: null, price: '55.0000', active: true },
        ],
      }),
    ]);
    expect(cabeceras[5]).toBe('precio_base');
    expect(cabeceras[6]).toBe('precio_app');
  });

  it('los precios INACTIVOS no salen', () => {
    // Un precio desactivado no es el precio del plato; exportarlo y
    // reimportarlo lo resucitaría.
    const { cabeceras, filas } = filasDeCarta([
      producto({
        prices: [
          { channel: null, locationId: null, price: '55.0000', active: true },
          { channel: 'web', locationId: null, price: '99.0000', active: false },
        ],
      }),
    ]);
    expect(cabeceras).not.toContain('precio_web');
    expect(filas[0]).not.toContain('99.0000');
  });

  it('CUENTA los productos con precio por local, que no caben en el formato', () => {
    // El formato es plano y no tiene dónde poner «en Miraflores cuesta otra
    // cosa». Callárselo sería lo peor: quien reimporte creería que está
    // aplicando la carta entera.
    const { filas, conPrecioPorLocal } = filasDeCarta([
      producto({
        prices: [
          { channel: null, locationId: null, price: '55.0000', active: true },
          {
            channel: null,
            locationId: 'loc-2',
            price: '60.0000',
            active: true,
          },
        ],
      }),
      producto({ id: 'p2', name: 'Otro' }),
    ]);

    expect(conPrecioPorLocal).toBe(1);
    // Y el precio del local NO se cuela en la columna general.
    expect(filas[0]).toContain('55.0000');
    expect(filas[0]).not.toContain('60.0000');
  });

  it('un producto sin SKU ni categoría no rompe la fila', () => {
    const { filas } = filasDeCarta([
      producto({ sku: null, categoryName: null, active: false }),
    ]);
    expect(filas[0]!.slice(0, 5)).toEqual([
      '',
      'Pollo a la brasa',
      '',
      '25',
      'NO',
    ]);
  });

  it('sin productos devuelve solo las cabeceras fijas', () => {
    const { cabeceras, filas } = filasDeCarta([]);
    expect(filas).toEqual([]);
    expect(cabeceras).toEqual([
      'sku',
      'nombre',
      'categoria',
      'minutos_preparacion',
      'activo',
    ]);
  });
});
