'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoMensajeria {
  error?: string;
  ok?: string;
  valores?: Record<string, string>;
}

/**
 * Registra o revoca el consentimiento de un número (RN-T10).
 *
 * El **texto exacto** es obligatorio y no es burocracia: un booleano no
 * demuestra qué aceptó nadie. Cuando alguien reclame —o pregunte una
 * autoridad—, lo que se enseña es la frase que la persona leyó, con su fecha y
 * de dónde salió.
 *
 * Dar de baja **sí** se puede hacer siempre: si alguien dice por teléfono que
 * no quiere más mensajes, exigirle que lo escriba por WhatsApp sería usar la
 * herramienta como excusa.
 */
export async function registrarConsentimiento(
  _prev: EstadoMensajeria,
  form: FormData,
): Promise<EstadoMensajeria> {
  const phone = String(form.get('phone') ?? '').trim();
  const action = String(form.get('action') ?? 'granted');
  const source = String(form.get('source') ?? '').trim();
  const consentText = String(form.get('consentText') ?? '').trim();
  const valores = { phone, source, consentText };

  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return {
      error: 'El teléfono va en formato internacional: +51987654321.',
      valores,
    };
  }
  if (source === '') {
    return {
      error: 'Di de dónde salió: tienda, mostrador, teléfono…',
      valores,
    };
  }
  if (consentText.length < 5) {
    return {
      error:
        'Escribe el texto exacto que aceptó (o las palabras con las que pidió la baja). Un «sí» sin texto no demuestra nada.',
      valores,
    };
  }

  try {
    await panel.registrarConsentimiento({
      phone,
      action: action === 'revoked' ? 'revoked' : 'granted',
      source,
      consentText,
    });
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return { error: 'Tu sesión caducó. Recarga y vuelve a entrar.', valores };
    }
    if (error instanceof PanelApiError) {
      return { error: error.message, valores };
    }
    return { error: 'No se pudo registrar. Inténtalo de nuevo.', valores };
  }
  revalidatePath('/panel/mensajeria');
  return {
    ok:
      action === 'revoked'
        ? 'De baja. Deja de recibir mensajes ahora mismo.'
        : 'Consentimiento registrado con su texto.',
  };
}
