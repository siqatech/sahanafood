/**
 * Lector de CSV para las importaciones de alta (spec 34 §5).
 *
 * No se usa una biblioteca por una razón acotada: lo que hace falta cabe aquí y
 * lo que importa no es el formato, sino **de dónde salen estos archivos**. Los
 * escribe un dueño exportando su Excel, en español, y eso trae tres cosas que
 * una implementación ingenua rompe en silencio:
 *
 *  · **Excel en español exporta con `;`**, no con coma. Con el separador
 *    equivocado el archivo entero se lee como una sola columna.
 *  · **La coma es el separador decimal.** `12,50` son doce soles con cincuenta,
 *    no doce mil quinientos ni un error de formato.
 *  · **Excel escribe un BOM** al principio. Sin quitarlo, el nombre de la
 *    primera columna nunca coincide con nada y el archivo parece no tener esa
 *    columna.
 *
 * Ninguna de las tres da error: dan datos mal. Un precio mal leído se descubre
 * cobrándolo.
 */

/** Una fila, ya asociada a sus cabeceras, con el número de línea del archivo. */
export interface FilaCsv {
  /** Número de línea en el archivo, 1-indexado y contando la cabecera. */
  linea: number;
  valores: Record<string, string>;
}

export interface LecturaCsv {
  cabeceras: string[];
  filas: FilaCsv[];
  /** El separador que se dedujo. Se informa para que se pueda comprobar. */
  separador: string;
}

/**
 * Deduce el separador contando cuál aparece más en la línea de cabeceras.
 *
 * Se mira la cabecera y no todo el archivo porque es la única línea donde no
 * puede haber texto libre: los nombres de columna son nuestros.
 */
function deducirSeparador(cabecera: string): string {
  const candidatos = [';', ',', '\t', '|'];
  let mejor = ',';
  let maximo = 0;
  for (const c of candidatos) {
    const n = cabecera.split(c).length - 1;
    if (n > maximo) {
      maximo = n;
      mejor = c;
    }
  }
  return mejor;
}

/**
 * Divide el texto en celdas respetando comillas.
 *
 * Dentro de comillas, el separador y los saltos de línea son texto. Dos
 * comillas seguidas son una comilla literal — es la convención de Excel, y hace
 * falta para una descripción como «Pollo a la brasa "El Buen Sabor"».
 */
function trocear(texto: string, separador: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let entreComillas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i]!;

    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          celda += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        celda += c;
      }
      continue;
    }

    if (c === '"') {
      entreComillas = true;
    } else if (c === separador) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n') {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else if (c !== '\r') {
      celda += c;
    }
  }

  // La última celda solo cuenta si había algo: un archivo que acaba en salto de
  // línea —lo normal— no tiene una fila vacía al final.
  if (celda !== '' || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}

/**
 * Normaliza un nombre de columna: sin espacios, en minúsculas, con `_`.
 *
 * El BOM que escribe Excel lo quita el `trim()`, porque U+FEFF entra en el
 * conjunto de espacios en blanco de JavaScript. Se dice aquí porque no es
 * evidente y porque la alternativa —añadir un `replace` del BOM «por si
 * acaso»— es código que no hace nada y que da la falsa impresión de que la
 * prueba del BOM lo cubre.
 */
function normalizarCabecera(texto: string): string {
  return texto.trim().toLowerCase().replaceAll(' ', '_');
}

export function leerCsv(contenido: string): LecturaCsv {
  // El BOM lo quita `normalizarCabecera`, que es donde estorba: solo puede
  // aparecer pegado al nombre de la primera columna. Quitarlo también aquí
  // sería una segunda defensa que no defiende de nada y que haría creer que la
  // prueba del BOM cubre las dos.
  const primeraLinea = contenido.split('\n', 1)[0] ?? '';
  const separador = deducirSeparador(primeraLinea);

  const crudas = trocear(contenido, separador);
  if (crudas.length === 0) {
    throw new Error('El archivo CSV está vacío.');
  }

  const cabeceras = crudas[0]!.map(normalizarCabecera);
  const filas: FilaCsv[] = [];

  for (let i = 1; i < crudas.length; i += 1) {
    const celdas = crudas[i]!;
    // Filas en blanco: Excel deja unas cuantas al final de casi cualquier
    // exportación. Saltarlas en silencio es lo correcto; avisar de ellas sería
    // ruido en cada importación.
    if (celdas.every((c) => c.trim() === '')) continue;

    const valores: Record<string, string> = {};
    cabeceras.forEach((nombre, j) => {
      if (nombre !== '') valores[nombre] = (celdas[j] ?? '').trim();
    });
    filas.push({ linea: i + 1, valores });
  }

  return { cabeceras, filas, separador };
}

/**
 * Importe en soles, tal como lo escribió una persona → cadena decimal con punto.
 *
 * Devuelve una CADENA a propósito: el resto del alta convierte a unidades
 * menores con aritmética entera, y meter un `number` por el camino es
 * exactamente lo que CLAUDE.md prohíbe para dinero.
 *
 * Reglas de separadores, que es donde está el peligro:
 *  · Si hay punto Y coma, **el último es el decimal**. Cubre `1.500,00` (es-PE)
 *    y `1,500.00` (en-US) sin tener que preguntar el idioma.
 *  · Si solo hay coma, es el decimal: `12,50` son 12.50. Es lo que exporta
 *    Excel en español, que es de donde va a venir el archivo.
 */
export function importeDeTexto(texto: string, donde: string): string {
  const limpio = texto
    .trim()
    .replace(/\s/g, '')
    .replace(/^S\/\.?/i, '');
  if (limpio === '') {
    throw new Error(`${donde}: falta el importe.`);
  }

  const ultimaComa = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  let normalizado: string;

  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    const decimal = ultimaComa > ultimoPunto ? ',' : '.';
    const miles = decimal === ',' ? '.' : ',';
    normalizado = limpio.replaceAll(miles, '').replace(decimal, '.');
  } else if (ultimaComa >= 0) {
    normalizado = limpio.replace(',', '.');
  } else {
    normalizado = limpio;
  }

  if (!/^-?\d+(\.\d{1,4})?$/.test(normalizado)) {
    throw new Error(
      `${donde}: «${texto}» no es un importe. Se esperaba algo como 12.50 o 12,50, ` +
        'con cuatro decimales como máximo.',
    );
  }
  if (normalizado.startsWith('-')) {
    throw new Error(`${donde}: «${texto}» es negativo.`);
  }
  return normalizado;
}

/** Cantidad de una receta: mismas reglas que un importe, pero puede ser 0. */
export function cantidadDeTexto(texto: string, donde: string): string {
  return importeDeTexto(texto, donde);
}

/** Entero no negativo, para minutos y puntos básicos. */
export function enteroDeTexto(texto: string, donde: string): number {
  const limpio = texto.trim();
  if (!/^\d+$/.test(limpio)) {
    throw new Error(`${donde}: «${texto}» no es un número entero.`);
  }
  return Number(limpio);
}

/** Lista separada por `|`, que es lo que menos estorba dentro de una celda. */
export function listaDeTexto(texto: string): string[] {
  return texto
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t !== '');
}
