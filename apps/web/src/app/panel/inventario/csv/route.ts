import { panel } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';

/**
 * Las existencias, en CSV.
 *
 * El uso real es el **conteo físico**: se exporta, se imprime, alguien recorre
 * el almacén con el papel y anota lo que hay de verdad, y luego se comparan las
 * dos columnas. De ahí la última columna vacía —«Contado»—: sin ella el papel
 * no sirve para lo único para lo que se imprime.
 *
 * Va todo, no solo lo que está bajo mínimo: un conteo parcial no cuadra nunca.
 */
export async function GET(): Promise<Response> {
  const existencias = await panel.existencias();

  const csv = aCsv(
    [
      'Insumo',
      'Almacen',
      'Unidad',
      'Stock del sistema',
      'Minimo',
      'Bajo minimo',
      'Contado',
    ],
    existencias.map((e) => [
      e.itemName,
      e.warehouseName,
      e.unit,
      // Las cantidades llegan como cadena decimal y salen tal cual: pasarlas
      // por `Number` para «limpiarlas» les quitaría decimales significativos
      // —350 g de un insumo que se mide en kilos es 0.3500— o les metería coma
      // flotante, y este archivo se usa para decidir compras.
      e.quantity,
      e.minStock ?? '',
      e.belowMinimum ? 'SI' : '',
      '',
    ]),
  );

  const hoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  return respuestaCsv(`existencias-${hoy}.csv`, csv);
}
