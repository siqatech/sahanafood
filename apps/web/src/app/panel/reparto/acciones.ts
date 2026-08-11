'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';

export interface EstadoReparto {
  error?: string;
  ok?: string;
}

function traducir(error: unknown): EstadoReparto {
  if (error instanceof SesionCaducada) {
    return { error: 'Tu sesión caducó. Recarga la página y vuelve a entrar.' };
  }
  if (error instanceof PanelApiError) return { error: error.message };
  return { error: 'No se pudo hacer. Inténtalo de nuevo.' };
}

/**
 * Da de alta a un repartidor.
 *
 * Sin esto no hay reparto: el módulo entero —zonas, ranking de asignación,
 * saldos contra entrega— cuelga de que exista alguien a quien asignarle el
 * pedido, y no había ninguna forma de crear ese alguien desde una pantalla.
 */
export async function crearRepartidor(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const fullName = String(form.get('fullName') ?? '').trim();
  const locationId = String(form.get('locationId') ?? '').trim();
  const phone = String(form.get('phone') ?? '').trim();
  const vehicle = String(form.get('vehicle') ?? '').trim();

  if (fullName.length < 2) return { error: 'El repartidor necesita nombre.' };
  if (locationId === '') return { error: 'Elige de qué local sale.' };

  try {
    await panel.crearRepartidor({
      locationId,
      fullName,
      ...(phone !== '' ? { phone } : {}),
      ...(vehicle !== '' ? { vehicle } : {}),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: `${fullName} ya puede recibir pedidos.` };
}

export async function cambiarEstadoRepartidor(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const id = String(form.get('courierId') ?? '');
  const status = String(form.get('status') ?? '');
  try {
    await panel.estadoRepartidor(id, status);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'Estado actualizado.' };
}

/**
 * Crea el envío de un pedido que sale a reparto.
 *
 * Hoy el envío **no nace solo** al aceptar el pedido: hay que crearlo. Está
 * anotado como pregunta abierta en `docs/22-risks.md` (PA-08) porque cuándo
 * nace un envío es una decisión de dominio y la spec 09 no la fija; mientras
 * tanto, la pantalla usa el endpoint que existe en vez de que la única forma
 * sea un `curl`.
 */
export async function crearEnvio(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const orderId = String(form.get('orderId') ?? '');
  const contraEntrega = String(form.get('codAmount') ?? '').trim();

  let codAmountMinor: number | undefined;
  if (contraEntrega !== '') {
    const m = /^(\d+)(?:[.,](\d{1,4}))?$/.exec(contraEntrega);
    if (!m) {
      return { error: `"${contraEntrega}" no es un importe. Escríbelo 32.00.` };
    }
    // Aritmética entera: el importe contra entrega es el que después tiene que
    // cuadrar con la caja al liquidar el turno (RN-DLV-02).
    codAmountMinor = Number(`${m[1]}${(m[2] ?? '').padEnd(4, '0')}`);
  }

  try {
    await panel.crearEnvio({
      orderId,
      ...(codAmountMinor !== undefined ? { codAmountMinor } : {}),
    });
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'Envío creado. Ya se le puede asignar un repartidor.' };
}

export async function asignar(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const shipmentId = String(form.get('shipmentId') ?? '');
  const courierId = String(form.get('courierId') ?? '');
  if (courierId === '') return { error: 'Elige a quién se lo das.' };
  try {
    await panel.asignarEnvio(shipmentId, courierId);
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'Asignado.' };
}

/**
 * Liquida el efectivo que trae el repartidor contra una sesión de caja
 * (RN-DLV-02).
 *
 * Va contra una caja ABIERTA a propósito: el dinero entra en la gaveta de un
 * turno concreto, y liquidar contra una caja ya cerrada dejaría un ingreso sin
 * arqueo que lo respalde.
 */
export async function liquidar(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const courierId = String(form.get('courierId') ?? '');
  const sessionId = String(form.get('sessionId') ?? '').trim();
  if (sessionId === '') {
    return { error: 'No hay ninguna caja abierta contra la que liquidar.' };
  }
  try {
    const r = await panel.liquidarRepartidor(courierId, sessionId);
    revalidatePath('/panel/reparto');
    return {
      ok: `Liquidados ${r.shipments} pedidos por S/ ${r.amount}. Ya están en la caja.`,
    };
  } catch (error) {
    return traducir(error);
  }
}
