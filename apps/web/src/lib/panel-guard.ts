import { redirect } from 'next/navigation';
import { SesionCaducada } from './panel-api';

/**
 * Qué hacer cuando una página del panel se encuentra con la sesión caducada.
 *
 * Manda al manejador de `/panel/refrescar`, que es el único sitio donde se
 * pueden escribir cookies (ver el comentario de esa ruta), y le dice a dónde
 * volver. El `intento` viaja de ida y vuelta para cortar el bucle: si la página
 * vuelve a dar 401 **después** de refrescar, la sesión está muerta de verdad y
 * toca entrar de nuevo, no rebotar para siempre entre dos redirecciones.
 */
export function reintentarSesion(ruta: string, yaSeIntento: boolean): never {
  const partes = [`destino=${encodeURIComponent(ruta)}`];
  if (yaSeIntento) partes.push('intento=1');
  redirect(`/panel/refrescar?${partes.join('&')}`);
}

/**
 * Envuelve la carga de datos de una página del panel.
 *
 * Existe para que ninguna pantalla tenga que acordarse del `try/catch`: una que
 * se olvide enseñaría una pantalla de error de Next —en inglés y con traza— en
 * lugar de pedir la contraseña otra vez.
 */
export async function cargar<T>(
  ruta: string,
  yaSeIntento: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SesionCaducada) reintentarSesion(ruta, yaSeIntento);
    throw error;
  }
}
