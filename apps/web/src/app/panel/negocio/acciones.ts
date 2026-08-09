'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoNegocio {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoNegocio {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No hemos podido guardar el cambio. Inténtalo de nuevo.' };
}

export async function crearMarca(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const companyId = String(form.get('companyId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  if (name.length < 2) return { error: 'La marca necesita un nombre.' };
  try {
    const marca = await panel.crearMarca({ companyId, name });
    revalidatePath('/panel/negocio');
    revalidatePath('/panel/catalogo');
    return {
      ok: `Marca "${name}" creada. Su identificador para la tienda es "${marca.slug}".`,
    };
  } catch (error) {
    return traducir(error);
  }
}

export async function crearLocal(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const companyId = String(form.get('companyId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const address = String(form.get('address') ?? '').trim();
  if (name.length < 2) return { error: 'El local necesita un nombre.' };
  if (address.length < 4) return { error: 'El local necesita una dirección.' };
  try {
    await panel.crearLocal({ companyId, name, address });
    revalidatePath('/panel/negocio');
    return {
      ok: `Local "${name}" creado. Para que reparta, le falta una zona: eso todavía va por el archivo de configuración.`,
    };
  } catch (error) {
    return traducir(error);
  }
}
