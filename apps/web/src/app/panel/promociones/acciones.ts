'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

/**
 * Crear y cambiar promociones.
 *
 * El porcentaje se teclea como porcentaje —«10»— y se convierte a puntos
 * básicos enteros aquí, en el servidor. Que el dueño escriba «1000» para decir
 * 10 % es pedirle que piense en la unidad interna del sistema; y hacer la
 * conversión en el navegador metería aritmética de descuentos en el cliente.
 */

export interface EstadoPromocion {
  error?: string;
  ok?: string;
  /** Lo tecleado, para que un fallo no borre el formulario entero (DT-24). */
  valores?: Record<string, string>;
}

function traducir(
  error: unknown,
  valores?: Record<string, string>,
): EstadoPromocion {
  const base = valores ? { valores } : {};
  if (error instanceof SesionCaducada) {
    return { ...base, error: 'Tu sesión caducó. Recarga y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { ...base, error: error.message };
  return { ...base, error: 'No se pudo. Inténtalo de nuevo.' };
}

export async function guardarPromocion(
  _prev: EstadoPromocion,
  form: FormData,
): Promise<EstadoPromocion> {
  const texto = (k: string): string => String(form.get(k) ?? '').trim();
  const valores = {
    code: texto('code'),
    porcentaje: texto('porcentaje'),
    minOrder: texto('minOrder'),
    maxUses: texto('maxUses'),
  };

  const brandId = texto('brandId');
  if (!brandId) return { error: 'Elige la marca a la que aplica.', valores };

  const porcentaje = Number(valores.porcentaje.replace(',', '.'));
  if (!Number.isFinite(porcentaje) || porcentaje <= 0 || porcentaje > 100) {
    return { error: 'El descuento va entre 1 y 100 por ciento.', valores };
  }
  // 10 % → 1000 puntos básicos. Se redondea al entero más cercano porque la
  // base solo admite enteros: «12,5 %» son 1250 bps exactos, pero «12,345 %»
  // no cabe y hay que decidir aquí en vez de dejar que Postgres trunque.
  const percentBps = Math.round(porcentaje * 100);

  try {
    await panel.guardarPromocion({
      brandId,
      code: valores.code,
      kind: 'percent',
      percentBps,
      ...(valores.minOrder ? { minOrder: valores.minOrder } : {}),
      ...(valores.maxUses ? { maxUses: Number(valores.maxUses) } : {}),
      isWelcome: form.get('isWelcome') === 'on',
      active: true,
    });
  } catch (error) {
    return traducir(error, valores);
  }
  revalidatePath('/panel/promociones');
  return { ok: `Promoción ${valores.code.toUpperCase()} guardada.` };
}

/** Encender o apagar una promoción existente, sin tocar sus condiciones. */
export async function cambiarEstado(
  _prev: EstadoPromocion,
  form: FormData,
): Promise<EstadoPromocion> {
  const id = String(form.get('id') ?? '');
  const brandId = String(form.get('brandId') ?? '');
  const code = String(form.get('code') ?? '');
  const kind = String(form.get('kind') ?? 'percent') as 'percent';
  const percentBps = Number(form.get('percentBps') ?? 0);
  const minOrder = String(form.get('minOrder') ?? '0');

  try {
    await panel.guardarPromocion({
      id,
      brandId,
      code,
      kind,
      ...(kind === 'percent' ? { percentBps } : {}),
      minOrder,
      active: form.get('accion') === 'encender',
      isWelcome: form.get('esBienvenida') === '1',
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/promociones');
  return {};
}

/** Marca cuál se anuncia sola a quien entra por primera vez. */
export async function marcarBienvenida(
  _prev: EstadoPromocion,
  form: FormData,
): Promise<EstadoPromocion> {
  const id = String(form.get('id') ?? '');
  const brandId = String(form.get('brandId') ?? '');
  const code = String(form.get('code') ?? '');
  const percentBps = Number(form.get('percentBps') ?? 0);
  const minOrder = String(form.get('minOrder') ?? '0');
  const quitar = form.get('accion') === 'quitar';

  try {
    await panel.guardarPromocion({
      id,
      brandId,
      code,
      kind: 'percent',
      percentBps,
      minOrder,
      active: true,
      isWelcome: !quitar,
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/promociones');
  return {};
}
