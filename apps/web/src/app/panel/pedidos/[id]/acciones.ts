'use server';

import { revalidatePath } from 'next/cache';
import {
  panel,
  PanelApiError,
  SesionCaducada,
} from '../../../../lib/panel-api';

export interface EstadoDevolucion {
  error?: string;
  ok?: string;
}

/**
 * Pide la devolución de un cobro (RN-PAY-03).
 *
 * Sobre el umbral hacen falta **dos personas**, y la segunda tiene que
 * demostrarlo con su PIN: nombrar a un compañero no aprueba nada, porque el
 * nombre lo escribe quien pide. La pantalla ofrece siempre los dos campos en
 * vez de esconderlos hasta que la API se queje — quien va a devolver S/ 300 ya
 * sabe que necesita a alguien, y descubrirlo tras un error es peor.
 */
export async function pedirDevolucion(
  _prev: EstadoDevolucion,
  form: FormData,
): Promise<EstadoDevolucion> {
  const intentId = String(form.get('intentId') ?? '');
  const orderId = String(form.get('orderId') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  const approvedBy = String(form.get('approvedBy') ?? '').trim();
  const approverPin = String(form.get('approverPin') ?? '').trim();

  // El motivo es lo que verá quien audite la devolución, y también lo que se
  // le dice al cliente: «se te devolvió» sin motivo es una llamada de soporte.
  if (reason.length < 5) {
    return { error: 'Escribe por qué se devuelve: son al menos 5 caracteres.' };
  }
  if (approvedBy !== '' && !/^\d{4,6}$/.test(approverPin)) {
    return { error: 'Falta el PIN de quien aprueba (4 a 6 dígitos).' };
  }
  if (approvedBy === '' && approverPin !== '') {
    return { error: 'Elige a quién pertenece ese PIN.' };
  }

  try {
    const r = await panel.devolver(intentId, {
      reason,
      ...(approvedBy !== '' ? { approvedBy } : {}),
      ...(approverPin !== '' ? { approverPin } : {}),
    });
    revalidatePath(`/panel/pedidos/${orderId}`);
    // «En cola», no «devuelto»: el dinero lo devuelve el barrido, que es una
    // llamada a un tercero. Decir «devuelto» aquí sería prometer por la
    // pasarela, y el cliente lo comprobará en su banco.
    return {
      ok: r.requiresApproval
        ? 'Aprobada y en cola. El dinero sale en la siguiente vuelta.'
        : 'En cola. El dinero sale en la siguiente vuelta.',
    };
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return {
        error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.',
      };
    }
    if (error instanceof PanelApiError) return { error: error.message };
    return { error: 'No se pudo pedir la devolución. Inténtalo de nuevo.' };
  }
}
