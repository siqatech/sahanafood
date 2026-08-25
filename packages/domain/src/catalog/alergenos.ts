/**
 * Alérgenos declarados de un plato.
 *
 * ## Por qué hace falta una función y no un `as string[]`
 *
 * La columna es `jsonb`, así que lo que llega es literalmente **desconocido**:
 * lo escribe el panel, el importador de Excel o una carta que alguien pegó, y
 * cualquiera de esos caminos puede dejar un número, una cadena suelta o un nulo
 * dentro del array. Un `as string[]` haría que la pantalla reventara al pintar,
 * y la pantalla que revienta aquí es la que le dice a alguien si el plato lleva
 * maní.
 *
 * ## La regla al normalizar: ante la duda, NO callarse
 *
 * Se descarta lo que no es texto útil, pero **nunca se inventa** ni se rellena.
 * Si el dato viene roto, sale la lista vacía —y la pantalla dirá que el
 * restaurante no ha declarado alérgenos, que es la verdad— en vez de una lista
 * a medias que se lee como completa. Media lista de alérgenos es peor que
 * ninguna: la primera se cree.
 */

/** Normaliza el `jsonb` a una lista de textos limpia, sin duplicados. */
export function alergenosDe(valor: unknown): string[] {
  if (!Array.isArray(valor)) return [];

  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const bruto of valor) {
    if (typeof bruto !== 'string') continue;
    const limpio = bruto.trim();
    if (limpio === '') continue;
    // Sin duplicados, comparando sin distinguir mayúsculas: «Maní» y «maní»
    // son el mismo alérgeno escrito por dos personas distintas.
    const clave = limpio.toLocaleLowerCase('es');
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(limpio);
  }
  return salida;
}

/**
 * El texto de aviso, tal cual lo lee un cliente.
 *
 * Se construye aquí y no en cada pantalla porque lo van a enseñar la tienda, el
 * POS y la comanda de cocina, y tres redacciones distintas del mismo aviso es
 * como una acaba diciendo menos que las otras.
 */
export function avisoDeAlergenos(alergenos: readonly string[]): string | null {
  if (alergenos.length === 0) return null;
  return `Contiene ${alergenos.join(', ')}.`;
}
