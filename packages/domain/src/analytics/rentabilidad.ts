import { Money } from '../money/money.js';

/**
 * Totales de un informe de rentabilidad.
 *
 * Vive en `@sahana/domain` y no en la pantalla que lo pinta por la regla de
 * CLAUDE.md: **el cálculo de totales solo se escribe aquí**. La tentación era
 * sumar la columna en el `page.tsx` con un `reduce` y `Number(...)`, que es la
 * forma corta de meter coma flotante justo en el número con el que alguien
 * decide si cierra una marca. Los importes llegan como cadena decimal —
 * `NUMERIC(14,4)` viaja como texto— y aquí se suman con `Money`, en enteros.
 *
 * Se totaliza en el cliente y no en el servidor a propósito: la API ya devuelve
 * las filas, y pedir el mismo periodo otra vez para que se sume allí sería una
 * consulta de más. Lo que NO puede pasar es que la suma se escriba dos veces
 * con dos reglas distintas — de ahí que esté en el paquete compartido, que es
 * el mismo que usa el servidor.
 */

/** Lo que hace falta de cada fila. Un subconjunto de la vista de la API. */
export interface FilaDeRentabilidad {
  orders: number;
  cancelled: number;
  grossRevenue: string;
  discounts: string;
  netRevenue: string;
  commission: string;
  foodCost: string;
  contributionMargin: string;
}

export interface TotalesDeRentabilidad {
  orders: number;
  cancelled: number;
  grossRevenue: string;
  discounts: string;
  netRevenue: string;
  commission: string;
  foodCost: string;
  contributionMargin: string;
  /** Margen sobre ingreso neto, en puntos básicos. */
  marginBps: number;
  averageTicket: string;
}

/**
 * Suma las filas de un informe de rentabilidad.
 *
 * Dos cosas que **no** se suman y por eso se recalculan:
 *
 *  · **El porcentaje de margen.** Sumar los porcentajes de cada fila daría un
 *    número sin significado; peor, promediarlos daría uno *plausible* y falso —
 *    una marca con dos pedidos al 60 % pesaría lo mismo que otra con doscientos
 *    al 5 %. Se calcula sobre los totales ya sumados.
 *  · **El ticket promedio**, por lo mismo: es el neto total entre los pedidos
 *    totales, no la media de las medias.
 *
 * Una lista vacía devuelve ceros y no lanza: un informe sin ventas en el rango
 * es un caso normal —un lunes de enero—, no un error.
 */
export function totalizarRentabilidad(
  filas: readonly FilaDeRentabilidad[],
): TotalesDeRentabilidad {
  const cero = Money.zero('PEN');
  const sumar = (tomar: (f: FilaDeRentabilidad) => string): Money =>
    filas.reduce((acc, f) => acc.add(Money.parse(tomar(f), 'PEN')), cero);

  const bruto = sumar((f) => f.grossRevenue);
  const descuentos = sumar((f) => f.discounts);
  const neto = sumar((f) => f.netRevenue);
  const comision = sumar((f) => f.commission);
  const costoInsumos = sumar((f) => f.foodCost);
  const margen = sumar((f) => f.contributionMargin);

  const pedidos = filas.reduce((acc, f) => acc + f.orders, 0);

  return {
    orders: pedidos,
    cancelled: filas.reduce((acc, f) => acc + f.cancelled, 0),
    grossRevenue: bruto.toDecimalString(),
    discounts: descuentos.toDecimalString(),
    netRevenue: neto.toDecimalString(),
    commission: comision.toDecimalString(),
    foodCost: costoInsumos.toDecimalString(),
    contributionMargin: margen.toDecimalString(),
    // La misma regla que cada fila: puntos básicos enteros. Un `0.325` en coma
    // flotante se arrastra hasta la pantalla.
    marginBps:
      neto.minorUnits === 0
        ? 0
        : Math.round((margen.minorUnits / neto.minorUnits) * 10_000),
    averageTicket:
      pedidos === 0
        ? '0.0000'
        : Money.fromMinor(
            Math.round(neto.minorUnits / pedidos),
            'PEN',
          ).toDecimalString(),
  };
}

/**
 * Qué parte del total representa una fila, en puntos básicos.
 *
 * Sirve para la barra que acompaña a cada fila en la tabla: leer nueve columnas
 * de cifras no dice cuál pesa, y una barra sí. Sobre el **neto**, que es la
 * magnitud que compara canales de forma justa.
 *
 * Con total cero devuelve 0 en vez de dividir: un informe sin ventas no debe
 * pintar barras llenas ni `NaN`.
 */
export function pesoEnPuntosBasicos(parte: string, total: string): number {
  const t = Money.parse(total, 'PEN');
  if (t.minorUnits === 0) return 0;
  const p = Money.parse(parte, 'PEN');
  const bps = Math.round((p.minorUnits / t.minorUnits) * 10_000);
  // Una fila con margen negativo no debe pintar una barra hacia atrás.
  return bps < 0 ? 0 : bps;
}
