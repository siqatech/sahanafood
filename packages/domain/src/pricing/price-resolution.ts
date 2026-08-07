/**
 * Resolución de precio por ámbito (RN-CAT-01).
 *
 * Prioridad: **(marca, canal, local) → (marca, canal) → base**.
 *
 * Vive en el dominio y no en una consulta SQL por dos razones:
 *  1. El POS offline resuelve precios sin base de datos, con el catálogo
 *     versionado que descargó. Debe obtener EXACTAMENTE el mismo precio que el
 *     servidor, o el comprobante saldrá distinto de lo cobrado.
 *  2. La regla es de negocio, no de almacenamiento: expresarla como un ORDER BY
 *     la esconde y la hace difícil de probar.
 *
 * Regla dura: **sin precio para el canal, el producto no se vende en ese
 * canal**. Es preferible que falte a que se venda a un precio inventado
 * (heredado de otro canal con otra comisión, por ejemplo).
 */

/** Precio con su ámbito, tal como está en `cat_prices`. */
export interface ScopedPrice {
  readonly priceMinor: number;
  /** `null` = precio base, válido para cualquier canal. */
  readonly channel: string | null;
  /** `null` = válido para todos los locales de la marca. */
  readonly locationId: string | null;
  readonly active?: boolean;
}

export interface PriceQuery {
  readonly channel: string;
  readonly locationId?: string | undefined;
}

/** Especificidad de un precio: a mayor número, más específico. */
function specificity(price: ScopedPrice): number {
  return (price.channel !== null ? 2 : 0) + (price.locationId !== null ? 1 : 0);
}

/** ¿Este precio aplica a la consulta? */
function applies(price: ScopedPrice, query: PriceQuery): boolean {
  if (price.active === false) return false;
  if (price.channel !== null && price.channel !== query.channel) return false;
  if (price.locationId !== null && price.locationId !== query.locationId) {
    return false;
  }
  return true;
}

/**
 * Devuelve el precio aplicable, o `undefined` si el producto no tiene precio
 * para ese canal (→ invisible en ese canal, RN-CAT-01).
 *
 * Ante empate de especificidad —que solo puede ocurrir si los datos violan el
 * índice único de ámbito— se elige el MENOR precio, de forma determinista: si
 * hay que equivocarse, mejor a favor del cliente que cobrándole de más.
 */
export function resolvePrice(
  prices: readonly ScopedPrice[],
  query: PriceQuery,
): ScopedPrice | undefined {
  const candidates = prices.filter((p) => applies(p, query));
  if (candidates.length === 0) return undefined;

  return candidates.reduce((best, candidate) => {
    const diff = specificity(candidate) - specificity(best);
    if (diff !== 0) return diff > 0 ? candidate : best;
    return candidate.priceMinor < best.priceMinor ? candidate : best;
  });
}

/** ¿El producto es vendible en este canal? (tiene precio resuelto) */
export function isSellableInChannel(
  prices: readonly ScopedPrice[],
  query: PriceQuery,
): boolean {
  return resolvePrice(prices, query) !== undefined;
}

// --------------------------------------------------------------- Pausas

export interface ProductPause {
  readonly channel: string;
  /** `null` = pausado hasta reactivación manual. */
  readonly until: Date | null;
}

/**
 * ¿Está pausado el producto en este canal en el instante dado? (RN-CAT-03)
 *
 * Una pausa con `until` en el pasado ya no aplica: se autolevanta sin que nadie
 * tenga que acordarse de reactivar el producto, que es justo lo que se olvida
 * en plena hora punta.
 */
export function isPaused(
  pauses: readonly ProductPause[],
  channel: string,
  at: Date,
): boolean {
  return pauses.some((pause) => {
    if (pause.channel !== '*' && pause.channel !== channel) return false;
    return pause.until === null || pause.until > at;
  });
}

/** ¿Se puede vender ahora mismo en este canal? Precio resuelto y sin pausa. */
export function isAvailable(
  prices: readonly ScopedPrice[],
  pauses: readonly ProductPause[],
  query: PriceQuery,
  at: Date,
): boolean {
  return (
    isSellableInChannel(prices, query) && !isPaused(pauses, query.channel, at)
  );
}
