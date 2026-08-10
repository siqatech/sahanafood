'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoComprobante {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoComprobante {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo enviar. Inténtalo de nuevo.' };
}

/**
 * Corrige el cliente de un comprobante rechazado y lo reenvía (RN-BIL-02).
 *
 * Es la acción que faltaba para que la «cola de corrección» se pudiera
 * corregir. Reenviar sin tocar nada manda otra vez el mismo RUC que el OSE
 * acaba de rechazar, así que aquí lo primero es cambiar el dato.
 */
export async function corregir(
  _prev: EstadoComprobante,
  form: FormData,
): Promise<EstadoComprobante> {
  const id = String(form.get('id') ?? '');
  const docType = String(form.get('docType') ?? '');
  const docNumber = String(form.get('docNumber') ?? '').trim();
  const legalName = String(form.get('legalName') ?? '').trim();

  // Se valida aquí lo que se puede decir sin ir al servidor, para no gastar un
  // intento contra el OSE en un RUC de nueve dígitos.
  if (docType === 'RUC') {
    if (!/^\d{11}$/.test(docNumber)) {
      return { error: 'Un RUC son 11 dígitos. Revísalo antes de reenviar.' };
    }
    if (legalName.length < 2) {
      return { error: 'Una factura necesita la razón social del cliente.' };
    }
  }
  if (docType === 'DNI' && !/^\d{8}$/.test(docNumber)) {
    return { error: 'Un DNI son 8 dígitos.' };
  }

  try {
    await panel.corregirComprobante(id, {
      docType,
      ...(docNumber !== '' ? { docNumber } : {}),
      ...(legalName !== '' ? { legalName } : {}),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/comprobantes');
  return { ok: 'Corregido y reenviado.' };
}

/**
 * Reenvía sin tocar el dato.
 *
 * Tiene sentido cuando el rechazo NO fue por el cliente —el OSE estaba caído,
 * o devolvió un error suyo—: ahí el documento es correcto y lo único que hace
 * falta es volver a intentarlo sin esperar la siguiente vuelta del worker.
 */
export async function reenviar(
  _prev: EstadoComprobante,
  form: FormData,
): Promise<EstadoComprobante> {
  const id = String(form.get('id') ?? '');
  try {
    const doc = await panel.reenviarComprobante(id);
    revalidatePath('/panel/comprobantes');
    // Se dice el desenlace, no «enviado»: reenviar y que lo vuelvan a rechazar
    // es el caso normal, y ocultarlo hace que alguien pulse el botón diez veces.
    return doc.status === 'accepted'
      ? { ok: `Aceptado: ${doc.number ?? ''}.` }
      : {
          error: `Sigue sin pasar: ${doc.rejectionReason ?? 'el OSE no contestó'}.`,
        };
  } catch (error) {
    return traducir(error);
  }
}

/**
 * Anula un comprobante ACEPTADO con una nota de crédito.
 *
 * Nunca se borra ni se edita uno emitido: ya está declarado. Se emite otro que
 * lo revierte, y por eso el motivo es obligatorio — es lo que se lee cuando
 * alguien pregunta por qué esta venta tiene dos documentos.
 */
export async function anular(
  _prev: EstadoComprobante,
  form: FormData,
): Promise<EstadoComprobante> {
  const id = String(form.get('id') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { error: 'Di por qué se anula: queda en el comprobante nuevo.' };
  }
  try {
    await panel.notaDeCredito(id, reason);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/comprobantes');
  return { ok: 'Nota de crédito emitida.' };
}
