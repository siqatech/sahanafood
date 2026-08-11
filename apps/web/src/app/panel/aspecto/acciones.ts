'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

/**
 * El aspecto de la tienda (PA-12, referencia: Deliverect).
 *
 * Los colores se validan en el SERVIDOR, no aquí: acaban dentro de una hoja de
 * estilos que se sirve a los clientes del restaurante, y una validación que
 * vive solo en el navegador no valida nada — basta llamar a la API a mano.
 */

export interface EstadoAspecto {
  error?: string;
  ok?: string;
  valores?: Record<string, string>;
}

export async function guardarAspecto(
  _prev: EstadoAspecto,
  form: FormData,
): Promise<EstadoAspecto> {
  const texto = (k: string): string => String(form.get(k) ?? '').trim();
  const valores = {
    displayName: texto('displayName'),
    tagline: texto('tagline'),
    logoUrl: texto('logoUrl'),
    coverUrl: texto('coverUrl'),
    colorBase: texto('colorBase'),
    colorHover: texto('colorHover'),
    colorTexto: texto('colorTexto'),
  };
  const brandId = texto('brandId');
  if (!brandId) return { error: 'Elige la marca.', valores };

  try {
    await panel.guardarAspecto({ brandId, ...valores });
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return {
        error: 'Tu sesión caducó. Recarga y vuelve a entrar.',
        valores,
      };
    }
    if (error instanceof PanelApiError) {
      return { error: error.message, valores };
    }
    return { error: 'No se pudo guardar. Inténtalo de nuevo.', valores };
  }
  revalidatePath('/panel/aspecto');
  return { ok: 'Guardado. Abre tu tienda para verlo.' };
}
