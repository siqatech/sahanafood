import { cookies } from 'next/headers';

/**
 * Sesión del panel: los dos tokens, en cookies **httpOnly**.
 *
 * Nunca en `localStorage`. Un token de acceso legible por JavaScript es un
 * token que cualquier script inyectado en la página se lleva, y con él se lee
 * la carta, los pedidos y la facturación de un cliente entero. `httpOnly` lo
 * hace inalcanzable desde el navegador, y como todas las llamadas del panel
 * salen del servidor de Next, el navegador tampoco necesita verlo.
 *
 * `sameSite: 'lax'` corta el CSRF de formularios de terceros sin romper la
 * navegación normal, y `secure` se activa fuera de desarrollo — en local no hay
 * TLS y una cookie `secure` sencillamente no se guardaría.
 */

const ACCESO = 'sahana_panel_acceso';
const REFRESCO = 'sahana_panel_refresco';

const seguro = process.env.NODE_ENV === 'production';

export interface TokensDeSesion {
  accessToken: string;
  refreshToken: string;
  /** Segundos de vida del token de acceso, tal como los da la API. */
  expiresIn: number;
}

export async function guardarSesion(tokens: TokensDeSesion): Promise<void> {
  const almacen = await cookies();
  almacen.set(ACCESO, tokens.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: seguro,
    path: '/',
    maxAge: tokens.expiresIn,
  });
  // El de refresco vive lo que dure la sesión en el servidor. Aquí se le da un
  // techo de 14 días, que es el mismo que usa la API: una cookie que sobreviva
  // al token solo sirve para que el panel intente refrescar con algo caducado.
  almacen.set(REFRESCO, tokens.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: seguro,
    path: '/',
    maxAge: 14 * 24 * 3600,
  });
}

export async function borrarSesion(): Promise<void> {
  const almacen = await cookies();
  almacen.delete(ACCESO);
  almacen.delete(REFRESCO);
}

export async function tokenDeAcceso(): Promise<string | undefined> {
  return (await cookies()).get(ACCESO)?.value;
}

export async function tokenDeRefresco(): Promise<string | undefined> {
  return (await cookies()).get(REFRESCO)?.value;
}
