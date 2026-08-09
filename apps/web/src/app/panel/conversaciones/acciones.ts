'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoBandeja {
  error?: string;
  ok?: string;
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
 */
export async function responder(
  _prev: EstadoBandeja,
  form: FormData,
): Promise<EstadoBandeja> {
  const id = String(form.get('conversationId') ?? '');
  const texto = String(form.get('text') ?? '').trim();
  const esNota = form.get('kind') === 'note';
  if (texto.length === 0) return { error: 'Escribe algo antes de enviar.' };

  try {
    await panel.responder(id, { kind: esNota ? 'note' : 'text', text: texto });
  } catch (error) {
    return traducir(error);
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
