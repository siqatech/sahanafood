import Link from 'next/link';
import { panel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { soles } from '../caja/dinero';
import { Canal } from '../canal';
import { Chips } from '../chips';
import { Vacio } from '../vacio';

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

/**
 * Los canales que se ofrecen como filtro.
 *
 * Lista fija, igual que en la torre de control: hay que poder preguntar «¿qué
 * entró por Rappi?» aunque hoy no haya entrado nada, y una lista deducida de
 * los pedidos existentes escondería justo el caso interesante — que un canal
 * dejó de vender.
 */
const CANALES = [
  { valor: '', rotulo: 'Todos' },
  { valor: 'web', rotulo: 'Tienda web' },
  { valor: 'pos', rotulo: 'Mostrador' },
  { valor: 'whatsapp', rotulo: 'WhatsApp' },
  { valor: 'rappi', rotulo: 'Rappi' },
  { valor: 'pedidosya', rotulo: 'PedidosYa' },
];

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
  const canal = typeof params['canal'] === 'string' ? params['canal'] : '';
  const sinFiltro = q === '' && estado === '' && canal === '';

  /** Los filtros vivos, para que cada chip conserve los otros. */
  const otros: Record<string, string> = {};
  if (q !== '') otros['q'] = q;
  if (estado !== '') otros['estado'] = estado;
  if (canal !== '') otros['canal'] = canal;

  const pedidos = await cargar('/panel/pedidos', yaSeIntento, () =>
    panel.pedidos({
      limit: 100,
      ...(q !== '' ? { search: q } : {}),
      ...(estado !== '' ? { status: estado } : {}),
      ...(canal !== '' ? { channel: canal } : {}),
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
        {/* Los chips van en la URL, así que el buscador tiene que arrastrarlos
            o buscar borraría el filtro que se acaba de poner. */}
        {estado !== '' ? (
          <input type="hidden" name="estado" value={estado} />
        ) : null}
        {canal !== '' ? (
          <input type="hidden" name="canal" value={canal} />
        ) : null}
        <button type="submit">Buscar</button>
      </form>

      <Chips
        nombre="estado"
        actual={estado}
        base="/panel/pedidos"
        otros={Object.fromEntries(
          Object.entries(otros).filter(([k]) => k !== 'estado'),
        )}
        etiqueta="Filtrar por estado"
        opciones={ESTADOS.map((e) => ({ valor: e.id, rotulo: e.rotulo }))}
      />
      <Chips
        nombre="canal"
        actual={canal}
        base="/panel/pedidos"
        otros={Object.fromEntries(
          Object.entries(otros).filter(([k]) => k !== 'canal'),
        )}
        etiqueta="Filtrar por canal"
        opciones={CANALES}
      />

      {pedidos.length === 0 ? (
        // Un filtro que no devuelve nada SÍ tiene acción: quitarlo. Sin ese
        // botón, la salida es borrar tres campos a mano y el operador acaba
        // concluyendo que el pedido se perdió.
        sinFiltro ? (
          <Vacio titulo="Todavía no hay pedidos" enOrden>
            <p>
              Aparecerán aquí en cuanto entre el primero, de cualquier canal.
            </p>
          </Vacio>
        ) : (
          <Vacio
            titulo="Ningún pedido coincide"
            accion={{ href: '/panel/pedidos', rotulo: 'Quitar los filtros' }}
          >
            <p>Prueba con el teléfono, que casi siempre se acierta.</p>
          </Vacio>
        )
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

      <p className="pie-listado">
        <span className="tarjeta__pie">
          {pedidos.length === 1 ? '1 pedido' : `${pedidos.length} pedidos`}
          {pedidos.length === 100 ? ' (hay más: afina la búsqueda)' : ''}
        </span>
        {/* Exporta LO FILTRADO, no todo: quien pulsa después de filtrar por
            cancelados quiere los cancelados, y un archivo que ignora los
            filtros se parece demasiado al bueno para notarlo a tiempo. Por eso
            el enlace arrastra la misma consulta que la pantalla. */}
        {pedidos.length > 0 ? (
          <a
            className="boton-enlace"
            href={`/panel/pedidos/csv${
              Object.keys(otros).length > 0
                ? `?${new URLSearchParams(otros).toString()}`
                : ''
            }`}
          >
            Exportar CSV
          </a>
        ) : null}
      </p>
    </>
  );
}
