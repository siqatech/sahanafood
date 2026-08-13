import Link from 'next/link';
import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { soles } from '../caja/dinero';
import { Canal } from '../canal';

/**
 * Pedidos: buscador y estado (specs/ux/03, «Pedidos»).
 *
 * La pantalla que se abre cuando suena el teléfono y alguien pregunta «¿dónde
 * está mi pedido?». Hasta ahora la respuesta era mirar la base de datos: no
 * había ni buscador ni forma de ver un pedido concreto desde ninguna interfaz.
 *
 * Se busca por **número, referencia del canal, teléfono o nombre**, que son las
 * cuatro cosas que una persona dice por teléfono. El número va por igualdad y
 * no por coincidencia: quien dice «mi pedido es el 12» no quiere ver el 120.
 */

const ESTADOS = [
  { id: '', rotulo: 'Todos' },
  { id: 'received', rotulo: 'Por aceptar' },
  { id: 'preparing', rotulo: 'En preparación' },
  { id: 'dispatched', rotulo: 'En reparto' },
  { id: 'delivered', rotulo: 'Entregados' },
  { id: 'cancelled', rotulo: 'Cancelados' },
] as const;

const ROTULO: Record<string, string> = {
  received: 'Recibido',
  scheduled: 'Programado',
  needs_review: 'En revisión',
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo',
  packed: 'Empacado',
  dispatched: 'En reparto',
  delivered: 'Entregado',
  picked_up: 'Recogido',
  cancelled: 'Cancelado',
  rejected: 'Rechazado',
};

export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const q = typeof params['q'] === 'string' ? params['q'].trim() : '';
  const estado = typeof params['estado'] === 'string' ? params['estado'] : '';

  const pedidos = await cargar('/panel/pedidos', yaSeIntento, () =>
    panel.pedidos({
      limit: 100,
      ...(q !== '' ? { search: q } : {}),
      ...(estado !== '' ? { status: estado } : {}),
    }),
  );

  return (
    <>
      <h1>Pedidos</h1>
      <p className="panel__subtitulo">
        Busca por número, referencia del canal, teléfono o nombre. Es lo que la
        gente dice por teléfono.
      </p>

      <form className="en-linea" method="get">
        <input
          name="q"
          placeholder="12, +51987…, Rosa, EXT-441"
          aria-label="Buscar pedidos"
          defaultValue={q}
        />
        <select name="estado" defaultValue={estado} aria-label="Estado">
          {ESTADOS.map((e) => (
            <option key={e.id} value={e.id}>
              {e.rotulo}
            </option>
          ))}
        </select>
        <button type="submit">Buscar</button>
      </form>

      {pedidos.length === 0 ? (
        <p className="panel__vacio">
          {q === '' && estado === ''
            ? 'Todavía no hay pedidos.'
            : 'Ningún pedido coincide. Prueba con el teléfono, que casi siempre se acierta.'}
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Nº</th>
                <th>Canal</th>
                <th>Estado</th>
                <th className="dinero">Total</th>
                <th>Entró</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pedidos.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>#{p.orderNumber}</strong>
                  </td>
                  <td>
                    <Canal canal={p.channel} />
                  </td>
                  <td>{ROTULO[p.status] ?? p.status}</td>
                  <td className="dinero">S/ {soles(p.total)}</td>
                  <td>
                    {new Date(p.createdAt).toLocaleString('es-PE', {
                      timeZone: 'America/Lima',
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <Link href={`/panel/pedidos/${p.id}`}>Ver</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tarjeta__pie">
        {pedidos.length === 1 ? '1 pedido' : `${pedidos.length} pedidos`}
        {pedidos.length === 100 ? ' (hay más: afina la búsqueda)' : ''}
      </p>
    </>
  );
}
