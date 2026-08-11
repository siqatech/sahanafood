import { NextResponse } from 'next/server';

/**
 * Sonda de salud de la tienda, **independiente del `Host`**.
 *
 * Existe por cómo resuelve el resto de la aplicación: la tienda deduce la marca
 * del `Host` del visitante y nada más (runbook §8). Un balanceador que sondee
 * `/` llega sin nombre de cliente —o con el interno del proveedor—, así que la
 * respuesta depende de que exista una tienda para ese host: la sonda estaría
 * midiendo el alta de un cliente en vez de la salud del proceso. En Railway,
 * además, un fallo de sonda impide que el despliegue entre en servicio.
 *
 * Responde 200 mientras el proceso sirva, **aunque la API no conteste**. No es
 * dejadez: si la tienda se declarara enferma cada vez que la API se reinicia,
 * un despliegue normal de la API tiraría también la tienda, y un incidente de
 * un servicio se convertiría en dos. El estado de la API se informa en el
 * cuerpo, que es donde sirve para diagnosticar sin provocar una cascada.
 */

export const dynamic = 'force-dynamic';

const API_URL = process.env['SAHANA_API_URL'] ?? 'http://localhost:3000';

export async function GET(): Promise<NextResponse> {
  let api = 'sin respuesta';
  try {
    const respuesta = await fetch(`${API_URL}/api/v1/health`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    api = respuesta.ok ? 'ok' : `http ${respuesta.status}`;
  } catch {
    // Se queda en «sin respuesta»: el detalle del error de red no aporta nada
    // que no diga ya el propio estado, y sí filtraría la topología interna.
  }

  return NextResponse.json(
    { status: 'ok', api },
    { headers: { 'cache-control': 'no-store' } },
  );
}
