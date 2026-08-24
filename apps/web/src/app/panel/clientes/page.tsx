import Link from 'next/link';
import { panel, type ClienteDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { solesDeTexto } from '../caja/dinero';
import { Canal } from '../canal';
import { Vacio } from '../vacio';

/**
 * Clientes (spec 14, la parte de F5; `specs/ux/03` la lista en la estructura).
 *
 * Ordenados **por lo que gastaron**, no por fecha: la pregunta que trae a
 * alguien aquí casi nunca es «quién pidió hace poco» —para eso está el listado
 * de pedidos— sino «quiénes son los que sostienen el negocio».
 *
 * El cliente no es una tabla: se deriva de sus pedidos agrupados por teléfono,
 * que es la única clave que él mismo escribe igual en los cinco canales.
 */
function momento(iso: string): string {
  return new Date(iso).toLocaleDateString('es-PE', {
    timeZone: 'America/Lima',
  });
}

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const q = typeof params['q'] === 'string' ? params['q'].trim() : '';

  const clientes = await cargar('/panel/clientes', yaSeIntento, () =>
    panel.clientes(q || undefined),
  );

  return (
    <>
      <h1>Clientes</h1>
      <p className="panel__subtitulo">
        Ordenados por lo que han gastado. Se agrupan por teléfono, así que el
        mismo señor cuenta una vez aunque pida por la web, por WhatsApp y por
        Rappi.
      </p>

      <form method="get" className="en-linea">
        <label htmlFor="cli-q" className="visualmente-oculto">
          Buscar por teléfono o nombre
        </label>
        <input
          id="cli-q"
          name="q"
          defaultValue={q}
          placeholder="Teléfono o nombre"
        />
        <button type="submit">Buscar</button>
        {q !== '' ? <Link href="/panel/clientes">Ver todos</Link> : null}
        {/* El export arrastra la MISMA búsqueda que la pantalla: quien filtró
            por «Ana» y le da a exportar espera las de Ana. Un archivo que
            ignora el filtro se parece demasiado al bueno para notarlo. */}
        {clientes.length > 0 ? (
          <a
            className="boton-enlace"
            href={`/panel/clientes/csv${
              q !== '' ? `?q=${encodeURIComponent(q)}` : ''
            }`}
          >
            Exportar CSV
          </a>
        ) : null}
      </form>

      {clientes.length === 0 ? (
        q === '' ? (
          <Vacio titulo="Todavía no hay clientes con teléfono" enOrden>
            <p>
              Aparecen solos en cuanto entre el primer pedido con teléfono. En
              mostrador es normal que no lo haya: nadie lo pide para vender un
              menú.
            </p>
          </Vacio>
        ) : (
          <Vacio
            titulo="Nadie coincide"
            accion={{ href: '/panel/clientes', rotulo: 'Ver todos' }}
          />
        )
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Canales</th>
                <th>Pedidos</th>
                <th className="dinero">Gastado</th>
                <th className="dinero">Ticket</th>
                <th>Último</th>
              </tr>
            </thead>
            <tbody>
              {clientes.map((c: ClienteDelPanel) => (
                <tr key={c.phone}>
                  <td>
                    <Link
                      href={`/panel/clientes/${encodeURIComponent(c.phone)}`}
                    >
                      <strong>{c.name ?? 'Sin nombre'}</strong>
                    </Link>
                    <br />
                    <span className="tarjeta__pie">{c.phone}</span>
                    {/* Dos estados que cambian lo que se le puede hacer a este
                        cliente, y por eso van en la fila y no escondidos. */}
                    {c.anonymized ? (
                      <span className="etiqueta">anonimizado</span>
                    ) : null}
                    {c.optedOut ? (
                      <span className="etiqueta etiqueta--pausado">
                        pidió la baja
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {c.channels.map((canal) => (
                      <Canal key={canal} canal={canal} />
                    ))}
                  </td>
                  <td>{c.orders}</td>
                  <td className="dinero">S/ {solesDeTexto(c.totalSpent)}</td>
                  <td className="dinero">S/ {solesDeTexto(c.averageTicket)}</td>
                  <td>{momento(c.lastOrderAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tarjeta__pie">
        Solo cuenta como gasto lo <strong>entregado</strong>: un pedido
        cancelado no es dinero que el cliente dejó, y sumarlo pondría arriba
        justo al que más cancela.
      </p>
    </>
  );
}
