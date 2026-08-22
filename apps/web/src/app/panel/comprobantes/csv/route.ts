import { panel, type DocumentoDelPanel } from '../../../../lib/panel-api';
import { aCsv, respuestaCsv } from '../../../../lib/csv';
import { solesDeTexto } from '../../caja/dinero';

/**
 * Los comprobantes, en CSV.
 *
 * Es el archivo de fin de mes del contador, y por eso trae **los cuatro
 * estados en un solo archivo** en vez de uno por estado. La razón es la que
 * hace útil la pantalla: un comprobante rechazado o encolado es una venta
 * **sin declarar**, y un export que solo trajera los aceptados enseñaría un
 * mes que cuadra mientras las ventas que faltan se quedan fuera del archivo y
 * fuera de la vista.
 *
 * Cada fila lleva su estado y el motivo del rechazo cuando lo hay: sin eso, la
 * fila que falta obliga a volver a la pantalla a averiguar por qué.
 */

const ROTULO_ESTADO: Record<string, string> = {
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  queued: 'En cola',
  numbered: 'Numerado sin enviar',
};

function cliente(d: DocumentoDelPanel): string {
  if (d.customerName) return d.customerName;
  if (d.customerDocNumber) {
    return `${d.customerDocType} ${d.customerDocNumber}`;
  }
  return 'Consumidor final';
}

export async function GET(): Promise<Response> {
  // En paralelo y tolerante: `numbered` es un estado interno que puede no
  // existir en instalaciones antiguas, y que falte no debe dejar sin archivo a
  // quien sí tiene los otros tres.
  const estados = ['accepted', 'rejected', 'queued', 'numbered'] as const;
  const porEstado = await Promise.all(
    estados.map((e) =>
      panel.documentos(e).catch((): DocumentoDelPanel[] => []),
    ),
  );

  const filas = porEstado
    .flat()
    // Más recientes primero, como la pantalla. Un archivo ordenado al revés
    // que la pantalla obliga a comprobar cada vez cuál es cuál.
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));

  const csv = aCsv(
    [
      'Estado',
      'Tipo',
      'Numero',
      'Cliente',
      'Doc cliente',
      'Total',
      'Emitido',
      'Intentos',
      'Codigo de rechazo',
      'Motivo del rechazo',
    ],
    filas.map((d) => [
      ROTULO_ESTADO[d.status] ?? d.status,
      d.docType,
      d.number ?? '',
      cliente(d),
      d.customerDocNumber ?? '',
      // Formateado igual que en pantalla: dos cifras distintas para el mismo
      // comprobante son una llamada de soporte garantizada.
      solesDeTexto(d.total),
      new Date(d.issuedAt).toLocaleString('es-PE', {
        timeZone: 'America/Lima',
      }),
      d.attempts,
      d.rejectionCode ?? '',
      d.rejectionReason ?? '',
    ]),
  );

  const hoy = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Lima',
  });
  return respuestaCsv(`comprobantes-${hoy}.csv`, csv);
}
