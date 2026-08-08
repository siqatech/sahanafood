'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { shop, ApiError } from '../lib/api';
import { ensureCartToken, clearCartToken } from '../lib/cart-cookie';
import { TEXTO_CONSENTIMIENTO } from '../lib/consent';

/**
 * Acciones de servidor de la tienda.
 *
 * Todas las mutaciones pasan por aquí y ninguna por el navegador. No es una
 * preferencia de estilo:
 *
 *  · **El presupuesto de T5.14** (JS < 200 KB en el catálogo) se cumple no
 *    enviando JavaScript. Un formulario que postea funciona sin ninguno.
 *  · **La tienda tiene que funcionar con la red de un móvil en Lima.** Un
 *    formulario nativo sobrevive a una conexión que se corta a mitad de carga;
 *    un botón que espera a que hidrate un bundle, no.
 *  · **El precio lo pone el servidor.** El navegador ni siquiera tiene la
 *    oportunidad de proponer uno.
 */

/** Convierte el error de la API en algo que la página puede enseñar. */
function mensaje(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'No hemos podido completar la operación. Inténtalo de nuevo.';
}

export interface ActionState {
  error?: string;
}

export async function addToCart(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const productId = String(form.get('productId') ?? '');
  const quantity = Number(form.get('quantity') ?? 1);
  // Los modificadores llegan como varias entradas con el mismo nombre: es lo
  // que produce un grupo de casillas en HTML plano.
  const modifierOptionIds = form
    .getAll('modifierOptionIds')
    .map(String)
    .filter(Boolean);

  try {
    const token = await ensureCartToken();
    await shop.addLine(token, { productId, quantity, modifierOptionIds });
  } catch (error) {
    return { error: mensaje(error) };
  }
  revalidatePath('/');
  revalidatePath('/carrito');
  return {};
}

export async function removeLine(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const lineId = String(form.get('lineId') ?? '');
  try {
    const token = await ensureCartToken();
    await shop.removeLine(token, lineId);
  } catch (error) {
    return { error: mensaje(error) };
  }
  revalidatePath('/carrito');
  return {};
}

export async function applyCoupon(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = String(form.get('code') ?? '').trim();
  if (!code) return { error: 'Escribe un código.' };
  try {
    const token = await ensureCartToken();
    await shop.applyCoupon(token, code);
  } catch (error) {
    return { error: mensaje(error) };
  }
  revalidatePath('/carrito');
  return {};
}

export async function setAddress(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const address = String(form.get('address') ?? '');
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: 'Elige la dirección en el mapa para poder llegar.' };
  }
  try {
    const token = await ensureCartToken();
    await shop.setAddress(token, { address, lat, lng });
  } catch (error) {
    return { error: mensaje(error) };
  }
  revalidatePath('/checkout');
  return {};
}

/**
 * Datos del cliente y confirmación, en un solo envío.
 *
 * El consentimiento de marketing viaja con **su texto exacto** (`lib/consent`)
 * porque la ley 29733 pide poder acreditar qué se aceptó, y un booleano no
 * acredita nada. El texto es el mismo que se enseña en la casilla.
 */
export async function confirmOrder(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const name = String(form.get('name') ?? '').trim();
  const phone = String(form.get('phone') ?? '').trim();
  const notes = String(form.get('notes') ?? '').trim();
  const marketingConsent = form.get('marketingConsent') === 'on';

  if (name.length < 2)
    return { error: 'Necesitamos tu nombre para la entrega.' };
  if (phone.length < 6)
    return { error: 'Necesitamos un teléfono de contacto.' };

  let orderId: string;
  try {
    const token = await ensureCartToken();
    await shop.setCustomer(token, {
      name,
      phone,
      ...(notes ? { notes } : {}),
      marketingConsent,
      ...(marketingConsent
        ? { marketingConsentText: TEXTO_CONSENTIMIENTO }
        : {}),
    });
    const pedido = await shop.checkout(token);
    orderId = pedido.orderId;
    // El carrito ya es un pedido: la cookie apunta a algo que no se puede
    // seguir editando, así que se suelta. Si no, volver a la tienda enseñaría
    // un carrito muerto.
    await clearCartToken();
  } catch (error) {
    return { error: mensaje(error) };
  }
  // El redirect va FUERA del try: Next lo implementa lanzando, y atraparlo
  // convertiría una compra correcta en un mensaje de error.
  redirect(`/gracias?pedido=${orderId}`);
}
