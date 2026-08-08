import { Money } from '@sahana/domain';

/**
 * Formateo de importes para la tienda.
 *
 * Usa el `Money` de `@sahana/domain`, el mismo que calcula los totales en el
 * servidor, en vez de dividir a mano por una potencia de diez. La diferencia
 * importa: la escala vive DENTRO del valor, así que un cambio de escala se
 * arrastra solo. La primera versión de esta pantalla dividía entre 10.000 a
 * pelo y pintaba `S/ NaN` en cuanto el JSON no traía el campo que se esperaba;
 * el formateo a mano falla de esa manera, callado y en la cara del cliente.
 *
 * Esto es FORMATEO, no cálculo. La tienda no suma, no resta y no aplica
 * porcentajes: todos los importes que enseña vienen ya calculados del servidor.
 */

export interface MoneyJson {
  minorUnits: number;
  currency: string;
  scale: number;
}

/** `S/ 32.00` a partir del JSON de un `Money`. */
export function formatMoney(valor: MoneyJson): string {
  const money = Money.fromMinor(valor.minorUnits, valor.currency as 'PEN');
  return `${simbolo(valor.currency)} ${redondear(money.toDecimalString())}`;
}

/** `S/ 32.00` a partir de la cadena decimal que devuelve la API. */
export function formatDecimal(decimal: string, currency = 'PEN'): string {
  return `${simbolo(currency)} ${redondear(decimal)}`;
}

/** `+ S/ 5.00` / `− S/ 2.00` para el ajuste de un modificador. */
export function formatDelta(minorUnits: number, currency = 'PEN'): string {
  if (minorUnits === 0) return '';
  const money = Money.fromMinor(Math.abs(minorUnits), currency as 'PEN');
  const signo = minorUnits > 0 ? '+' : '−';
  return `${signo} ${simbolo(currency)} ${redondear(money.toDecimalString())}`;
}

function simbolo(currency: string): string {
  return currency === 'PEN' ? 'S/' : currency;
}

/**
 * El dominio guarda 4 decimales; la tienda enseña 2.
 *
 * Se recorta la cadena en vez de redondear con aritmética de coma flotante:
 * los importes que llegan ya vienen redondeados por el servidor —el redondeo
 * de verdad, media hacia arriba, ocurre una sola vez y allí—, así que aquí solo
 * hay que dejar de mostrar dos ceros.
 */
function redondear(decimal: string): string {
  const [entero = '0', decimales = ''] = decimal.split('.');
  return `${entero}.${(decimales + '00').slice(0, 2)}`;
}
