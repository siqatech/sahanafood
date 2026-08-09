'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoCarta {
  error?: string;
  ok?: string;
}

/**
 * Acciones de la carta.
 *
 * Todas de servidor, como en la tienda: el precio lo pone el servidor y el
 * navegador ni siquiera tiene la oportunidad de proponer uno. Aquí importa
 * todavía más — quien edita la carta está cambiando lo que se cobra.
 */

function traducir(error: unknown): EstadoCarta {
  if (error instanceof SesionCaducada) {
    // Una acción no puede redirigir a refrescar sin perder lo que el operador
    // acababa de escribir. Se lo decimos y recarga: el dato sigue en el campo.
    return {
      error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.',
    };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No hemos podido guardar el cambio. Inténtalo de nuevo.' };
}

/**
 * Soles escritos a mano → unidades menores, con aritmética entera.
 *
 * El mismo criterio que el archivo de alta: pasar por `Number` metería coma
 * flotante en la única cifra que no la admite.
 */
function aUnidadesMenores(valor: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,4}))?$/.exec(valor.trim());
  if (!m) return null;
  return Number(`${m[1]}${(m[2] ?? '').padEnd(4, '0')}`);
}

export async function ponerPrecio(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const canal = String(form.get('channel') ?? '').trim();
  const bruto = String(form.get('price') ?? '');

  const priceMinor = aUnidadesMenores(bruto);
  if (priceMinor === null) {
    return { error: `"${bruto}" no es un precio. Escríbelo como 12.50.` };
  }

  try {
    await panel.ponerPrecio({
      productId,
      // Vacío = precio base, que en la API es `channel` nulo.
      channel: canal === '' || canal === 'base' ? null : canal,
      priceMinor,
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return { ok: 'Precio guardado.' };
}

export async function pausar(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const canal = String(form.get('channel') ?? '*');
  const motivo = String(form.get('reason') ?? '').trim();
  // El motivo es obligatorio y no es burocracia: «sin pollo» y «se rompió la
  // freidora» se resuelven de forma distinta, y a las tres horas nadie se
  // acuerda de por qué está pausado.
  if (motivo.length < 3) {
    return {
      error: 'Escribe por qué lo pausas: en tres horas nadie se acuerda.',
    };
  }
  try {
    await panel.pausar(productId, [canal], motivo);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return { ok: 'Producto pausado.' };
}

export async function reanudar(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const productId = String(form.get('productId') ?? '');
  const canal = String(form.get('channel') ?? '*');
  try {
    await panel.reanudar(productId, [canal]);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return { ok: 'Producto reactivado.' };
}

export async function crearProducto(
  _prev: EstadoCarta,
  form: FormData,
): Promise<EstadoCarta> {
  const brandId = String(form.get('brandId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const sku = String(form.get('sku') ?? '').trim();
  const precio = String(form.get('price') ?? '').trim();
  if (name.length < 2) return { error: 'El producto necesita un nombre.' };

  const priceMinor = precio === '' ? null : aUnidadesMenores(precio);
  if (precio !== '' && priceMinor === null) {
    return { error: `"${precio}" no es un precio. Escríbelo como 12.50.` };
  }

  try {
    const creado = await panel.crearProducto({
      brandId,
      name,
      ...(sku ? { sku } : {}),
    });
    // El precio base va en la misma acción: un producto sin precio no se ve en
    // ningún canal, así que crearlo y dejarlo invisible sería crear trabajo
    // pendiente sin decirlo.
    if (priceMinor !== null) {
      await panel.ponerPrecio({ productId: creado.id, priceMinor });
    }
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/catalogo');
  return {
    ok:
      priceMinor === null
        ? `"${name}" creado. Ponle precio para que se vea en la tienda.`
        : `"${name}" creado y con precio.`,
  };
}
