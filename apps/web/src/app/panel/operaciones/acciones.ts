'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoOperaciones {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoOperaciones {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo completar la acción. Inténtalo de nuevo.' };
}

/**
 * Acepta un pedido pendiente.
 *
 * Hasta ahora esto no se podía hacer desde ninguna pantalla: los canales con
 * aceptación manual dependían de que alguien llamara al endpoint a mano, y a
 * los diez minutos el barrido los rechazaba solo. Es decir, **todo pedido
 * manual acababa rechazado**, no por decisión de nadie sino por falta de un
 * botón.
 */
export async function aceptar(
  _prev: EstadoOperaciones,
  form: FormData,
): Promise<EstadoOperaciones> {
  const orderId = String(form.get('orderId') ?? '');
  try {
    await panel.aceptarPedido(orderId);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/operaciones');
  return { ok: 'Aceptado: ya está en cocina.' };
}

export async function rechazar(
  _prev: EstadoOperaciones,
  form: FormData,
): Promise<EstadoOperaciones> {
  const orderId = String(form.get('orderId') ?? '');
  const motivo = String(form.get('reason') ?? '').trim();
  // El motivo viaja al canal: un rechazo sin explicación es una penalización
  // sin defensa cuando el marketplace revise el mes.
  if (motivo.length < 3) {
    return { error: 'Escribe por qué se rechaza: va al canal y a auditoría.' };
  }
  try {
    await panel.rechazarPedido(orderId, motivo);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/operaciones');
  return { ok: 'Rechazado y avisado al canal.' };
}

/**
 * Reintenta un webhook que agotó sus intentos.
 *
 * Una carta muerta es un pedido que el canal dio por entregado y que aquí no
 * existe: es la única forma en que este sistema puede perder un pedido, y por
 * eso la columna de problemas la pone primero.
 */
export async function reintentar(
  _prev: EstadoOperaciones,
  form: FormData,
): Promise<EstadoOperaciones> {
  const id = String(form.get('id') ?? '');
  try {
    await panel.reintentarCartaMuerta(id);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/operaciones');
  return { ok: 'Reencolado. Si vuelve a fallar, aparecerá otra vez aquí.' };
}

/**
 * Cierra o reabre un canal a mano (RN-KIT-04).
 *
 * La saturación de cocina ya los pausa sola. Lo que faltaba era el lado humano:
 * ver cuáles están cerrados y poder abrirlos. Sin eso, el local vive que las
 * ventas se paran de golpe sin explicación y no hay ningún sitio donde
 * deshacerlo — a las nueve de la noche, con la cocina ya despejada.
 */
export async function cambiarPausa(
  _prev: EstadoOperaciones,
  form: FormData,
): Promise<EstadoOperaciones> {
  const locationId = String(form.get('locationId') ?? '');
  const channel = String(form.get('channel') ?? '');
  const paused = form.get('paused') === 'true';
  const reason = String(form.get('reason') ?? '').trim();
  const minutos = String(form.get('untilMinutes') ?? '').trim();

  if (paused && reason.length < 3) {
    return {
      error: 'Di por qué se cierra: quien llegue después tiene que saberlo.',
    };
  }

  try {
    await panel.ponerPausa({
      locationId,
      channel,
      paused,
      ...(reason !== '' ? { reason } : {}),
      ...(minutos !== '' && /^\d+$/.test(minutos)
        ? { untilMinutes: Number(minutos) }
        : {}),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/operaciones');
  return {
    ok: paused
      ? 'Canal cerrado. Deja de entrar pedidos por ahí.'
      : 'Canal abierto otra vez.',
  };
}
