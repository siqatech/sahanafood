'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoCanales {
  error?: string;
  ok?: string;
  valores?: Record<string, string>;
}

function traducir(
  error: unknown,
  valores?: Record<string, string>,
): EstadoCanales {
  const base = valores ? { valores } : {};
  if (error instanceof SesionCaducada) {
    return { ...base, error: 'Tu sesión caducó. Recarga y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { ...base, error: error.message };
  return { ...base, error: 'No se pudo. Inténtalo de nuevo.' };
}

/**
 * Conecta un canal externo.
 *
 * El **secreto de firma** es lo que separa un pedido real de uno inventado: con
 * él se verifica que el aviso viene del marketplace y no de alguien que
 * descubrió la URL. Por eso se pide aquí y por eso no se vuelve a enseñar
 * nunca: la API lo devuelve redactado incluso al propietario.
 */
export async function conectarCanal(
  _prev: EstadoCanales,
  form: FormData,
): Promise<EstadoCanales> {
  const provider = String(form.get('provider') ?? '').trim();
  const channel = String(form.get('channel') ?? '').trim();
  const brandId = String(form.get('brandId') ?? '');
  const locationId = String(form.get('locationId') ?? '');
  const signingSecret = String(form.get('signingSecret') ?? '');
  const valores = { provider, channel };

  if (provider === '' || channel === '') {
    return { error: 'Elige el conector y el canal.', valores };
  }
  if (signingSecret.length < 16) {
    return {
      error:
        'El secreto de firma necesita al menos 16 caracteres: es lo que impide que cualquiera invente pedidos.',
      valores,
    };
  }

  try {
    await panel.crearConexion({
      provider,
      channel,
      brandId,
      locationId,
      signingSecret,
    });
  } catch (error) {
    return traducir(error, valores);
  }
  revalidatePath('/panel/canales');
  return {
    ok: `Conectado ${channel}. Copia la URL del webhook en el panel del canal.`,
  };
}

export async function cambiarEstadoDeConexion(
  _prev: EstadoCanales,
  form: FormData,
): Promise<EstadoCanales> {
  const id = String(form.get('connectionId') ?? '');
  const status = String(form.get('status') ?? '');
  try {
    await panel.estadoDeConexion(id, status);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/canales');
  return {
    ok:
      status === 'active'
        ? 'Reactivado. Vuelven a entrar pedidos por ahí.'
        : 'Pausado. Deja de recibir pedidos y cambios de carta.',
  };
}

/**
 * Registra el dominio de una tienda.
 *
 * Hasta que el DNS no se comprueba, **el dominio no sirve la tienda**: servir
 * el catálogo de una marca en un host que todavía no es suyo es exactamente
 * cómo se secuestra una tienda.
 */
export async function registrarDominio(
  _prev: EstadoCanales,
  form: FormData,
): Promise<EstadoCanales> {
  const brandId = String(form.get('brandId') ?? '');
  const host = String(form.get('host') ?? '')
    .trim()
    .toLowerCase();
  const valores = { host };

  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    return { error: `"${host}" no parece un dominio.`, valores };
  }

  try {
    const d = await panel.registrarDominio({ brandId, host });
    revalidatePath('/panel/canales');
    return {
      ok: d.verificationToken
        ? `Registrado. Añade este TXT en tu DNS y luego pulsa Verificar: ${d.verificationToken}`
        : 'Registrado y activo: es un subdominio nuestro, no hace falta verificar nada.',
    };
  } catch (error) {
    return traducir(error, valores);
  }
}

export async function verificarDominio(
  _prev: EstadoCanales,
  form: FormData,
): Promise<EstadoCanales> {
  const id = String(form.get('domainId') ?? '');
  try {
    await panel.verificarDominio(id);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/canales');
  return { ok: 'Verificado. La tienda ya se sirve en ese dominio.' };
}
