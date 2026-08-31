'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';
import {
  revisarSemana,
  revisarFeriado,
  cierraSiempre,
  type FranjaSemanal,
  type Feriado,
} from './horario';

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

/**
 * Guarda el horario semanal del local (RN-ORG-03).
 *
 * El POST de la API **reemplaza el horario entero**, así que el formulario
 * manda los siete días siempre — incluidos los vacíos, que son los cerrados—.
 * Mandar solo los que cambiaron borraría el resto de la semana en silencio.
 *
 * Los feriados ya guardados se reenvían tal cual: son otra pestaña conceptual
 * del mismo registro, y perderlos al tocar el horario de los martes sería el
 * fallo más caro de esta pantalla —el 28 de julio se abriría sin que nadie lo
 * pidiera—.
 */
export async function guardarHorario(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const locationId = String(form.get('locationId') ?? '');
  const revisado = revisarSemana((campo) => {
    const v = form.get(campo);
    return typeof v === 'string' ? v : null;
  });
  if ('error' in revisado) return { error: revisado.error };

  const feriados = leerFeriados(form.get('feriados'));

  try {
    await panel.guardarHorario({
      locationId,
      weekly: revisado.weekly,
      exceptions: feriados,
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/negocio');
  return {
    ok: cierraSiempre(revisado.weekly)
      ? 'Guardado. Ojo: así el local queda CERRADO toda la semana y la tienda no aceptará pedidos.'
      : 'Horario guardado.',
  };
}

/**
 * Añade un feriado, conservando el horario semanal y los feriados anteriores.
 *
 * Va en su propia acción porque su forma es otra —una fecha, no una semana— y
 * meterlos en el mismo formulario obligaría a rehacer catorce campos para
 * anotar que el 28 de julio se cierra.
 */
export async function anadirFeriado(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const locationId = String(form.get('locationId') ?? '');
  const revisado = revisarFeriado(
    form.get('fecha'),
    form.get('abre'),
    form.get('cierra'),
  );
  if ('error' in revisado) return { error: revisado.error };

  const semana = leerSemana(form.get('semana'));
  const previos = leerFeriados(form.get('feriados')).filter(
    (f) => f.date !== revisado.feriado.date,
  );

  try {
    await panel.guardarHorario({
      locationId,
      weekly: semana,
      exceptions: [...previos, revisado.feriado].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/negocio');
  return {
    ok:
      revisado.feriado.ranges.length === 0
        ? `El ${revisado.feriado.date} queda cerrado.`
        : `El ${revisado.feriado.date} abrirá con horario especial.`,
  };
}

/** Quita un feriado: ese día vuelve a regirse por el horario semanal. */
export async function quitarFeriado(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const locationId = String(form.get('locationId') ?? '');
  const fecha = String(form.get('fecha') ?? '');
  try {
    await panel.guardarHorario({
      locationId,
      weekly: leerSemana(form.get('semana')),
      exceptions: leerFeriados(form.get('feriados')).filter(
        (f) => f.date !== fecha,
      ),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/negocio');
  return { ok: `El ${fecha} vuelve al horario normal.` };
}

/**
 * El estado actual viaja en el formulario, serializado.
 *
 * Es feo y es a propósito: la alternativa es leerlo del servidor dentro de la
 * acción, y entre esa lectura y la escritura cabe el cambio de otra persona.
 * Aquí, lo que se guarda es exactamente lo que estaba en la pantalla que el
 * operador vio. Si el JSON viniera roto, se prefiere no escribir nada antes que
 * escribir una semana vacía.
 */
function leerSemana(bruto: FormDataEntryValue | null): FranjaSemanal[] {
  if (typeof bruto !== 'string' || bruto === '') return [];
  try {
    const v: unknown = JSON.parse(bruto);
    return Array.isArray(v) ? (v as FranjaSemanal[]) : [];
  } catch {
    return [];
  }
}

function leerFeriados(bruto: FormDataEntryValue | null): Feriado[] {
  if (typeof bruto !== 'string' || bruto === '') return [];
  try {
    const v: unknown = JSON.parse(bruto);
    return Array.isArray(v) ? (v as Feriado[]) : [];
  } catch {
    return [];
  }
}

/**
 * Crea una cocina en un local.
 *
 * Sin cocina no hay dónde producir: los tickets salen a las estaciones de una
 * cocina y una marca sin cocina asignada no puede recibir pedidos (RN-ORG-01).
 * El endpoint existía desde T3.12 y no lo llamaba ninguna pantalla, así que un
 * negocio montado desde el panel no podía vender y nada lo decía.
 */
export async function crearCocina(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const locationId = String(form.get('locationId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  if (name.length < 2) return { error: 'La cocina necesita un nombre.' };
  try {
    await panel.crearCocina({ locationId, name });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/negocio');
  return {
    ok: `Cocina "${name}" creada. Ponle al menos una estación y únela a una marca.`,
  };
}

/**
 * Crea una estación dentro de una cocina.
 *
 * Es a las estaciones a las que salen los tickets: una cocina sin estaciones no
 * enseña nada en el KDS por mucho que entren pedidos.
 */
export async function crearEstacion(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const kitchenId = String(form.get('kitchenId') ?? '');
  const name = String(form.get('name') ?? '').trim();
  if (name.length < 2) return { error: 'La estación necesita un nombre.' };
  try {
    await panel.crearEstacion({ kitchenId, name });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/negocio');
  return { ok: `Estación "${name}" creada.` };
}

/**
 * Une una marca a una cocina (RN-ORG-01).
 *
 * Es la relación que decide si una marca puede vender: Ordering valida que haya
 * dónde cocinar y rechaza el pedido si no. Una misma cocina puede producir
 * varias marcas —es la idea entera de una dark kitchen— y una marca puede
 * producirse en varias cocinas.
 */
export async function unirMarcaACocina(
  _prev: EstadoNegocio,
  form: FormData,
): Promise<EstadoNegocio> {
  const brandId = String(form.get('brandId') ?? '');
  const kitchenId = String(form.get('kitchenId') ?? '');
  if (kitchenId === '') return { error: 'Elige la cocina.' };
  try {
    await panel.unirMarcaACocina({ brandId, kitchenId });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/negocio');
  return { ok: 'Unida. Esa marca ya se puede producir ahí.' };
}
