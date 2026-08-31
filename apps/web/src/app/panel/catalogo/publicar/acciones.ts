'use server';

import { revalidatePath } from 'next/cache';
import {
  panel,
  PanelApiError,
  SesionCaducada,
} from '../../../../lib/panel-api';

export interface EstadoPublicacion {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoPublicacion {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo publicar. Inténtalo de nuevo.' };
}

/**
 * Publica la carta de un canal (T4.06, spec 04).
 *
 * Una versión publicada es **inmutable**: es la foto que los canales y la PWA
 * consumen, y lo que permite responder «¿qué precio tenía esto el martes?».
 *
 * Publicar dos veces sin cambios **no crea una versión nueva**: el servidor
 * compara el contenido y devuelve la que ya existía. Se dice en pantalla porque
 * si no, pulsar y no ver un número nuevo parece que falló.
 */
export async function publicar(
  _prev: EstadoPublicacion,
  form: FormData,
): Promise<EstadoPublicacion> {
  const brandId = String(form.get('brandId') ?? '');
  const channel = String(form.get('channel') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  if (channel === '') return { error: 'Elige el canal que quieres publicar.' };

  try {
    const version = await panel.publicarCarta({
      brandId,
      channel,
      ...(notes !== '' ? { notes } : {}),
    });
    revalidatePath('/panel/catalogo/publicar');
    return {
      ok: version.reused
        ? `Sin cambios: la carta de ${channel} ya estaba publicada en la versión ${version.version}.`
        : `Publicada la versión ${version.version} de ${channel}, con ${version.productCount} platos.`,
    };
  } catch (error) {
    return traducir(error);
  }
}
