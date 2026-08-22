import { panel, type LineaDeAuditoria } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';

/**
 * El histórico, en CSV.
 *
 * Es el archivo que se entrega cuando alguien pregunta quién tocó qué: un
 * auditor, el contador, o el propio dueño repasando un descuadre de hace tres
 * meses. Que solo se pudiera leer en pantalla, cien líneas por vez, convertía
 * una tabla append-only en algo que en la práctica nadie revisaba.
 *
 * Trae **el filtro que hay puesto**, igual que el de pedidos: quien exporta
 * después de filtrar por «descuadres» quiere los descuadres.
 */

/** El `data` de la línea, aplanado a una celda legible. */
function detalle(linea: LineaDeAuditoria): string {
  return Object.entries(linea.data)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const accion = url.searchParams.get('accion') ?? '';

  const lineas = await panel.auditoria({
    ...(accion !== '' ? { action: accion } : {}),
    // Más que en pantalla: la pantalla se lee y el archivo se guarda. El tope
    // sigue existiendo por el mismo motivo que en pedidos — cuando haga falta
    // más, es paginación por fechas, no un número mayor.
    limit: 1000,
  });

  const csv = aCsv(
    [
      'Cuando',
      'Quien',
      'Tipo de actor',
      'Accion',
      'Sobre',
      'Id',
      'Motivo',
      'Detalle',
    ],
    lineas.map((l) => [
      new Date(l.occurredAt).toLocaleString('es-PE', {
        timeZone: 'America/Lima',
      }),
      // El mismo criterio que la pantalla: nunca un UUID donde se espera un
      // nombre. Un archivo lleno de identificadores no lo lee nadie.
      l.actorType === 'system'
        ? 'Sistema'
        : (l.actorName ?? (l.actorId ? 'Cuenta dada de baja' : 'Sin actor')),
      l.actorType,
      l.action,
      l.resourceType,
      l.resourceId ?? '',
      // El motivo escrito es media razón de que exista el histórico: «anulado»
      // no explica nada y «RUC mal digitado» se explica solo.
      l.reason ?? '',
      detalle(l),
    ]),
  );

  const hoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  return respuestaCsv(
    accion === '' ? `historico-${hoy}.csv` : `historico-${accion}-${hoy}.csv`,
    csv,
  );
}
