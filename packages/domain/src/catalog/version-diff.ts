/**
 * Comparación entre dos versiones publicadas del catálogo (spec 04, aceptación:
 * «diff de versiones descargable»).
 *
 * Vive en `@sahana/domain` y no en el servidor porque quien más lo necesita es
 * el POS offline: al reconectar tiene la versión 7 en disco y el servidor va
 * por la 9. Descargar el catálogo entero por cada cambio de precio gasta datos
 * en un local con conexión mala y tarda justo cuando hay cola; descargar el
 * diff y aplicarlo es la diferencia entre sincronizar en un segundo o en
 * treinta.
 *
 * El diff es una función PURA sobre dos instantáneas. No consulta nada, no
 * conoce la base de datos y produce el mismo resultado en servidor y en
 * navegador — que es el requisito para que ambos lados coincidan sobre qué
 * cambió.
 */

/** Lo mínimo que el diff necesita saber de un producto. */
export interface CatalogSnapshotProduct {
  id: string;
  name: string;
  /** Precio resuelto para el canal, en unidades menores. */
  priceMinor: number;
  available?: boolean | undefined;
  [k: string]: unknown;
}

export interface CatalogSnapshot {
  brandId: string;
  channel: string;
  products: CatalogSnapshotProduct[];
  [k: string]: unknown;
}

/** Campo que cambió, con su valor antes y después. */
export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ChangedProduct {
  id: string;
  name: string;
  changes: FieldChange[];
}

export interface CatalogVersionDiff {
  added: CatalogSnapshotProduct[];
  removed: CatalogSnapshotProduct[];
  changed: ChangedProduct[];
  /** true si no hay ninguna diferencia; el cliente puede ahorrarse aplicarlo. */
  identical: boolean;
}

/**
 * Campos que se comparan. Es una lista explícita y no «todas las claves» a
 * propósito: una instantánea puede llevar metadatos (`resolvedAt`, contadores)
 * que cambian en cada publicación sin que el catálogo haya cambiado, y
 * compararlo todo produciría un diff enorme que nunca está vacío — con lo cual
 * la PWA se descargaría el catálogo completo siempre y el diff no serviría de
 * nada.
 */
const COMPARED_FIELDS = [
  'name',
  'priceMinor',
  'available',
  'description',
  'categoryId',
  'prepMinutes',
  'isCombo',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Ausente y nulo son el mismo hecho para el cliente: «no hay valor».
  if ((a === undefined || a === null) && (b === undefined || b === null)) {
    return true;
  }
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Diferencias de la versión `from` a la versión `to`. */
export function diffCatalogVersions(
  from: CatalogSnapshot,
  to: CatalogSnapshot,
): CatalogVersionDiff {
  const antes = new Map(from.products.map((p) => [p.id, p]));
  const despues = new Map(to.products.map((p) => [p.id, p]));

  const added: CatalogSnapshotProduct[] = [];
  const changed: ChangedProduct[] = [];

  for (const [id, producto] of despues) {
    const anterior = antes.get(id);
    if (!anterior) {
      added.push(producto);
      continue;
    }
    const changes: FieldChange[] = [];
    for (const campo of COMPARED_FIELDS) {
      if (!sameValue(anterior[campo], producto[campo])) {
        changes.push({
          field: campo,
          from: anterior[campo],
          to: producto[campo],
        });
      }
    }
    if (changes.length > 0) {
      changed.push({ id, name: producto.name, changes });
    }
  }

  const removed = [...antes.values()].filter((p) => !despues.has(p.id));

  return {
    added,
    removed,
    changed,
    identical:
      added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

/**
 * Aplica un diff a una instantánea. Es lo que ejecuta el POS al sincronizar, y
 * la razón de que el diff se pruebe contra esta función: un diff que no puede
 * reconstruir el destino es un diff roto, por bonito que se vea.
 */
export function applyCatalogDiff(
  base: CatalogSnapshot,
  diff: CatalogVersionDiff,
): CatalogSnapshot {
  const productos = new Map(base.products.map((p) => [p.id, { ...p }]));

  for (const quitado of diff.removed) productos.delete(quitado.id);
  for (const nuevo of diff.added) productos.set(nuevo.id, { ...nuevo });

  for (const cambio of diff.changed) {
    const actual = productos.get(cambio.id);
    if (!actual) {
      // El diff dice que cambió un producto que no está en la base: las
      // versiones no encajan. Fallar es correcto — aplicar a medias dejaría al
      // POS vendiendo con un catálogo que no es ninguno de los dos.
      throw new CatalogDiffError(
        `El diff modifica el producto ${cambio.id}, que no existe en la versión base.`,
      );
    }
    for (const { field, to } of cambio.changes) {
      actual[field] = to;
    }
  }

  return { ...base, products: [...productos.values()] };
}

export class CatalogDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogDiffError';
  }
}
