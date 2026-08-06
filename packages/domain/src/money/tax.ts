import type { Money } from './money.js';
import { MoneyError } from './money.js';

/**
 * Impuestos incluidos en el precio (RN-T05).
 *
 * En Perú el IGV (18 %) va incluido en el precio de venta al público y el
 * desglose se calcula HACIA ATRÁS: dado el precio bruto, se obtiene la base
 * imponible (neto) y el impuesto de modo que `neto + impuesto === bruto`
 * exacto, sin céntimos perdidos. El impuesto se deriva por resta para que el
 * comprobante SUNAT siempre cuadre.
 */

/** IGV Perú expresado en puntos básicos (1800 = 18 %). Configurable por país (F9). */
export const IGV_PERU_BPS = 1800;

export interface TaxBreakdown {
  /** Precio bruto (incluye impuesto), redondeado a céntimos. */
  readonly gross: Money;
  /** Base imponible (neto sin impuesto). */
  readonly net: Money;
  /** Impuesto = gross − net. */
  readonly tax: Money;
  /** Tasa aplicada en puntos básicos. */
  readonly rateBps: number;
}

/**
 * Desglosa un precio que YA incluye el impuesto.
 * @param gross   precio con impuesto incluido
 * @param rateBps tasa en puntos básicos (por defecto IGV Perú 18 %)
 */
export function extractInclusiveTax(
  gross: Money,
  rateBps: number = IGV_PERU_BPS,
): TaxBreakdown {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(`Tasa de impuesto inválida: ${rateBps} bps.`);
  }
  const grossCents = gross.roundToCents();
  // neto = bruto / (1 + tasa)  =>  bruto * 10000 / (10000 + rateBps)
  const net = grossCents.multiplyByRatio(10000, 10000 + rateBps).roundToCents();
  const tax = grossCents.subtract(net);
  return { gross: grossCents, net, tax, rateBps };
}

/**
 * Añade un impuesto a un precio neto (camino hacia adelante), por si un catálogo
 * carga precios sin impuesto. Redondea a céntimos.
 */
export function addExclusiveTax(
  net: Money,
  rateBps: number = IGV_PERU_BPS,
): TaxBreakdown {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(`Tasa de impuesto inválida: ${rateBps} bps.`);
  }
  const netCents = net.roundToCents();
  const tax = netCents.multiplyByRatio(rateBps, 10000).roundToCents();
  const gross = netCents.add(tax);
  return { gross, net: netCents, tax, rateBps };
}
