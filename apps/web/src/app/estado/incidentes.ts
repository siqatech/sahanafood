/**
 * Incidentes de la plataforma, para la página pública de estado (docs/26).
 *
 * ## Por qué un archivo del repositorio y no una tabla
 *
 * El mismo motivo que Novedades, y aquí pesa más: **no puede mentir**. Un
 * incidente vive en el repositorio, se escribe en el mismo cambio que lo
 * resuelve y pasa por revisión. Una tabla editable en caliente permite lo
 * contrario —maquillar la duración cuando ya nadie mira—, y una página de estado
 * que se puede maquillar no construye ninguna confianza: solo la simula.
 *
 * ## Cómo se escribe uno
 *
 * En la lengua de quien lo sufrió, no en la de quien lo arregló. Quien lee esto
 * es un dueño de restaurante que estuvo media hora sin poder cobrar: no le sirve
 * «se degradó el pool de conexiones», le sirve «no se podía cobrar con tarjeta».
 *
 *   mal  → «Timeout en el adaptador de la pasarela por saturación del pool.»
 *   bien → «Los cobros con tarjeta fallaban. El efectivo y Yape funcionaban.»
 *
 * Y **qué se hizo para que no se repita**, que es la única parte que le importa
 * a quien está decidiendo si confiar en nosotros el año que viene. Un incidente
 * sin esa línea es una disculpa, no un postmortem.
 */

export type EstadoDeIncidente = 'resuelto' | 'investigando' | 'vigilando';

export interface Incidente {
  /** AAAA-MM-DD. Identifica y ordena. */
  fecha: string;
  titulo: string;
  estado: EstadoDeIncidente;
  /** Cuánto duró, en lenguaje llano: «unos 40 minutos». */
  duracion: string;
  /** Qué no funcionaba, desde fuera. Sin jerga. */
  queFallo: string;
  /** Qué SÍ seguía funcionando. Casi siempre es la mitad de la tranquilidad. */
  queSiFuncionaba?: string;
  /** Qué se cambió para que no vuelva a pasar. Sin esto es una disculpa. */
  queSeHizo: string;
}

/**
 * De momento vacío, y eso es un dato, no un olvido.
 *
 * La plataforma no ha tenido todavía un incidente en producción con clientes
 * reales —no hay clientes reales aún—, así que inventar uno para que la página
 * «se vea completa» sería exactamente la clase de mentira que esta página
 * existe para no contar.
 */
export const INCIDENTES: Incidente[] = [];

/** De lo más reciente a lo más antiguo, sin fiarse del orden del archivo. */
export function ordenados(lista: readonly Incidente[]): Incidente[] {
  return [...lista].sort((a, b) => b.fecha.localeCompare(a.fecha));
}

/** Los que siguen abiertos. Son los que van arriba del todo y en color. */
export function abiertos(lista: readonly Incidente[]): Incidente[] {
  return ordenados(lista).filter((i) => i.estado !== 'resuelto');
}

/**
 * Cuántos días lleva la plataforma sin un incidente abierto.
 *
 * `null` cuando hay uno abierto —no se presume tranquilidad mientras algo está
 * roto— y también cuando no hay historial: «0 días sin incidentes» y «nunca ha
 * habido uno» son cosas distintas y decir la primera por la segunda asusta sin
 * motivo.
 */
export function diasSinIncidentes(
  lista: readonly Incidente[],
  ahora: Date,
): number | null {
  if (abiertos(lista).length > 0) return null;
  const ultimo = ordenados(lista)[0];
  if (!ultimo) return null;
  const desde = Date.parse(`${ultimo.fecha}T12:00:00Z`);
  if (Number.isNaN(desde)) return null;
  return Math.max(0, Math.floor((ahora.getTime() - desde) / 86_400_000));
}
