import { cookies } from 'next/headers';
import { shop } from './api';

/**
 * El token del carrito, guardado en una cookie.
 *
 * La cookie **no es el carrito** —el carrito vive en el servidor, ver
 * `0023_storefront.sql`—: es solo el recibo con el que se recupera. Esa
 * distinción es la que hace que «pago fallido → carrito recuperable» funcione,
 * y también la que permite mandarle a alguien su carrito por WhatsApp.
 *
 * `httpOnly` porque el token abre un carrito con el nombre y el teléfono de
 * quien compra: si el JavaScript de la página pudiera leerlo, cualquier script
 * de terceros —una etiqueta de analítica mal elegida— se lo llevaría.
 */

const COOKIE = 'sahana_cart';
const DIAS = 3;

export async function getCartToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

export async function setCartToken(token: string): Promise<void> {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // En producción la tienda es HTTPS; en desarrollo, http en localhost.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: DIAS * 24 * 60 * 60,
  });
}

export async function clearCartToken(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/**
 * Devuelve el carrito abierto, creando uno si hace falta.
 *
 * Un token caducado o de un carrito ya convertido en pedido **no es un error**:
 * es alguien que vuelve días después o que ya compró. Se abre uno nuevo en
 * silencio, porque enseñarle un error a quien viene a comprar es perder la
 * venta por un detalle de implementación.
 */
export async function ensureCartToken(): Promise<string> {
  const existente = await getCartToken();
  if (existente) {
    try {
      const carrito = await shop.getCart(existente);
      if (carrito.status === 'open') return existente;
    } catch {
      // Cae al camino de crear uno nuevo.
    }
  }
  const { token } = await shop.createCart();
  await setCartToken(token);
  return token;
}
