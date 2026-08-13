import Link from 'next/link';
import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { Canal } from '../canal';

/**
 * Bandeja de excepciones (RN-ORD-10, specs/ux/03) — paga **DT-04**.
 *
 * La regla dice que un pedido cuyo catálogo no sabemos mapear **no se
 * descarta**: se aparta. Y eso funcionaba desde F4… en la base de datos. La
 * única forma de sacar un pedido de aquí era llamar al endpoint a mano, así que
 * en la práctica la regla se cumplía a medias: el pedido no se perdía, pero
 * tampoco llegaba a la cocina. Para el cliente que espera su comida, la
 * diferencia entre «perdido» y «apartado donde nadie lo ve» es ninguna.
 *
 * Por eso esta pantalla no es un listado más: es lo que convierte la regla en
 * algo que ocurre. Va la primera en la navegación cuando hay algo dentro,
 * porque un pedido apartado tiene reloj — el cliente ya está esperando.
 */

export default async function ExcepcionesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const pendientes = await cargar('/panel/excepciones', yaSeIntento, () =>
    panel.excepciones(),
  );

  return (
    <>
      <h1>Excepciones</h1>
      <p className="panel__subtitulo">
        Pedidos que entraron por un canal y no supimos traducir a nuestra carta.
        No se pierden: esperan aquí a que alguien diga a qué plato corresponden.
      </p>

      {params['resuelto'] ? (
        <p className="tarjeta__pie">
          Pedido resuelto: ya va camino de la cocina.
          {params['aviso']
            ? ' No se pudo guardar el mapeo para la próxima vez.'
            : ''}
        </p>
      ) : null}
      {params['rechazado'] ? (
        <p className="tarjeta__pie">Pedido rechazado y avisado al canal.</p>
      ) : null}

      {pendientes.length === 0 ? (
        <p className="panel__vacio">
          No hay nada pendiente. Todos los pedidos de los canales se están
          traduciendo solos, que es como debe ser.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Canal</th>
                <th>Esperando desde</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>#{p.orderNumber}</strong>
                  </td>
                  <td>
                    <Canal canal={p.channel} />
                  </td>
                  <td>
                    {/* Hora y no «hace 3 min»: un relativo calculado en el
                        servidor se congela en la página y miente en cuanto
                        pasa un minuto. */}
                    {new Date(p.createdAt).toLocaleString('es-PE', {
                      timeZone: 'America/Lima',
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <Link href={`/panel/excepciones/${p.id}`}>Resolver</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tarjeta__pie">
        {pendientes.length === 1
          ? '1 pedido esperando'
          : `${pendientes.length} pedidos esperando`}
      </p>
    </>
  );
}
