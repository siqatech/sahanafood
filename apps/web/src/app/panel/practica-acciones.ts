'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../lib/panel-api';

/** Estado de «borrar la práctica y empezar en serio» (docs/26 §4). */
export interface EstadoPractica {
  error?: string;
  hecho?: boolean;
  seConserva?: string[];
}

export async function empezarEnSerio(
  _prev: EstadoPractica,
  form: FormData,
): Promise<EstadoPractica> {
  const motivo = String(form.get('reason') ?? '').trim();
  // El servidor lo exige igual; aquí se comprueba para no gastar un viaje y
  // para poder decirlo junto al campo.
  if (motivo.length < 3) {
    return {
      error: 'Escribe por qué empiezas en serio: queda en el histórico.',
    };
  }

  try {
    const r = await panel.empezarEnSerio(motivo);
    // Se revalida el panel entero: al vaciar las ventas cambian la portada, los
    // pedidos, la caja y los informes a la vez.
    revalidatePath('/panel', 'layout');
    return { hecho: true, seConserva: r.seConserva };
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return {
        error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.',
      };
    }
    if (error instanceof PanelApiError) return { error: error.message };
    return { error: 'No hemos podido hacerlo. Inténtalo de nuevo.' };
  }
}
