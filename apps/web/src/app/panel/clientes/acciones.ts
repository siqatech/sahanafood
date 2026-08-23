'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

/** Anonimizar a solicitud (RN-CRM-02, Ley 29733). */
export interface EstadoCliente {
  error?: string;
  hecho?: boolean;
}

export async function anonimizar(
  _prev: EstadoCliente,
  form: FormData,
): Promise<EstadoCliente> {
  const phone = String(form.get('phone') ?? '');
  const motivo = String(form.get('reason') ?? '').trim();
  if (motivo.length < 3) {
    return {
      error: 'Escribe por qué se anonimiza: queda en el histórico.',
    };
  }

  try {
    await panel.anonimizarCliente(phone, motivo);
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return {
        error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.',
      };
    }
    if (error instanceof PanelApiError) return { error: error.message };
    return { error: 'No hemos podido hacerlo. Inténtalo de nuevo.' };
  }
  revalidatePath('/panel/clientes');
  return { hecho: true };
}
