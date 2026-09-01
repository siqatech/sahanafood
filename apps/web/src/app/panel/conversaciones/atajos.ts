import type { RespuestaRapida } from '../../../lib/panel-api';

/**
 * Respuestas rápidas: lo que el equipo escribe cuarenta veces al día.
 *
 * La tabla `cnv_quick_replies` existía desde T5.19 y solo tenía **lectura**:
 * la única forma de llenarla era un `INSERT` a mano, así que en la práctica
 * estaba vacía y la bandeja obligaba a reescribir la dirección de recojo en
 * cada conversación. Eso no es una molestia estética — es el motivo por el que
 * se contesta con prisa y se manda el horario del local equivocado.
 *
 * Este módulo es puro: valida el atajo y lo expande. Nada más, para poder
 * probar exactamente lo que va a pasar cuando alguien teclee `/recojo` con un
 * cliente esperando.
 */

export const ATAJO_MINIMO = 2;
export const ATAJO_MAXIMO = 40;

/**
 * Comprueba un atajo antes de mandarlo.
 *
 * Sin espacios y en minúsculas: se teclea de un tirón mientras el cliente
 * espera, y `/Recojo` y `/recojo` siendo dos cosas distintas convierte la ayuda
 * en una lotería. La barra inicial es opcional al escribirlo y se guarda sin
 * ella; es separador, no parte del nombre.
 */
export function revisarAtajo(
  escrito: string,
): { atajo: string } | { error: string } {
  const limpio = escrito.trim().replace(/^\/+/, '').toLowerCase();
  if (limpio === '') return { error: 'Ponle un atajo, por ejemplo /recojo.' };
  if (/\s/.test(limpio)) {
    return {
      error: 'El atajo va sin espacios: se teclea con el cliente esperando.',
    };
  }
  if (limpio.length < ATAJO_MINIMO) {
    return { error: `El atajo necesita al menos ${ATAJO_MINIMO} letras.` };
  }
  if (limpio.length > ATAJO_MAXIMO) {
    return { error: `El atajo no puede pasar de ${ATAJO_MAXIMO} letras.` };
  }
  return { atajo: limpio };
}

export function revisarCuerpo(
  escrito: string,
): { cuerpo: string } | { error: string } {
  const limpio = escrito.trim();
  if (limpio === '') return { error: 'Escribe qué se manda al usarlo.' };
  if (limpio.length > 4096) {
    return { error: 'El texto no puede pasar de 4096 caracteres.' };
  }
  return { cuerpo: limpio };
}

/**
 * Expande los atajos escritos en el mensaje.
 *
 * Solo sustituye un `/atajo` que ocupe una palabra entera y que EXISTA: dejar
 * intacto lo que no reconoce es deliberado. Un `/recojo` mal escrito tiene que
 * verse antes de darle a enviar, no convertirse en silencio — mandar el
 * mensaje sin el dato es peor que mandarlo con la barra de más.
 */
export function expandirAtajos(
  texto: string,
  respuestas: readonly RespuestaRapida[],
): string {
  if (respuestas.length === 0) return texto;
  const porAtajo = new Map(
    respuestas.map((r) => [r.shortcut.toLowerCase(), r.body]),
  );
  return texto.replace(
    /(^|\s)\/([^\s/]+)/g,
    (completo, antes: string, atajo: string) => {
      const cuerpo = porAtajo.get(atajo.toLowerCase());
      return cuerpo === undefined ? completo : `${antes}${cuerpo}`;
    },
  );
}

/**
 * Dónde encaja el texto de una respuesta al pulsarla.
 *
 * Se AÑADE, no se sustituye: quien ya escribió media frase y pulsa el atajo no
 * quiere perderla. Va en una línea aparte porque casi siempre es un bloque
 * —dirección, horario, política de devolución— y pegado al final del párrafo
 * anterior se lee como si fuera la misma frase.
 */
export function insertar(actual: string, cuerpo: string): string {
  const previo = actual.trimEnd();
  return previo === '' ? cuerpo : `${previo}\n${cuerpo}`;
}
