'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

/** Emitir y revocar claves de tienda (ADR-0020). */

export interface EstadoClave {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoClave {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo. Inténtalo de nuevo.' };
}

export async function emitirClave(
  _prev: EstadoClave,
  form: FormData,
): Promise<EstadoClave> {
  const brandId = String(form.get('brandId') ?? '');
  const label = String(form.get('label') ?? '').trim();
  if (!brandId) return { error: 'Elige la marca.' };

  try {
    await panel.emitirClave({ brandId, ...(label ? { label } : {}) });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/integracion');
  return { ok: 'Clave creada. Ya puedes pegarla en tu web.' };
}

export async function revocarClave(
  _prev: EstadoClave,
  form: FormData,
): Promise<EstadoClave> {
  try {
    await panel.revocarClave(String(form.get('id') ?? ''));
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/integracion');
  return { ok: 'Clave revocada. La web que la usara dejará de pedir.' };
}
