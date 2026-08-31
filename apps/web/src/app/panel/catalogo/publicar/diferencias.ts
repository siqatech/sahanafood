/**
 * Lo que cambia entre dos versiones de la carta, dicho en palabras.
 *
 * El diff crudo —`added`, `removed`, `changed` con pares campo/antes/después—
 * es lo que necesita el POS para aplicarlo. Un dueño necesita otra cosa: **qué
 * va a notar el cliente**. Publicar empuja la carta a los canales, y la
 * pregunta antes de pulsar es «¿qué estoy cambiando?», no «¿qué claves difieren
 * en el JSON?».
 *
 * Va aparte de la pantalla porque es la única parte con reglas, y porque la
 * traducción de nombres de campo es exactamente el sitio donde se cuela un
 * `priceMinor` delante de alguien que no sabe qué es.
 */

export interface CambioDeCampo {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ProductoCambiado {
  id: string;
  name: string;
  changes: CambioDeCampo[];
}

export interface DiferenciaDeCarta {
  added: Array<{ id: string; name: string; priceMinor?: number }>;
  removed: Array<{ id: string; name: string; priceMinor?: number }>;
  changed: ProductoCambiado[];
  identical: boolean;
}

/** El nombre del campo, en el idioma de quien vende. */
const CAMPOS: Record<string, string> = {
  name: 'nombre',
  priceMinor: 'precio',
  available: 'disponibilidad',
  description: 'descripción',
  categoryId: 'sección',
  prepMinutes: 'tiempo de preparación',
  isCombo: 'combo',
};

export function rotuloDeCampo(field: string): string {
  return CAMPOS[field] ?? field;
}

/**
 * Un importe en unidades menores, en soles.
 *
 * La escala es 4 —la del dominio— y no 2: dividir entre 100 daría precios cien
 * veces mayores en la pantalla que decide qué se publica.
 */
export function solesDeMenores(minor: number): string {
  return (minor / 10_000).toFixed(2);
}

/** El valor de un campo tal como se lee. */
export function valorLegible(field: string, valor: unknown): string {
  if (valor === null || valor === undefined) return '—';
  if (field === 'priceMinor' && typeof valor === 'number') {
    return `S/ ${solesDeMenores(valor)}`;
  }
  if (typeof valor === 'boolean') return valor ? 'sí' : 'no';
  return String(valor);
}

/**
 * El resumen de una línea: «2 platos nuevos · 1 fuera de carta · 3 con cambios».
 *
 * Se omiten los grupos vacíos en vez de escribir «0 nuevos»: una lista de ceros
 * obliga a leerla entera para encontrar el número que no lo es.
 */
export function resumenDeDiferencias(diff: DiferenciaDeCarta): string {
  if (diff.identical) return 'No hay ningún cambio entre estas dos versiones.';

  const partes: string[] = [];
  if (diff.added.length > 0) {
    partes.push(
      diff.added.length === 1
        ? '1 plato nuevo'
        : `${diff.added.length} platos nuevos`,
    );
  }
  if (diff.removed.length > 0) {
    partes.push(
      diff.removed.length === 1
        ? '1 plato fuera de carta'
        : `${diff.removed.length} platos fuera de carta`,
    );
  }
  if (diff.changed.length > 0) {
    partes.push(
      diff.changed.length === 1
        ? '1 plato con cambios'
        : `${diff.changed.length} platos con cambios`,
    );
  }
  // `identical` es del dominio y manda, pero si llegara en `false` con las tres
  // listas vacías no se inventa un resumen: se dice lo que se sabe.
  if (partes.length === 0) return 'Sin diferencias en lo que ve el cliente.';
  return partes.join(' · ');
}

/**
 * ¿Este cambio toca el precio?
 *
 * Se señala aparte porque es el único que se cobra. Un nombre distinto se
 * corrige mañana; un precio publicado mal se cobra hasta que alguien lo vea.
 */
export function tocaElPrecio(cambio: ProductoCambiado): boolean {
  return cambio.changes.some((c) => c.field === 'priceMinor');
}
