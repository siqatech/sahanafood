import { NextResponse, type NextRequest } from 'next/server';
import { panel, SesionCaducada } from '../../../lib/panel-api';
import {
  borrarSesion,
  guardarSesion,
  tokenDeRefresco,
} from '../../../lib/panel-session';

/**
 * Renueva la sesión y devuelve al operador a donde estaba.
 *
 * ### Por qué esto es una ruta y no parte del renderizado
 *
 * El token de acceso dura 15 minutos y el panel se usa a ratos: sin refresco,
 * mirar las ventas, atender el mostrador y volver significaría escribir la
 * contraseña otra vez. Pero **un componente de servidor no puede escribir
 * cookies** mientras renderiza —Next lo prohíbe, y con razón: la respuesta ya
 * puede estar en camino—. Un manejador de ruta sí.
 *
 * Así que el flujo es: la página encuentra un 401, redirige aquí, aquí se
 * renueva y se vuelve. Una redirección de más a cambio de que la sesión dure lo
 * que dura el turno.
 *
 * `intento=1` corta el bucle: si tras refrescar la página vuelve a dar 401, no
 * es que el token estuviera viejo, es que la sesión murió — y entonces se va a
 * la pantalla de acceso en vez de rebotar para siempre.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const pedido = req.nextUrl.searchParams.get('destino') ?? '/panel';
  // Solo rutas internas del panel: llega por la URL, y una redirección abierta
  // aquí sería una forma cómoda de sacar a alguien del sitio en mitad de una
  // sesión válida.
  const destino = pedido.startsWith('/panel') ? pedido : '/panel';
  const yaSeIntento = req.nextUrl.searchParams.get('intento') === '1';

  const refresco = await tokenDeRefresco();
  if (!refresco || yaSeIntento) {
    await borrarSesion();
    return NextResponse.redirect(
      new URL(
        `/panel/entrar?caducada=1&destino=${encodeURIComponent(destino)}`,
        req.url,
      ),
    );
  }

  try {
    const tokens = await panel.refrescar(refresco);
    await guardarSesion(tokens);
  } catch (error) {
    await borrarSesion();
    if (!(error instanceof SesionCaducada)) throw error;
    return NextResponse.redirect(
      new URL(
        `/panel/entrar?caducada=1&destino=${encodeURIComponent(destino)}`,
        req.url,
      ),
    );
  }

  const vuelta = new URL(destino, req.url);
  vuelta.searchParams.set('intento', '1');
  return NextResponse.redirect(vuelta);
}
