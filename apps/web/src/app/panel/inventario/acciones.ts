'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoInventario {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoInventario {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo guardar. Inténtalo de nuevo.' };
}

/**
 * Costo escrito a mano → unidades menores, con aritmética entera.
 *
 * Mismo criterio que el resto del panel: pasar por `Number` metería coma
 * flotante en el número que luego multiplica cada gramo consumido en el
 * kardex. Un céntimo de deriva por gramo es un plato mal costeado.
 */
function aUnidadesMenores(valor: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,4}))?$/.exec(valor.trim());
  if (!m) return null;
  return Number(`${m[1]}${(m[2] ?? '').padEnd(4, '0')}`);
}

export async function guardarInsumo(
  _prev: EstadoInventario,
  form: FormData,
): Promise<EstadoInventario> {
  const name = String(form.get('name') ?? '').trim();
  const unit = String(form.get('unit') ?? 'g');
  const sku = String(form.get('sku') ?? '').trim();
  const costo = String(form.get('unitCost') ?? '').trim();
  const minimo = String(form.get('minStock') ?? '').trim();

  if (name.length < 2) return { error: 'El insumo necesita un nombre.' };

  const unitCostMinor = costo === '' ? 0 : aUnidadesMenores(costo);
  if (unitCostMinor === null) {
    return {
      error: `"${costo}" no es un costo. Escríbelo como 0.012 (por unidad).`,
    };
  }

  try {
    await panel.guardarInsumo({
      name,
      unit,
      unitCostMinor,
      ...(sku !== '' ? { sku } : {}),
      ...(minimo !== '' ? { minStock: minimo } : {}),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/inventario');
  return { ok: `"${name}" guardado.` };
}

/**
 * Guarda la receta de un producto con UN componente.
 *
 * Es deliberadamente la versión mínima: un plato con un insumo principal, que
 * es lo que hace que el consumo automático empiece a descontar y que el food
 * cost deje de ser cero. Las recetas con varios componentes y subrecetas se
 * arman por API o por el archivo de alta — meter aquí un editor de líneas
 * completo antes de que nadie haya usado el simple es adivinar qué necesita.
 */
export async function guardarReceta(
  _prev: EstadoInventario,
  form: FormData,
): Promise<EstadoInventario> {
  const name = String(form.get('name') ?? '').trim();
  const productId = String(form.get('productId') ?? '').trim();
  const itemId = String(form.get('itemId') ?? '').trim();
  const quantity = String(form.get('quantity') ?? '').trim();
  const yieldQuantity = String(form.get('yieldQuantity') ?? '1').trim();
  const yieldUnit = String(form.get('yieldUnit') ?? 'unit');

  if (name.length < 2) return { error: 'La receta necesita un nombre.' };
  if (itemId === '') return { error: 'Elige el insumo que consume.' };
  if (!/^\d+(\.\d{1,4})?$/.test(quantity)) {
    return { error: `"${quantity}" no es una cantidad. Escríbela como 275.` };
  }

  try {
    await panel.guardarReceta({
      name,
      ...(productId !== '' ? { productId } : {}),
      yieldQuantity,
      yieldUnit,
      lines: [{ itemId, quantity }],
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/inventario');
  return {
    ok: `"${name}" guardada. Desde ahora cada venta descuenta ese insumo.`,
  };
}
