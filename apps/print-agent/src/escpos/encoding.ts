/**
 * Codificación de texto para impresoras térmicas.
 *
 * Este archivo existe por un detalle que se descubre tarde y en el peor
 * momento: las impresoras ESC/POS **no hablan UTF-8**. Trabajan con «code
 * pages» de un byte. Mandar UTF-8 directo hace que «Ración» salga como
 * «RaciÃ³n» y que «S/ 38,00» pierda la barra en algunos modelos. En una
 * comanda de cocina eso es una molestia; en una precuenta que ve el cliente,
 * es una impresión mal hecha con el logo del negocio encima.
 *
 * Se usa CP850 (Europa occidental) porque es la que traen prácticamente todas
 * las térmicas del mercado peruano y cubre el español completo. Cuando un
 * carácter no existe en la tabla —un emoji en el nombre de un producto, que
 * pasa— se degrada a su equivalente sin acento antes de rendirse a `?`:
 * «Ración» impresa como «Racion» es legible; como «Raci?n», no.
 */

/** Selecciona la tabla de caracteres: ESC t n. CP850 es n = 2. */
export const CODE_PAGE_CP850 = 2;

/**
 * Caracteres del español (y algún signo habitual) con su byte en CP850.
 * Solo lo que de verdad aparece en un menú: la tabla completa sería ruido.
 */
const CP850: ReadonlyMap<string, number> = new Map([
  ['Ç', 0x80],
  ['ü', 0x81],
  ['é', 0x82],
  ['â', 0x83],
  ['ä', 0x84],
  ['à', 0x85],
  ['ç', 0x87],
  ['ê', 0x88],
  ['ë', 0x89],
  ['è', 0x8a],
  ['ï', 0x8b],
  ['î', 0x8c],
  ['ì', 0x8d],
  ['Ä', 0x8e],
  ['É', 0x90],
  ['ô', 0x93],
  ['ö', 0x94],
  ['ò', 0x95],
  ['û', 0x96],
  ['ù', 0x97],
  ['Ö', 0x99],
  ['Ü', 0x9a],
  ['ø', 0x9b],
  ['×', 0x9e],
  ['á', 0xa0],
  ['í', 0xa1],
  ['ó', 0xa2],
  ['ú', 0xa3],
  ['ñ', 0xa4],
  ['Ñ', 0xa5],
  ['ª', 0xa6],
  ['º', 0xa7],
  ['¿', 0xa8],
  ['®', 0xa9],
  ['¬', 0xaa],
  ['½', 0xab],
  ['¼', 0xac],
  ['¡', 0xad],
  ['«', 0xae],
  ['»', 0xaf],
  ['Á', 0xb5],
  ['Â', 0xb6],
  ['À', 0xb7],
  ['©', 0xb8],
  ['¢', 0xbd],
  ['¥', 0xbe],
  ['ã', 0xc6],
  ['Ã', 0xc7],
  ['ð', 0xd0],
  ['Ð', 0xd1],
  ['Ê', 0xd2],
  ['Ë', 0xd3],
  ['È', 0xd4],
  ['Í', 0xd6],
  ['Î', 0xd7],
  ['Ï', 0xd8],
  ['Ó', 0xe0],
  ['ß', 0xe1],
  ['Ô', 0xe2],
  ['Ò', 0xe3],
  ['õ', 0xe4],
  ['Õ', 0xe5],
  ['µ', 0xe6],
  ['Ú', 0xe9],
  ['Û', 0xea],
  ['Ù', 0xeb],
  ['ý', 0xec],
  ['Ý', 0xed],
  ['´', 0xef],
  ['±', 0xf1],
  ['¾', 0xf3],
  ['¶', 0xf4],
  ['§', 0xf5],
  ['÷', 0xf6],
  ['°', 0xf8],
  ['·', 0xfa],
  ['¹', 0xfb],
  ['³', 0xfc],
  ['²', 0xfd],
]);

/**
 * Último recurso antes del `?`. Quitar la tilde conserva la palabra; el signo
 * de interrogación la destruye.
 */
function stripAccents(char: string): string {
  return char.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Byte de reemplazo cuando ni siquiera queda una letra reconocible. */
const REPLACEMENT = 0x3f; // '?'

/**
 * Convierte una cadena a bytes CP850.
 *
 * El salto de línea se normaliza a CRLF: muchas térmicas ignoran un LF suelto
 * y acaban imprimiendo todo el ticket en una sola línea larguísima.
 */
export function encodeCp850(text: string): Buffer {
  const bytes: number[] = [];

  for (const char of text.replace(/\r\n/g, '\n')) {
    if (char === '\n') {
      bytes.push(0x0d, 0x0a);
      continue;
    }

    const code = char.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }

    const directo = CP850.get(char);
    if (directo !== undefined) {
      bytes.push(directo);
      continue;
    }

    // Degradación ordenada: primero sin tilde, y solo entonces '?'.
    const sinTilde = stripAccents(char);
    if (sinTilde !== char && sinTilde.length > 0) {
      for (const c of sinTilde) {
        const p = c.codePointAt(0)!;
        bytes.push(p < 0x80 ? p : (CP850.get(c) ?? REPLACEMENT));
      }
      continue;
    }
    bytes.push(REPLACEMENT);
  }

  return Buffer.from(bytes);
}

/**
 * Recorta o rellena a un ancho fijo, contando CARACTERES y no bytes.
 *
 * Se usa para las columnas del ticket. Contar bytes desalinearía cualquier
 * línea con un acento, que en un menú en español es casi cualquiera.
 */
export function fitWidth(text: string, width: number): string {
  const limpio = text.replace(/\s+/g, ' ').trim();
  const chars = [...limpio];
  if (chars.length >= width) return chars.slice(0, width).join('');
  return limpio + ' '.repeat(width - chars.length);
}

/** Texto a la izquierda y a la derecha, separados por relleno hasta el ancho. */
export function twoColumns(left: string, right: string, width: number): string {
  const derecha = [...right];
  // El importe nunca se recorta: es el dato por el que existe la línea.
  const espacioIzquierda = Math.max(0, width - derecha.length - 1);
  const izquierda = [...left].slice(0, espacioIzquierda).join('');
  const relleno = Math.max(1, width - [...izquierda].length - derecha.length);
  return izquierda + ' '.repeat(relleno) + right;
}
