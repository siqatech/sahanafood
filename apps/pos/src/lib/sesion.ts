import { almacen, type EstadoDeSesion } from './db';
import { api, ApiError, SinRed } from './api';

/**
 * Sesión del POS en el dispositivo.
 *
 * Vive en IndexedDB y no en memoria porque una tablet se bloquea, se recarga y
 * se queda sin batería a mitad de turno: pedir el PIN otra vez cada vez que el
 * navegador descarta la pestaña convertiría la seguridad en un estorbo, y un
 * estorbo se rodea (el PIN acabaría en un papel).
 *
 * El token de acceso dura quince minutos y **se refresca solo**. Si no hay red,
 * no se refresca y no pasa nada: vender no necesita token. Solo lo necesitan
 * sincronizar y el KDS, que sin red tampoco funcionarían.
 */

/** Margen para renovar antes de que caduque: una petición en curso no debe caer. */
const MARGEN_MS = 60_000;

export async function tokenVigente(): Promise<string | null> {
  const sesion = await almacen.sesion();
  if (!sesion) return null;
  if (sesion.expiresAt - MARGEN_MS > Date.now()) return sesion.accessToken;

  try {
    const nuevos = await api.refrescar(sesion.refreshToken);
    const actualizada: EstadoDeSesion = {
      ...sesion,
      accessToken: nuevos.accessToken,
      refreshToken: nuevos.refreshToken,
      expiresAt: Date.now() + nuevos.expiresIn * 1000,
    };
    await almacen.guardarSesion(actualizada);
    return actualizada.accessToken;
  } catch (error) {
    if (error instanceof SinRed) {
      // Sin red no se puede refrescar, y **eso no cierra la sesión**: el cajero
      // sigue vendiendo. Se devuelve el token caducado para que quien lo use lo
      // intente igual; si la red vuelve a media petición, funcionará.
      return sesion.accessToken;
    }
    if (error instanceof ApiError) {
      // El servidor dice que el refresco no vale: la sesión murió de verdad.
      await almacen.cerrarSesion();
      return null;
    }
    throw error;
  }
}
