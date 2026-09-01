'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';
import { leerLiquidacion, importeDeTexto } from './liquidacion';

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

/**
 * Estado de las acciones de liquidación.
 *
 * Aparte del de la pasarela porque no comparten nada: aquel devuelve además la
 * ruta de aviso, y meter las dos cosas en un solo tipo obligaría a que cada
 * formulario ignore la mitad de los campos.
 */
export interface EstadoPagos {
  error?: string;
  ok?: string;
  /**
   * Lo que se acababa de escribir. React vacía los campos no controlados al
   * terminar una acción, y ese vaciado llega DESPUÉS del error: sin esto, un
   * archivo pegado de trescientas líneas se pierde por una fecha mal puesta.
   */
  valores?: Record<string, string>;
}

function traducir(error: unknown): EstadoPagos {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo hacer. Inténtalo de nuevo.' };
}

/**
 * Fija la comisión pactada con la pasarela para un canal (ADR-0013).
 *
 * Es lo que hace que la conciliación signifique algo: sin tarifa no hay
 * comisión estimada, así que se puede saber que el bruto cuadra pero no si la
 * pasarela cobró de más.
 *
 * Los puntos básicos son **enteros**: 350 = 3,5 %. Un porcentaje decimal en una
 * cifra que multiplica dinero es exactamente lo que ADR-0013 evita.
 */
export async function ponerTarifa(
  _prev: EstadoPagos,
  form: FormData,
): Promise<EstadoPagos> {
  const channel = String(form.get('channel') ?? '').trim();
  const provider = String(form.get('provider') ?? '').trim();
  const bruto = String(form.get('porcentaje') ?? '').trim();
  const fijo = String(form.get('fijo') ?? '').trim();

  if (channel === '') return { error: 'Elige el canal.' };

  // «3,5» se escribe así en una hoja peruana; se convierte a 350 con
  // aritmética entera, sin pasar por coma flotante.
  const m = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(bruto);
  if (!m) {
    return {
      error: `"${bruto}" no es un porcentaje. Escríbelo 3.5 para un 3,5 %.`,
      valores: { porcentaje: bruto, fijo },
    };
  }
  const percentBps = Number(`${m[1]}${(m[2] ?? '').padEnd(2, '0')}`);

  let fixedAmount: string | undefined;
  if (fijo !== '') {
    const f = importeDeTexto(fijo);
    if (f === null) {
      return {
        error: `"${fijo}" no es un importe. Escríbelo 0.50.`,
        valores: { porcentaje: bruto, fijo },
      };
    }
    fixedAmount = f;
  }

  try {
    await panel.ponerTarifa({
      channel,
      ...(provider !== '' ? { provider } : {}),
      percentBps,
      ...(fixedAmount !== undefined ? { fixedAmount } : {}),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/pagos');
  return { ok: `Comisión de ${channel} guardada.` };
}

/**
 * Importa el archivo de liquidación de la pasarela y lo concilia.
 *
 * Las dos cosas van juntas a propósito: importar sin conciliar deja el archivo
 * guardado y la pregunta sin responder, y la pregunta —«¿me pagaron lo que
 * dicen?»— es la única razón por la que alguien sube este archivo.
 *
 * Importar dos veces el mismo corte **no lo duplica**: la pasarela y su
 * referencia son únicas, y el servidor devuelve el que ya existía. Se dice,
 * porque si no, volver a subirlo y no ver una fila nueva parece que falló.
 */
export async function importarLiquidacion(
  _prev: EstadoPagos,
  form: FormData,
): Promise<EstadoPagos> {
  const provider = String(form.get('provider') ?? '').trim();
  const externalRef = String(form.get('externalRef') ?? '').trim();
  const periodStart = String(form.get('periodStart') ?? '').trim();
  const periodEnd = String(form.get('periodEnd') ?? '').trim();
  const texto = String(form.get('archivo') ?? '');
  const valores = { externalRef, periodStart, periodEnd, archivo: texto };

  if (provider === '') return { error: 'Elige la pasarela.', valores };
  if (externalRef === '') {
    return {
      error:
        'Pon la referencia del corte: es lo que evita importarlo dos veces.',
      valores,
    };
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)
  ) {
    return { error: 'Indica el periodo del corte, de fecha a fecha.', valores };
  }
  if (periodEnd < periodStart) {
    return {
      error: 'El corte termina antes de empezar. Revisa las fechas.',
      valores,
    };
  }

  const leido = leerLiquidacion(texto);
  if ('error' in leido) return { error: leido.error, valores };

  try {
    const { id, alreadyImported } = await panel.importarLiquidacion({
      provider,
      externalRef,
      periodStart,
      periodEnd,
      grossAmount: leido.liquidacion.grossAmount,
      feeAmount: leido.liquidacion.feeAmount,
      netAmount: leido.liquidacion.netAmount,
      lines: leido.liquidacion.lines,
    });
    // Se concilia SIEMPRE, también si ya estaba importado: volver a conciliar
    // un corte viejo es justamente lo que se hace cuando aparece un cobro que
    // faltaba.
    const informe = await panel.conciliar(id);
    revalidatePath('/panel/pagos');

    const partes = [
      alreadyImported
        ? `El corte ${externalRef} ya estaba importado; se ha vuelto a conciliar.`
        : `Importado el corte ${externalRef} con ${leido.liquidacion.lines.length} cobros.`,
    ];
    if (informe.unmatched > 0) {
      partes.push(
        `${informe.unmatched} cobro${informe.unmatched === 1 ? '' : 's'} de la pasarela que aquí NO consta${informe.unmatched === 1 ? '' : 'n'}.`,
      );
    }
    if (informe.missing > 0) {
      partes.push(
        `${informe.missing} cobro${informe.missing === 1 ? '' : 's'} nuestro${informe.missing === 1 ? '' : 's'} que la liquidación no menciona.`,
      );
    }
    if (!informe.totalsMatch) {
      partes.push('El total declarado NO cuadra con la suma de sus líneas.');
    }
    if (informe.status === 'reconciled' && partes.length === 1) {
      partes.push('Todo cuadra.');
    }
    return { ok: partes.join(' ') };
  } catch (error) {
    return { ...traducir(error), valores };
  }
}
