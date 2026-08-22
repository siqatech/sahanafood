'use server';

import { revalidatePath } from 'next/cache';
import {
  panel,
  PanelApiError,
  SesionCaducada,
  type ResultadoDeImportacion,
} from '../../../../lib/panel-api';

/**
 * Importar la carta desde una hoja pegada (docs/26 §2).
 *
 * Dos acciones y no una: **previsualizar** y **aplicar**. Podrían ser la misma
 * con una casilla, y sería peor — una casilla marcada por error escribe ciento
 * ochenta precios. Aquí el botón de aplicar solo existe *después* de ver el
 * resumen, así que aplicar sin mirar no es un descuido posible: es imposible.
 */

export interface EstadoImportacion {
  error?: string;
  ok?: string;
  /** Lo que se pegó, para no perderlo al recargar con el resultado. */
  csv?: string;
  resultado?: ResultadoDeImportacion;
}

function traducir(error: unknown): EstadoImportacion {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No hemos podido leer la hoja. Inténtalo de nuevo.' };
}

async function ejecutar(
  form: FormData,
  dryRun: boolean,
): Promise<EstadoImportacion> {
  const brandId = String(form.get('brandId') ?? '');
  const csv = String(form.get('csv') ?? '');

  if (csv.trim() === '') {
    return { error: 'Pega la carta antes de continuar.', csv };
  }

  try {
    const resultado = await panel.importarCarta({ brandId, csv, dryRun });
    if (dryRun) {
      // Sin «ok» en la simulación: no se guardó nada, y felicitar por algo que
      // no ocurrió es exactamente cómo alguien cierra la pestaña creyendo que
      // ya subió su carta.
      return { csv, resultado };
    }
    revalidatePath('/panel/catalogo');
    return {
      csv,
      resultado,
      ok: `Carta aplicada: ${resultado.nuevos} platos nuevos y ${resultado.actualizados} actualizados.`,
    };
  } catch (error) {
    return { ...traducir(error), csv };
  }
}

export async function previsualizar(
  _prev: EstadoImportacion,
  form: FormData,
): Promise<EstadoImportacion> {
  return ejecutar(form, true);
}

export async function aplicar(
  _prev: EstadoImportacion,
  form: FormData,
): Promise<EstadoImportacion> {
  return ejecutar(form, false);
}
