/**
 * Leer la liquidación que manda la pasarela (spec 10, conciliación).
 *
 * La pasarela deposita una vez por corte y manda un archivo con lo que pagó.
 * Conciliarlo contra los cobros del sistema es lo único que responde a la
 * pregunta que ningún panel contesta hoy: **¿me pagaron lo que dicen?**
 *
 * El archivo es el del proveedor y cada uno tiene el suyo, así que esto no
 * intenta adivinar formatos: acepta un CSV con cabeceras conocidas y **dice qué
 * columna falta** cuando no está. Adivinar la columna del importe es cómo se
 * concilia contra la cifra equivocada sin que nadie lo note.
 *
 * Separador `;`, como el resto del proyecto: es lo que produce un Excel en
 * español, que es de donde va a salir este archivo.
 */

export interface LineaDeLiquidacion {
  /** La referencia del cobro EN LA PASARELA, que es lo que se casa. */
  providerRef: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
}

export interface LiquidacionLeida {
  lines: LineaDeLiquidacion[];
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
}

export type LecturaDeLiquidacion =
  { liquidacion: LiquidacionLeida } | { error: string };

/** Las cabeceras que se esperan, en el orden en que se explican al usuario. */
export const COLUMNAS = ['referencia', 'bruto', 'comision', 'neto'] as const;

/**
 * Un importe del archivo, normalizado a cadena decimal.
 *
 * **No pasa por `Number` en ningún punto.** Es dinero: la coma flotante es
 * exactamente lo que CLAUDE.md prohíbe, y aquí el redondeo se convertiría en
 * una varianza inventada contra la pasarela.
 *
 * Se acepta coma decimal porque un Excel en español la escribe, y el punto de
 * millar porque también lo escribe.
 */
export function importeDeTexto(bruto: string): string | null {
  const limpio = bruto.trim().replace(/\s/g, '');
  if (limpio === '') return null;

  // Con coma decimal, el punto solo puede ser separador de millares.
  const normalizado = limpio.includes(',')
    ? limpio.replace(/\./g, '').replace(',', '.')
    : limpio;

  if (!/^-?\d+(\.\d{1,4})?$/.test(normalizado)) return null;
  return normalizado;
}

/** Suma de cadenas decimales SIN coma flotante: céntimos enteros. */
function sumar(valores: string[]): string {
  let total = 0n;
  for (const v of valores) {
    const negativo = v.startsWith('-');
    const [entero = '0', dec = ''] = (negativo ? v.slice(1) : v).split('.');
    const menores = BigInt(`${entero}${dec.padEnd(4, '0')}`);
    total += negativo ? -menores : menores;
  }
  const negativo = total < 0n;
  const abs = (negativo ? -total : total).toString().padStart(5, '0');
  const entero = abs.slice(0, -4);
  const dec = abs.slice(-4);
  return `${negativo ? '-' : ''}${entero}.${dec}`;
}

/**
 * Lee el archivo. Devuelve las líneas y los totales SUMADOS de ellas.
 *
 * Los totales se calculan, no se piden: el archivo trae su propio total y la
 * conciliación ya comprueba que cuadre con sus líneas (`totalsMatch`). Pedirlo
 * aquí además sería darle a quien importa la oportunidad de teclear otro.
 */
export function leerLiquidacion(texto: string): LecturaDeLiquidacion {
  const lineas = texto
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');

  if (lineas.length < 2) {
    return {
      error: 'El archivo necesita una cabecera y al menos una línea de cobro.',
    };
  }

  const cabecera = lineas[0]!
    .split(';')
    .map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''));
  const indices = COLUMNAS.map((c) => cabecera.indexOf(c));
  const faltan = COLUMNAS.filter((_, i) => indices[i] === -1);
  if (faltan.length > 0) {
    return {
      error: `Al archivo le faltan columnas: ${faltan.join(', ')}. La cabecera tiene que ser ${COLUMNAS.join(';')}.`,
    };
  }

  const filas: LineaDeLiquidacion[] = [];
  for (let i = 1; i < lineas.length; i++) {
    const celdas = lineas[i]!.split(';').map((c) =>
      c.trim().replace(/^"|"$/g, ''),
    );
    const ref = celdas[indices[0]!] ?? '';
    if (ref === '') {
      return { error: `La fila ${i + 1} no trae referencia del cobro.` };
    }

    const importes = [1, 2, 3].map((n) =>
      importeDeTexto(celdas[indices[n]!] ?? ''),
    );
    const malo = importes.findIndex((v) => v === null);
    if (malo !== -1) {
      return {
        error: `La fila ${i + 1} tiene un importe que no se entiende en la columna "${COLUMNAS[malo + 1]}".`,
      };
    }

    filas.push({
      providerRef: ref,
      grossAmount: importes[0]!,
      feeAmount: importes[1]!,
      netAmount: importes[2]!,
    });
  }

  // Referencias repetidas: la pasarela no debería mandarlas, y si lo hace se
  // conciliaría dos veces el mismo cobro. Se para antes de importar.
  const vistas = new Set<string>();
  for (const f of filas) {
    if (vistas.has(f.providerRef)) {
      return {
        error: `La referencia "${f.providerRef}" aparece dos veces: el mismo cobro se conciliaría por duplicado.`,
      };
    }
    vistas.add(f.providerRef);
  }

  return {
    liquidacion: {
      lines: filas,
      grossAmount: sumar(filas.map((f) => f.grossAmount)),
      feeAmount: sumar(filas.map((f) => f.feeAmount)),
      netAmount: sumar(filas.map((f) => f.netAmount)),
    },
  };
}
