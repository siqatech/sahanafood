/**
 * El semáforo de tiempo (docs/25, «Detalles que compran al operador»).
 *
 * > Semáforo de tiempo en cada tarjeta: verde <70 % del prometido, ámbar
 * > 70–100 %, rojo vencido.
 *
 * Vive aquí y no en cada aplicación porque ya estaba escrito **dos veces** con
 * dos reglas distintas: el KDS lo calculaba proporcional, como dice la spec, y
 * el panel lo hacía con un umbral fijo de dos minutos. Con la política por
 * defecto —diez minutos— ese umbral avisa al 80 % del plazo; con una de treinta
 * minutos, al 93 %. Es decir: en las cocinas con más margen, el aviso llegaba
 * cuando ya no servía para nada, y las dos pantallas discrepaban sobre el mismo
 * pedido.
 *
 * Es una función pura y sin reloj propio: `ahora` entra como parámetro. Un
 * `Date.now()` escondido dentro haría que la misma tarjeta se pintara distinta
 * en el servidor y en el navegador, y React avisaría de discrepancia de
 * hidratación en mitad del servicio.
 */

export type NivelDeTiempo = 'verde' | 'ambar' | 'rojo';

/** A partir de aquí, ámbar. Es el 70 % que fija docs/25. */
export const UMBRAL_AMBAR = 0.7;

export interface VentanaDeTiempo {
  /** Cuándo empezó a correr el reloj (entrada del pedido, normalmente). */
  inicio: number;
  /** Cuándo vence: la promesa al cliente o el plazo de aceptación. */
  limite: number;
  ahora: number;
}

/**
 * Verde, ámbar o rojo.
 *
 * Casos que no son obvios y por eso están decididos aquí:
 *
 *  · **Vencido es rojo**, aunque sea por un segundo. No hay «casi».
 *  · **Una ventana de duración cero o negativa** —un pedido que nace vencido,
 *    o dos relojes desincronizados— es ROJA. Tratarla como verde escondería
 *    justo el pedido que nadie ha mirado.
 *  · El límite se compara con `>=`: al llegar al 100 % ya está vencido, no en
 *    el milisegundo siguiente.
 */
export function nivelDeTiempo({
  inicio,
  limite,
  ahora,
}: VentanaDeTiempo): NivelDeTiempo {
  if (ahora >= limite) return 'rojo';

  const total = limite - inicio;
  if (total <= 0) return 'rojo';

  const transcurrido = ahora - inicio;
  // Antes de que empiece la ventana —reloj adelantado en la tablet— es verde:
  // no ha corrido nada todavía.
  if (transcurrido <= 0) return 'verde';

  return transcurrido / total >= UMBRAL_AMBAR ? 'ambar' : 'verde';
}
