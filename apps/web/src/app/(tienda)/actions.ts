'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { shop, ApiError } from '../../lib/api';
import { ensureCartToken, clearCartToken } from '../../lib/cart-cookie';
import { TEXTO_CONSENTIMIENTO } from '../../lib/consent';

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

/**
 * Añadir al carrito.
 *
 * Termina en `redirect`, y ese es el arreglo del fallo que hacía que la tienda
 * pareciera rota: antes devolvía `{}` en silencio. Como el enlace del carrito no
 * llevaba contador ni había ninguna confirmación, un añadido CORRECTO se veía
 * exactamente igual que uno fallido — la página se quedaba como estaba. La
 * queja «el carrito no funciona» era, la mitad de las veces, un carrito que sí
 * había recibido el plato y no lo decía.
 *
 * Ahora vuelve a la carta con el nombre de lo añadido, que la carta enseña como
 * confirmación, y con el carrito ya actualizado en la barra de abajo. El
 * `redirect` además evita que recargar reenvíe el formulario y duplique la
 * línea.
 */
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

  let nombre = '';
  try {
    const token = await ensureCartToken();
    const carrito = await shop.addLine(token, {
      productId,
      quantity,
      modifierOptionIds,
    });
    nombre = carrito.lines.at(-1)?.name ?? '';
  } catch (error) {
    return { error: mensaje(error) };
  }
  revalidatePath('/');
  revalidatePath('/carrito');
  // Fuera del `try`: Next implementa el redirect lanzando, y atraparlo
  // convertiría un añadido correcto en un mensaje de error.
  redirect(`/?anadido=${encodeURIComponent(nombre)}`);
}

/**
 * Cambia la cantidad de una línea del carrito. `0` la quita.
 *
 * Sin esto, «quiero dos» obligaba a volver a la carta y añadir el plato otra
 * vez —eligiendo de nuevo todas sus opciones— y encima salían dos líneas de uno
 * en vez de una de dos.
 */
export async function setQuantity(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const lineId = String(form.get('lineId') ?? '');
  const quantity = Number(form.get('quantity') ?? 0);
  try {
    const token = await ensureCartToken();
    await shop.setLineQuantity(token, lineId, quantity);
  } catch (error) {
    return { error: mensaje(error) };
  }
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

  // Solo dos valores, y el que no reconozcamos cae en contra entrega. Un valor
  // raro aquí no puede acabar en «pagado»: lo peor que puede pasar es que el
  // repartidor cobre.
  const pago = form.get('payment') === 'online' ? 'online' : 'on_delivery';

  let orderId: string;
  let irAPasarela: string | null = null;
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
    const pedido = await shop.checkout(token, pago);
    orderId = pedido.orderId;
    irAPasarela = pedido.payment?.checkoutUrl ?? null;
    // El carrito ya es un pedido: la cookie apunta a algo que no se puede
    // seguir editando, así que se suelta. Si no, volver a la tienda enseñaría
    // un carrito muerto.
    await clearCartToken();
  } catch (error) {
    return { error: mensaje(error) };
  }
  // El redirect va FUERA del try: Next lo implementa lanzando, y atraparlo
  // convertiría una compra correcta en un mensaje de error.
  //
  // Con pago en línea se va a la PÁGINA DE LA PASARELA, y ahí es donde salen
  // las carteras: Apple Pay y Google Pay no son medios que cobremos nosotros
  // —son un token de red que la pasarela desencripta—, así que quien los pinta
  // es su checkout, no el nuestro. Es además lo que evita que un solo dato de
  // tarjeta pase por nuestro servidor.
  //
  // Si la pasarela no devuelve página, el pedido está hecho igual y el cobro se
  // resuelve por el enlace de pago: llevar al comprador a una URL vacía sería
  // peor que enseñarle su confirmación.
  if (irAPasarela) redirect(irAPasarela);
  redirect(`/gracias?pedido=${orderId}`);
}
