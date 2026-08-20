import { panel } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';
import { soles } from '../../caja/dinero';

/**
 * Los pedidos que se están viendo, en CSV (specs/ux/03).
 *
 * Exporta **lo filtrado, no todo**: quien pulsa «Exportar» después de filtrar
 * por «cancelados» quiere los cancelados. Un export que ignora los filtros de
 * la pantalla obliga a repetir el filtrado en Excel y, peor, se parece tanto al
 * bueno que nadie nota la diferencia hasta que ya mandó el archivo.
 *
 * Es una ruta y no una acción de servidor porque lo que se devuelve es un
 * ARCHIVO: una acción no puede poner `content-disposition`, y el navegador
 * necesita esa cabecera para descargar en vez de pintar.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const estado = url.searchParams.get('estado') ?? '';
  const canal = url.searchParams.get('canal') ?? '';

  // El tope es alto pero EXISTE: sin él, un tenant con un año de historia se
  // trae doscientas mil filas a memoria para componer un archivo que nadie va a
  // abrir entero. Cuando haga falta más, es paginación por fechas, no un tope
  // mayor.
  const pedidos = await panel.pedidos({
    limit: 1000,
    ...(q !== '' ? { search: q } : {}),
    ...(estado !== '' ? { status: estado } : {}),
    ...(canal !== '' ? { channel: canal } : {}),
  });

  const csv = aCsv(
    ['Numero', 'Canal', 'Estado', 'Total', 'Moneda', 'Entro'],
    pedidos.map((p) => [
      p.orderNumber,
      p.channel,
      p.status,
      // Formateado igual que en pantalla: dos cifras distintas para el mismo
      // pedido —una en el panel y otra en el archivo— es una llamada de
      // soporte garantizada.
      soles(p.total),
      p.total.currency,
      new Date(p.createdAt).toLocaleString('es-PE', {
        timeZone: 'America/Lima',
      }),
    ]),
  );

  const hoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  return respuestaCsv(`pedidos-${hoy}.csv`, csv);
}
