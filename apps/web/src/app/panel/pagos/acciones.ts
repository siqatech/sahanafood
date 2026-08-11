'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

/** Conectar la pasarela del negocio. */

export interface EstadoPasarela {
  error?: string;
  ok?: string;
  /** La ruta de aviso, para enseñarla una vez creada. */
  callbackPath?: string;
  valores?: Record<string, string>;
}

const MEDIOS = ['card', 'yape', 'plin', 'apple_pay', 'google_pay'] as const;

export async function conectarPasarela(
  _prev: EstadoPasarela,
  form: FormData,
): Promise<EstadoPasarela> {
  const texto = (k: string): string => String(form.get(k) ?? '').trim();
  const valores = { provider: texto('provider'), apiKey: '' };

  const webhookSecret = texto('webhookSecret');
  if (webhookSecret.length < 16) {
    return {
      error:
        'El secreto de firma tiene que tener al menos 16 caracteres. Es el que te da la pasarela para comprobar que los avisos son suyos.',
      valores,
    };
  }

  const methods = MEDIOS.filter((m) => form.get(`medio-${m}`) === 'on');

  try {
    const creada = await panel.conectarPasarela({
      provider: valores.provider,
      webhookSecret,
      ...(texto('apiKey') ? { apiKey: texto('apiKey') } : {}),
      ...(methods.length > 0 ? { methods: [...methods] } : {}),
    });
    revalidatePath('/panel/pagos');
    return {
      ok: 'Pasarela conectada.',
      // Se devuelve para enseñarla en el acto: es lo que hay que pegar en el
      // panel de la pasarela, y sin ello no llegan las confirmaciones de pago.
      callbackPath: creada.callbackPath,
    };
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return { error: 'Tu sesión caducó. Recarga y vuelve a entrar.', valores };
    }
    if (error instanceof PanelApiError)
      return { error: error.message, valores };
    return { error: 'No se pudo conectar. Inténtalo de nuevo.', valores };
  }
}
