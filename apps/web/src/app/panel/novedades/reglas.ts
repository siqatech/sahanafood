import type { Novedad } from './datos';

/**
 * Qué novedades son nuevas PARA QUIEN MIRA.
 *
 * Vive aparte de la pantalla porque es lo único de aquí que puede estar mal sin
 * verse: en el instante cero, un aviso que cuenta bien las novedades sin leer y
 * uno que las cuenta todas son idénticos si el usuario es nuevo.
 *
 * ## Por qué la última visita se guarda en el navegador
 *
 * «Ya lo leí» es una preferencia de una persona en un dispositivo, no un dato
 * del negocio. Guardarlo en la base pediría una tabla por usuario, una escritura
 * en cada visita a la portada y un endpoint para marcarlo — todo para que no
 * salga un punto azul. En el navegador se paga cero y el peor caso es que el
 * punto reaparezca en otro dispositivo, que es exactamente lo que uno espera.
 */

/** Clave de `localStorage`. Con prefijo: el panel comparte origen con la tienda. */
export const CLAVE_ULTIMA_VISITA = 'sahana.novedades.vistas';

/**
 * Las novedades ordenadas de la más reciente a la más antigua.
 *
 * Se ordena aquí y no se confía en el orden del archivo: una entrada nueva
 * pegada al final por descuido saldría la última, que es justo donde no se ve.
 */
export function ordenadas(novedades: readonly Novedad[]): Novedad[] {
  return [...novedades].sort((a, b) => b.fecha.localeCompare(a.fecha));
}

/**
 * Cuántas hay sin leer.
 *
 * `ultimaVista` es la fecha de la novedad más reciente que ya se vio.
 *
 *  · **Sin nada guardado devuelve 0, no todas.** Quien entra por primera vez ya
 *    tiene la portada llena de cosas que aprender; recibirlo con «9 novedades»
 *    de funciones que nunca ha echado de menos es ruido. El aviso está para lo
 *    que cambia DESPUÉS de que uno ya conoce la casa.
 *  · Una fecha guardada ilegible se trata como si no hubiera nada, por lo mismo.
 */
export function sinLeer(
  novedades: readonly Novedad[],
  ultimaVista: string | null,
): number {
  if (!ultimaVista || !/^\d{4}-\d{2}-\d{2}$/.test(ultimaVista)) return 0;
  return novedades.filter((n) => n.fecha.localeCompare(ultimaVista) > 0).length;
}

/** La fecha que hay que guardar tras mirar la pantalla: la más reciente. */
export function fechaMasReciente(novedades: readonly Novedad[]): string | null {
  return ordenadas(novedades)[0]?.fecha ?? null;
}
