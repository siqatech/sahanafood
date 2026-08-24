import type { ProductoDelPanel } from '../../../../lib/panel-api';

/**
 * La carta en filas, en el MISMO formato que lee el importador.
 *
 * Es la propiedad que da valor a esto: lo que sale se puede volver a meter.
 * Exportas, corriges cincuenta precios en Excel, pegas de vuelta y ves qué
 * cambia antes de aplicarlo. Un export con otras columnas que las de la
 * importación sería un archivo para mirar, no para trabajar — y «exportar todo»
 * está en docs/26 como argumento contra el lock-in, no como adorno.
 *
 * Por eso las cabeceras son las del importador (`sku`, `nombre`, `categoria`,
 * `precio_base`, `precio_<canal>`) y no rótulos bonitos en castellano: el
 * archivo lo lee una persona, pero también lo lee el importador.
 *
 * ## Lo que NO cabe en este formato
 *
 * Los precios **por local**. El formato es plano —una fila por producto— y no
 * tiene dónde poner «este plato cuesta distinto en Miraflores». Se exportan los
 * precios que valen para todos los locales; los de un local concreto se quedan
 * fuera y por eso la función los CUENTA, para que la pantalla pueda decirlo. Un
 * export que se calla lo que dejó fuera es peor que uno que no lo exporta,
 * porque quien lo reimporta cree que está aplicando la carta entera.
 */

export interface CartaEnFilas {
  cabeceras: string[];
  filas: string[][];
  /** Productos con algún precio propio de un local, que aquí no cabe. */
  conPrecioPorLocal: number;
}

const FIJAS = ['sku', 'nombre', 'categoria', 'minutos_preparacion', 'activo'];

/** El nombre de columna del importador para un canal. */
function columnaDePrecio(canal: string | null): string {
  return canal === null ? 'precio_base' : `precio_${canal}`;
}

export function filasDeCarta(productos: ProductoDelPanel[]): CartaEnFilas {
  // Primero se recorren TODOS los productos para saber qué columnas de precio
  // existen: si se fueran añadiendo al vuelo, cada fila tendría un número
  // distinto de celdas y el CSV saldría descuadrado.
  const canales = new Set<string>();
  let conPrecioPorLocal = 0;

  for (const p of productos) {
    let tienePorLocal = false;
    for (const precio of p.prices) {
      if (!precio.active) continue;
      if (precio.locationId !== null) {
        tienePorLocal = true;
        continue;
      }
      canales.add(columnaDePrecio(precio.channel));
    }
    if (tienePorLocal) conPrecioPorLocal += 1;
  }

  // `precio_base` primero y el resto alfabético: el orden estable importa
  // porque quien compara dos exports de semanas distintas lo hace en Excel.
  const columnasDePrecio = [...canales].sort((a, b) => {
    if (a === 'precio_base') return -1;
    if (b === 'precio_base') return 1;
    return a.localeCompare(b, 'es');
  });

  const filas = productos.map((p) => {
    const porColumna = new Map<string, string>();
    for (const precio of p.prices) {
      if (!precio.active || precio.locationId !== null) continue;
      porColumna.set(columnaDePrecio(precio.channel), precio.price);
    }

    return [
      p.sku ?? '',
      p.name,
      p.categoryName ?? '',
      String(p.prepMinutes),
      // «SI»/«NO» y no true/false: lo lee una persona, y el importador entiende
      // las dos formas.
      p.active ? 'SI' : 'NO',
      ...columnasDePrecio.map((c) => porColumna.get(c) ?? ''),
    ];
  });

  return {
    cabeceras: [...FIJAS, ...columnasDePrecio],
    filas,
    conPrecioPorLocal,
  };
}
