import { NextResponse, type NextRequest } from 'next/server';
import { panel } from '../../../lib/panel-api';
import { borrarSesion, tokenDeRefresco } from '../../../lib/panel-session';

/**
 * Cerrar sesión.
 *
 * `POST` y no `GET` a propósito: cerrar sesión cambia estado en el servidor
 * —revoca el refresco—, y con `GET` bastaría una imagen remota apuntando aquí
 * para echar a alguien de su panel a mitad de un cambio de precios.
 *
 * La cookie se borra pase lo que pase con la API. Si la llamada de revocación
 * fallara y no se borrara, el operador seguiría dentro después de pulsar
 * «Salir» — que es justo lo contrario de lo que pidió, y en un mostrador
 * compartido es un problema de verdad.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const refresco = await tokenDeRefresco();
  if (refresco) await panel.salir(refresco);
  await borrarSesion();
  return NextResponse.redirect(new URL('/panel/entrar', req.url), {
    // 303: la respuesta a un POST se sigue con GET. Con el 307 por defecto el
    // navegador reenviaría el POST a la pantalla de acceso.
    status: 303,
  });
}
