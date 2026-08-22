/**
 * Las reglas del aviso con deshacer, separadas del componente que las pinta.
 *
 * Están aquí y no dentro de `aviso.tsx` por la razón que da `vitest.config.ts`:
 * probar un componente con un renderizador falso comprueba el renderizador. Lo
 * que sí merece prueba —y la tiene— es **la decisión**, que es lo único que
 * puede estar mal sin verse en una captura: en el instante cero, un aviso que
 * caduca a los ocho segundos y uno que no caduca nunca son idénticos.
 */

/** Segundos de gracia para deshacer. docs/25 los fija en ocho. */
export const SEGUNDOS_PARA_DESHACER = 8;

export type QuePintar = 'nada' | 'ok' | 'error';

export interface EstadoDelAviso {
  ok?: string | undefined;
  error?: string | undefined;
  /** Segundos que quedan de la cuenta atrás. */
  restan: number;
  /** El operador lo cerró a mano. */
  cerrado: boolean;
}

/**
 * Qué se pinta.
 *
 * La asimetría que decide todo:
 *
 *  · **El «hecho» caduca.** Es una confirmación; a los ocho segundos ya cumplió
 *    su función y estorba.
 *  · **El error NO caduca.** Un error que desaparece solo deja al operador
 *    creyendo que guardó cuando no guardó — en una carta, eso es cobrar el
 *    precio viejo toda la tarde. Se cierra a mano.
 *  · **El error gana al «hecho»** si por lo que sea llegan los dos: la mala
 *    noticia es la que hay que leer.
 */
export function quePintar({
  ok,
  error,
  restan,
  cerrado,
}: EstadoDelAviso): QuePintar {
  if (cerrado) return 'nada';
  if (error) return 'error';
  if (!ok) return 'nada';
  return restan > 0 ? 'ok' : 'nada';
}

/**
 * ¿Corre el reloj?
 *
 * Solo para el «hecho». Arrancar la cuenta atrás sobre un error sería la forma
 * complicada de esconderlo.
 */
export function corren({
  ok,
  error,
}: {
  ok?: string | undefined;
  error?: string | undefined;
}): boolean {
  return Boolean(ok) && !error;
}

/**
 * Los campos que manda el formulario de deshacer.
 *
 * `esDeshacer` es lo que corta el bucle: la acción de servidor la lee y omite
 * entonces el `deshacer` de su respuesta. Sin ella, revertir ofrecería revertir
 * la reversión y a la tercera vuelta nadie sabría en qué precio quedó el plato.
 */
export function camposDeDeshacer(
  campos: Record<string, string>,
): Record<string, string> {
  return { ...campos, esDeshacer: '1' };
}
