'use server';

import { revalidatePath } from 'next/cache';
import { panel, PanelApiError, SesionCaducada } from '../../../lib/panel-api';
import { revisarMotivo } from './motivo';

export interface EstadoReparto {
  error?: string;
  ok?: string;
  /**
   * Lo que se acababa de escribir, para devolvérselo al formulario.
   *
   * React **vacía los campos no controlados** al terminar una acción de
   * servidor, y ese vaciado llega DESPUÉS del mensaje de error: sin esto, quien
   * empieza a corregir en cuanto lee el aviso ve desaparecer lo que teclea.
   */
  valores?: Record<string, string>;
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
      return {
        error: `"${contraEntrega}" no es un importe. Escríbelo 32.00.`,
        valores: { codAmount: contraEntrega },
      };
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
 * Recogido: el repartidor ya lleva el pedido encima.
 *
 * Es el paso que hace que el seguimiento del cliente diga «en camino» en vez
 * de «asignado», y sin él la hora de recojo —la mitad de cualquier medición de
 * tiempos de entrega— no se registra nunca.
 */
export async function recoger(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  try {
    await panel.recogerEnvio(String(form.get('shipmentId') ?? ''));
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'En camino.' };
}

/**
 * Entregado, y si era contra entrega, si trae el dinero.
 *
 * Marcar cobrado NO mete el dinero en la caja: lo apunta como saldo del
 * repartidor hasta que liquide su turno (RN-DLV-02). Por eso la casilla se
 * ofrece marcada pero **se puede desmarcar**: pasa que el cliente pagó por app
 * a última hora, y dar por cobrado lo que nadie cobró convierte el arqueo en
 * una diferencia que nadie sabe explicar tres horas después.
 */
export async function entregar(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const id = String(form.get('shipmentId') ?? '');
  const hayContraEntrega = form.get('hayContraEntrega') === '1';
  try {
    // Solo se manda `codCollected` cuando el envío ES contra entrega: mandar
    // `false` en un pedido ya pagado sería afirmar algo sobre un cobro que no
    // existe.
    await panel.entregarEnvio(
      id,
      hayContraEntrega ? form.get('cobrado') === 'on' : undefined,
    );
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'Entregado.' };
}

/** Entrega fallida, con el motivo que después decide qué se hace (RN-DLV-03). */
export async function fallar(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const id = String(form.get('shipmentId') ?? '');
  const escrito = String(form.get('motivo') ?? '');
  const revisado = revisarMotivo(escrito);
  if ('error' in revisado) {
    return { error: revisado.error, valores: { motivo: escrito } };
  }

  try {
    await panel.fallarEnvio(id, revisado.motivo);
  } catch (error) {
    return { ...traducir(error), valores: { motivo: escrito } };
  }
  revalidatePath('/panel/reparto');
  return { ok: 'Anotado. Ahora decide si se reintenta o se devuelve.' };
}

/** Otro intento: vuelve a la cola SIN repartidor, para reasignarlo con criterio. */
export async function reintentar(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  try {
    await panel.reintentarEnvio(String(form.get('shipmentId') ?? ''));
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'De vuelta a la cola. Asígnalo a quien puedas.' };
}

/**
 * Se devuelve al local. Es terminal: de aquí no se sale.
 *
 * Qué pasa con la comida —merma o vuelve al stock— lo decide Inventory según
 * la política, y esta pantalla no lo prejuzga.
 */
export async function devolver(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  try {
    await panel.devolverEnvio(String(form.get('shipmentId') ?? ''));
  } catch (error) {
    return traducir(error);
  }
  revalidatePath('/panel/reparto');
  return { ok: 'Devuelto al local.' };
}

/**
 * Emite el enlace de seguimiento para dárselo al cliente.
 *
 * El enlace se devuelve para COPIARLO, no se manda solo: hoy quien atiende
 * decide por dónde se lo pasa —WhatsApp, una llamada, el chat del marketplace—
 * y mandarlo automáticamente exigiría saber a qué número, que es justo el dato
 * que un pedido de marketplace no trae.
 *
 * Caduca a las 48 horas y no dice de quién es el pedido: quien lo abre ve
 * estado, hora estimada y el nombre de pila de quien lleva. Nada más.
 */
export async function enlaceDeSeguimiento(
  _prev: EstadoReparto,
  form: FormData,
): Promise<EstadoReparto> {
  const shipmentId = String(form.get('shipmentId') ?? '');
  const origen = String(form.get('origen') ?? '').trim();
  try {
    const { token } = await panel.enlaceDeSeguimiento(shipmentId);
    // La URL se compone con el origen del navegador de quien está en el panel,
    // que es el dominio por el que ya entró. Componerla con una variable de
    // entorno daría un enlace del dominio equivocado en cuanto un cliente use
    // el suyo — y el fallo lo descubriría el comprador, no nosotros.
    const base = origen !== '' ? origen : '';
    return { ok: `${base}/seguimiento/${token}` };
  } catch (error) {
    return traducir(error);
  }
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
