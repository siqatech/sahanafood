/**
 * Exportar a CSV (specs/ux/03: «todo listado: … export CSV»).
 *
 * ### El separador es `;` y no `,`
 *
 * Este archivo lo va a abrir alguien con Excel en español, no un script. Excel
 * en configuración regional española/peruana usa `;` como separador de lista:
 * con comas, las 200 filas caen todas en la columna A y la reacción es «el
 * export está roto». Es la otra cara del mismo problema que ya trata el
 * importador de carta, que acepta `;` porque es lo que Excel produce.
 *
 * ### Lleva BOM
 *
 * Sin él, Excel lee el archivo como Latin-1 y «Pollería» sale «PollerÃ­a». Tres
 * bytes evitan que el primer contacto con el export sea una pantalla de acentos
 * rotos.
 *
 * ### Los importes van con punto decimal
 *
 * Deliberado y con su coste: en un Excel en español entran como TEXTO y hay que
 * convertirlos para sumarlos. La alternativa —coma decimal— los hace sumables
 * en ese Excel y los rompe en cualquier otra herramienta, y sobre todo entra en
 * conflicto con el separador. Se prefiere el valor inequívoco.
 */

/**
 * Escapa una celda.
 *
 * Un nombre de cliente con `;`, un salto de línea en una nota de cocina o unas
 * comillas en «Pollo "a la brasa"» rompen el archivo entero —desplazan todas
 * las columnas siguientes— y el fallo aparece en la fila 87 de un archivo que
 * alguien ya está usando para declarar impuestos.
 */
function celda(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor);
  if (!/[;"\n\r]/.test(texto)) return texto;
  // Comillas dobles duplicadas: es lo que dice RFC 4180 y lo que entienden
  // Excel, Sheets y cualquier lector.
  return `"${texto.replace(/"/g, '""')}"`;
}

/** Cabecera + filas a texto CSV, con BOM. */
export function aCsv(
  cabeceras: string[],
  filas: Array<Array<string | number | null | undefined>>,
): string {
  const lineas = [
    cabeceras.map(celda).join(';'),
    ...filas.map((f) => f.map(celda).join(';')),
  ];
  // CRLF: es lo que pide RFC 4180 y lo que menos sorpresas da en Windows.
  // El BOM va como escape y no como carácter literal: en el archivo fuente es
  // invisible, y un carácter invisible al principio de una plantilla es
  // exactamente lo que nadie encuentra cuando algo va mal.
  return `\uFEFF${lineas.join('\r\n')}\r\n`;
}

/**
 * La respuesta de descarga.
 *
 * El nombre lleva la fecha porque estos archivos acaban todos en la carpeta de
 * descargas: «pedidos.csv», «pedidos (1).csv», «pedidos (2).csv» y ya nadie
 * sabe cuál es de cuándo.
 */
export function respuestaCsv(nombre: string, contenido: string): Response {
  return new Response(contenido, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${nombre}"`,
      // Un export cacheado devuelve las ventas de ayer con la fecha de hoy.
      'cache-control': 'no-store',
    },
  });
}
