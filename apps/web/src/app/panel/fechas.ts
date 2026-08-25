/**
 * Las fechas del panel, en un solo sitio.
 *
 * Había **seis formateadores distintos** repartidos por las pantallas —dos
 * llamados `momento`, dos llamados `fecha` y un par sueltos dentro del JSX—,
 * cada uno con sus opciones. El resultado: el mismo instante salía escrito de
 * cuatro formas según la pantalla, y quien compara el histórico con la caja
 * tiene que traducir mentalmente entre dos formatos por gusto de nadie.
 *
 * ## Por qué el día de la semana
 *
 * Porque un operador no piensa en «22/08»: piensa en «el sábado». Los picos de
 * un negocio de comida son semanales —viernes y sábado noche— así que al mirar
 * un listado la pregunta real es «¿esto fue un día fuerte o un martes?». La
 * fecha sola obliga a hacer ese cálculo de cabeza en cada fila.
 *
 * ## Todo en hora de Lima
 *
 * El negocio cierra a la hora de Lima, no a la de UTC. Una venta de las 22:30
 * del sábado es del sábado aunque para UTC ya sea domingo, y una fecha que se
 * salta eso mueve ventas de un día a otro en los informes.
 */

const ZONA = 'America/Lima';

/**
 * Día con su día de la semana: «sáb 23 ago 2026».
 *
 * Sin punto tras la abreviatura del día porque `es-PE` no lo pone, y sin el año
 * cuando es el año en curso —ocupa sitio y no informa: nadie duda de en qué año
 * está el pedido de anteayer—.
 */
export function diaConSemana(iso: string, ahora: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';

  const mismoAno =
    d.toLocaleDateString('en-CA', { timeZone: ZONA, year: 'numeric' }) ===
    ahora.toLocaleDateString('en-CA', { timeZone: ZONA, year: 'numeric' });

  return d.toLocaleDateString('es-PE', {
    timeZone: ZONA,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(mismoAno ? {} : { year: 'numeric' }),
  });
}

/** La hora sola: «14:32». Para cuando el día ya está dicho en otra columna. */
export function horaSola(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('es-PE', {
    timeZone: ZONA,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Día y hora: «sáb 23 ago, 14:32».
 *
 * Es el que va en las fichas, donde importa el instante exacto —a qué hora
 * entró el pedido, cuándo se aceptó— y no solo el día.
 */
export function momento(
  iso: string | null | undefined,
  ahora: Date = new Date(),
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${diaConSemana(iso, ahora)}, ${horaSola(iso)}`;
}

/**
 * ¿Es hoy?
 *
 * Se compara en el calendario de Lima y no con una resta de milisegundos: «hace
 * menos de 24 horas» y «hoy» no son lo mismo, y a las 00:30 la diferencia es
 * justo la que hace que un pedido de anoche aparezca como de hoy.
 */
export function esHoy(iso: string, ahora: Date = new Date()): boolean {
  const dia = (d: Date): string =>
    d.toLocaleDateString('en-CA', { timeZone: ZONA });
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return dia(d) === dia(ahora);
}
