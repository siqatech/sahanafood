'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoCapacidad {
  error?: string;
  ok?: string;
  /**
   * Lo que la persona acababa de escribir.
   *
   * Existe porque **una acción de servidor que falla vuelve a renderizar la
   * página**, y con ella el formulario: los campos no controlados vuelven a su
   * valor por defecto y se pierde todo lo tecleado. En un formulario de un
   * campo se nota poco; en este, que tiene cinco, equivocarse en uno significa
   * volver a escribir los otros cuatro — y a la segunda vez la gente deja de
   * corregir y guarda cualquier cosa.
   */
  valores?: {
    maxConcurrentItems: string;
    extendMinutes: string;
    pauseThresholdItems: string;
    channelPauseOrder: string;
    enabled: boolean;
  };
}

/**
 * Fija los umbrales de una cocina (RN-KIT-04).
 *
 * No es configuración de pantalla: **decide cuántas ventas se dejan de aceptar
 * en hora punta**. Por eso el permiso es del dueño y por eso los dos números se
 * validan uno contra otro aquí antes de salir — un umbral de pausa por debajo
 * del de extensión pausaría canales sin haber intentado antes lo barato, que es
 * alargar la promesa.
 */
export async function guardarCapacidad(
  _prev: EstadoCapacidad,
  form: FormData,
): Promise<EstadoCapacidad> {
  const kitchenId = String(form.get('kitchenId') ?? '');
  const max = String(form.get('maxConcurrentItems') ?? '').trim();
  const minutos = String(form.get('extendMinutes') ?? '').trim();
  const pausa = String(form.get('pauseThresholdItems') ?? '').trim();
  const orden = String(form.get('channelPauseOrder') ?? '').trim();
  const activo = form.get('enabled') === 'on';

  // Se devuelve con CADA error: si se construye solo en algunos, el usuario
  // pierde lo escrito justo en los caminos que se olvidaron.
  const valores = {
    maxConcurrentItems: max,
    extendMinutes: minutos,
    pauseThresholdItems: pausa,
    channelPauseOrder: orden,
    enabled: activo,
  };

  const entero = (v: string): number | null =>
    /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null;

  const maxItems = entero(max);
  const extend = entero(minutos);
  if (maxItems === null) {
    return {
      error: 'El primer umbral es un número de platos, mayor que cero.',
      valores,
    };
  }
  if (extend === null) {
    return {
      error: 'Los minutos de extensión son un número mayor que cero.',
      valores,
    };
  }

  let pauseThresholdItems: number | null = null;
  if (pausa !== '') {
    pauseThresholdItems = entero(pausa);
    if (pauseThresholdItems === null) {
      return { error: 'El segundo umbral es un número de platos.', valores };
    }
    if (orden === '') {
      // Lo exige la API, y con razón: un umbral que cierra canales sin decir
      // CUÁLES no es una política, es una lotería en la que el sistema elige
      // por su cuenta de qué canal deja de entrar dinero.
      // El mensaje no promete una sugerencia: el orden sugerido sale de las
      // comisiones por canal, y un negocio que aún no las ha configurado no
      // tiene ninguna. Prometerla y que el campo esté vacío es peor que no
      // mencionarla.
      return {
        error:
          'Si vas a cerrar canales, di en qué orden: por ejemplo «rappi, pedidosya, web». Se cierran de izquierda a derecha.',
        valores,
      };
    }
    if (pauseThresholdItems <= maxItems) {
      // El orden importa: primero se alarga la promesa (se sigue vendiendo) y
      // solo después se cierran canales. Invertirlo apaga ventas antes de
      // haber probado lo que no cuesta nada.
      return {
        error: `El umbral de pausa (${pauseThresholdItems}) tiene que ser MAYOR que el de extensión (${maxItems}): primero se alarga la promesa, y solo si aun así no se da abasto se cierran canales.`,
        valores,
      };
    }
  }

  try {
    await panel.ponerCapacidad(kitchenId, {
      maxConcurrentItems: maxItems,
      extendMinutes: extend,
      pauseThresholdItems,
      enabled: activo,
      ...(orden !== ''
        ? {
            channelPauseOrder: orden
              .split(',')
              .map((c) => c.trim())
              .filter((c) => c !== ''),
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof SesionCaducada) {
      return {
        error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.',
        valores,
      };
    }
    if (error instanceof PanelApiError) return { error: error.message };
    return { error: 'No se pudo guardar. Inténtalo de nuevo.', valores };
  }
  revalidatePath('/panel/cocina');
  return { ok: 'Umbrales guardados.' };
}
