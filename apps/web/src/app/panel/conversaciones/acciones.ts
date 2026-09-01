'use server';

import { revalidatePath } from 'next/cache';
import {
  panel,
  PanelApiError,
  SesionCaducada,
  type RespuestaRapida,
} from '../../../lib/panel-api';
import { revisarAtajo, revisarCuerpo, expandirAtajos } from './atajos';

export interface EstadoBandeja {
  error?: string;
  ok?: string;
  /**
   * Lo que se acababa de escribir, para devolvérselo al formulario.
   *
   * React **vacía los campos no controlados** al terminar una acción de
   * servidor, y ese vaciado llega DESPUÉS del mensaje de error: sin esto, quien
   * corrige el atajo en cuanto lee el aviso ve desaparecer el texto largo que
   * ya había escrito debajo.
   */
  valores?: Record<string, string>;
}

function traducir(error: unknown): EstadoBandeja {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo enviar. Inténtalo de nuevo.' };
}

/**
 * Responder o dejar una nota interna.
 *
 * El `kind` decide una diferencia que no se puede equivocar: una nota se queda
 * dentro y un texto sale al teléfono del cliente. Va en el formulario y no
 * deducido de nada, y la pantalla los pinta distinto (RN-CNV-07) — un
 * comentario interno enviado al cliente es de los errores que no se deshacen.
 *
 * Los atajos —`/recojo`— se expanden AQUÍ, en el servidor, y no solo al pulsar
 * el botón: quien atiende rápido los teclea sin soltar el teclado, y una
 * expansión que solo ocurre con el ratón manda al cliente una barra y una
 * palabra suelta.
 */
export async function responder(
  _prev: EstadoBandeja,
  form: FormData,
): Promise<EstadoBandeja> {
  const id = String(form.get('conversationId') ?? '');
  const escrito = String(form.get('text') ?? '').trim();
  const esNota = form.get('kind') === 'note';
  if (escrito.length === 0) return { error: 'Escribe algo antes de enviar.' };

  // Las plantillas SOLO se piden si hay una barra que expandir. La inmensa
  // mayoría de los mensajes se escriben a mano, y cobrarles a todos una
  // llamada de red antes de enviar retrasa justo lo que tiene que ser
  // instantáneo. Si no se pueden leer, se manda lo escrito tal cual: un fallo
  // al expandir un atajo no puede impedir contestarle a un cliente.
  const respuestas = escrito.includes('/')
    ? await panel
        .respuestasDeConversacion(id)
        .catch(() => [] as RespuestaRapida[])
    : [];
  const texto = expandirAtajos(escrito, respuestas);

  try {
    await panel.responder(id, { kind: esNota ? 'note' : 'text', text: texto });
  } catch (error) {
    return { ...traducir(error), valores: { text: escrito } };
  }
  revalidatePath(`/panel/conversaciones/${id}`);
  return { ok: esNota ? 'Nota guardada (no sale al cliente).' : 'Enviado.' };
}

/**
 * Tomar la conversación.
 *
 * Es la acción que cierra el agujero de DT-14: una derivación del bot llega a
 * la cola y, hasta que alguien la toma, nadie es responsable de ella. Asignarse
 * pone un nombre al lado del cliente que está esperando.
 */
export async function tomar(
  _prev: EstadoBandeja,
  form: FormData,
): Promise<EstadoBandeja> {
  const id = String(form.get('conversationId') ?? '');
  const userId = String(form.get('userId') ?? '');
  try {
    await panel.asignarme(id, userId);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath(`/panel/conversaciones/${id}`);
  return { ok: 'Es tuya: el cliente ya tiene a alguien.' };
}

export async function resolverConversacion(
  _prev: EstadoBandeja,
  form: FormData,
): Promise<EstadoBandeja> {
  const id = String(form.get('conversationId') ?? '');
  try {
    await panel.resolverConversacion(id);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/conversaciones');
  revalidatePath(`/panel/conversaciones/${id}`);
  return { ok: 'Conversación cerrada.' };
}

/**
 * Crea una respuesta rápida.
 *
 * La tabla existía desde T5.19 con **solo lectura**: la única forma de llenarla
 * era un `INSERT` a mano, así que estaba vacía y la bandeja obligaba a
 * reescribir la dirección de recojo en cada conversación. Eso no es incomodidad
 * estética — es por lo que se contesta con prisa y se manda el horario del
 * local equivocado.
 */
export async function crearRespuestaRapida(
  _prev: EstadoBandeja,
  form: FormData,
): Promise<EstadoBandeja> {
  const escrito = String(form.get('shortcut') ?? '');
  const cuerpoEscrito = String(form.get('body') ?? '');
  const marca = String(form.get('brandId') ?? '').trim();

  const atajo = revisarAtajo(escrito);
  if ('error' in atajo) {
    return {
      error: atajo.error,
      valores: { shortcut: escrito, body: cuerpoEscrito },
    };
  }
  const cuerpo = revisarCuerpo(cuerpoEscrito);
  if ('error' in cuerpo) {
    return {
      error: cuerpo.error,
      valores: { shortcut: escrito, body: cuerpoEscrito },
    };
  }

  try {
    await panel.crearRespuestaRapida({
      shortcut: atajo.atajo,
      body: cuerpo.cuerpo,
      ...(marca !== '' ? { brandId: marca } : {}),
    });
  } catch (error) {
    return {
      ...traducir(error),
      valores: { shortcut: escrito, body: cuerpoEscrito },
    };
  }
  revalidatePath('/panel/conversaciones/respuestas');
  return { ok: `Listo. Ya se puede escribir /${atajo.atajo} en la bandeja.` };
}

/** Borra una respuesta rápida. Es una plantilla: no hay nada que conservar. */
export async function borrarRespuestaRapida(
  _prev: EstadoBandeja,
  form: FormData,
): Promise<EstadoBandeja> {
  try {
    await panel.borrarRespuestaRapida(String(form.get('id') ?? ''));
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/conversaciones/respuestas');
  return { ok: 'Borrada.' };
}
