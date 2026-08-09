/**
 * Qué líneas traía el pedido que el canal mandó y no supimos mapear.
 *
 * El payload es de un tercero: no hay contrato que obligue a nadie a mandar
 * `items[].sku`. Por eso esto es **lectura oportunista** —se prueban las formas
 * que hoy usan los canales conocidos— y la pantalla enseña SIEMPRE el JSON
 * crudo al lado. Adivinar mal y esconder el original dejaría al operador
 * mapeando líneas que el canal nunca mandó.
 */

export interface LineaExterna {
  sku: string;
  cantidad: number;
  /** Lo que el canal llame al plato, si lo manda. Solo para que se lea. */
  nombre: string | null;
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function primeraCadena(
  fila: Record<string, unknown>,
  claves: string[],
): string | null {
  for (const clave of claves) {
    const valor = fila[clave];
    if (typeof valor === 'string' && valor.length > 0) return valor;
  }
  return null;
}

/** Extrae las líneas del payload crudo. Devuelve `[]` si no reconoce la forma. */
export function lineasExternas(raw: unknown): LineaExterna[] {
  const cuerpo = comoObjeto(raw);
  if (!cuerpo) return [];

  // `items` es lo que usa el simulador (spec 13); `lines` y `products` son las
  // otras dos formas habituales. No se inventan más: una clave que no existe
  // devolvería líneas fantasma.
  const bruto =
    cuerpo['items'] ?? cuerpo['lines'] ?? cuerpo['products'] ?? null;
  if (!Array.isArray(bruto)) return [];

  const lineas: LineaExterna[] = [];
  for (const entrada of bruto) {
    const fila = comoObjeto(entrada);
    if (!fila) continue;
    const sku = primeraCadena(fila, ['sku', 'external_sku', 'code', 'id']);
    if (!sku) continue;
    const cantidad = fila['qty'] ?? fila['quantity'] ?? 1;
    lineas.push({
      sku,
      // Una cantidad que no es un entero positivo se enseña como 1 y el
      // operador la corrige: descartar la línea perdería el plato.
      cantidad:
        typeof cantidad === 'number' &&
        Number.isInteger(cantidad) &&
        cantidad > 0
          ? cantidad
          : 1,
      nombre: primeraCadena(fila, ['name', 'title', 'description']),
    });
  }
  return lineas;
}
