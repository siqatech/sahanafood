import { panel } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';
import { filasDeCarta } from './filas';

/**
 * La carta en CSV, en el formato que lee el importador (docs/26: «exportar
 * todo… la ausencia de lock-in es argumento de venta»).
 *
 * Cuelga de una marca porque la carta cuelga de una marca: dos marcas en la
 * misma cocina tienen dos cartas, y juntarlas en un archivo daría un documento
 * que no se puede reimportar en ninguna de las dos.
 */
export async function GET(peticion: Request): Promise<Response> {
  const marca = new URL(peticion.url).searchParams.get('marca');
  if (!marca) {
    // 400 y no una carta vacía: sin marca no hay nada que exportar, y un
    // archivo de cero filas se lee como «no tengo productos».
    return new Response('Falta la marca.', { status: 400 });
  }

  const productos = await panel.productos(marca);
  const { cabeceras, filas } = filasDeCarta(productos);

  const hoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  return respuestaCsv(`carta-${hoy}.csv`, aCsv(cabeceras, filas));
}
