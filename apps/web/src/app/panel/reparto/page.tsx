import { Canal } from '../canal';
import { Vacio } from '../vacio';
import Link from 'next/link';
import {
  panel,
  type EnvioDelPanel,
  type SugerenciaDeReparto,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { soles, solesDeTexto } from '../caja/dinero';
import { momento } from '../fechas';
import {
  FormularioRepartidor,
  BotonEstadoRepartidor,
  FormularioEnvio,
  FormularioAsignacion,
  BotonLiquidar,
  BotonSeguimiento,
  AccionesDelEnvio,
  AccionesDeFallo,
} from './formularios';

/**
 * La mesa de despacho (spec 09, F5).
 *
 * El módulo de reparto está entero desde T5.15: repartidores con sus zonas, el
 * ranking de asignación de RN-DLV-01 con el motivo de cada candidato, estados
 * del envío, evidencia de entrega, saldos contra entrega y liquidación contra
 * caja. Con pruebas. Y **sin una sola pantalla**.
 *
 * En un producto que se vende como SaaS para dark kitchens *con delivery*, eso
 * significa que el pedido se cocina, se empaca… y ahí se queda: no había forma
 * de dar de alta a un repartidor, ni de crear el envío, ni de asignarlo. La
 * comida sale por la puerta igual —alguien la lleva— pero el sistema no se
 * entera, así que el cliente no tiene seguimiento, el efectivo que trae el
 * repartidor no cuadra contra ninguna caja y el histórico de tiempos de entrega
 * está vacío justo en el negocio que vive de esos tiempos.
 */

const ROTULO_ENVIO: Record<string, string> = {
  pending: 'Sin asignar',
  assigned: 'Asignado',
  picked_up: 'En camino',
  delivered: 'Entregado',
  failed: 'Fallido',
  returned: 'Devuelto',
};

const ROTULO_REPARTIDOR: Record<string, string> = {
  available: 'Disponible',
  busy: 'Con pedidos',
  off: 'Fuera de turno',
};

/** Estados de pedido que ya salieron de cocina y esperan a alguien que lleve. */
const LISTOS_PARA_SALIR = ['ready', 'packed'];

export default async function RepartoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const [envios, repartidores, estructura] = await Promise.all([
    cargar('/panel/reparto', yaSeIntento, () => panel.envios()),
    cargar('/panel/reparto', yaSeIntento, () => panel.repartidores()),
    cargar('/panel/reparto', yaSeIntento, () => panel.estructura()),
  ]);

  // Los saldos y la caja abierta se degradan solos: liquidar exige
  // `delivery.settle`, que el encargado de turno puede no tener, y sin ellos la
  // mesa de despacho tiene que seguir sirviendo para despachar.
  const [saldos, turnos] = await Promise.all([
    panel.saldosDeReparto().catch(() => []),
    panel.turnos().catch(() => []),
  ]);
  const cajaAbierta = turnos.find((t) => t.status === 'open');

  const sinAsignar = envios.filter((e) => e.status === 'pending');
  const enCurso = envios.filter((e) =>
    ['assigned', 'picked_up'].includes(e.status),
  );
  const problemas = envios.filter((e) =>
    ['failed', 'returned'].includes(e.status),
  );

  // El ranking se pide SOLO para lo que está sin asignar: es la única columna
  // donde alguien tiene que decidir, y pedirlo para todo convertiría la
  // pantalla en decenas de consultas que nadie mira.
  const sugerencias = new Map<string, SugerenciaDeReparto[]>(
    await Promise.all(
      sinAsignar.map(
        async (e) =>
          [e.id, await panel.sugerencias(e.id).catch(() => [])] as const,
      ),
    ),
  );

  // Pedidos que salieron de cocina y todavía no tienen envío. Hoy el envío no
  // nace solo al aceptar (PA-08 en docs/22): esta lista es lo que evita que un
  // pedido listo se quede esperando a que alguien se acuerde.
  const conEnvio = new Set(envios.map((e) => e.orderId));
  const listos = (
    await Promise.all(
      LISTOS_PARA_SALIR.map((s) =>
        panel.pedidos({ status: s, limit: 50 }).catch(() => []),
      ),
    )
  )
    .flat()
    .filter((p) => !conEnvio.has(p.id));

  function Envio({ e }: { e: EnvioDelPanel }) {
    return (
      <>
        <p>
          <Link href={`/panel/pedidos/${e.orderId}`}>Ver pedido</Link> ·{' '}
          <span className="etiqueta">{ROTULO_ENVIO[e.status] ?? e.status}</span>
        </p>
        <p className="tarjeta__pie">
          {e.courierName ?? e.externalCourier ?? 'sin repartidor'}
          {e.codAmount !== null && Number(e.codAmount) > 0
            ? ` · contra entrega S/ ${solesDeTexto(e.codAmount)}${
                e.codCollected ? ' (cobrado)' : ''
              }`
            : ''}
          {e.promisedAt ? ` · prometido ${momento(e.promisedAt)}` : ''}
        </p>
        {e.failReason ? (
          <p className="panel__error">
            {e.failReason} · {e.attempts}{' '}
            {e.attempts === 1 ? 'intento' : 'intentos'}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <>
      <h1>Reparto</h1>
      <p className="panel__subtitulo">
        Quién lleva qué, y cuánto efectivo trae de vuelta. El reparto propio se
        asigna a mano y el sistema recomienda por zona, carga y antigüedad de la
        promesa (RN-DLV-01) — con el motivo escrito, para que se pueda no
        seguirlo con criterio.
      </p>

      <div className="torre">
        <section className="torre__columna">
          <h2>
            Listos, sin envío{' '}
            {listos.length > 0 ? (
              <span className="etiqueta etiqueta--sin-precio">
                {listos.length}
              </span>
            ) : null}
          </h2>
          {listos.length === 0 ? (
            <Vacio titulo="Nada esperando salir" enOrden />
          ) : (
            listos.map((p) => (
              <article key={p.id} className="ficha ficha--revision">
                <p>
                  <strong>Pedido #{p.orderNumber}</strong> ·{' '}
                  <Canal canal={p.channel} />
                </p>
                <p className="tarjeta__pie">
                  S/ {soles(p.total)}. Si el cliente paga al recibir, deja el
                  importe; si ya pagó, bórralo.
                </p>
                <FormularioEnvio
                  orderId={p.id}
                  totalSugerido={soles(p.total)}
                />
              </article>
            ))
          )}
        </section>

        <section className="torre__columna">
          <h2>
            Por asignar{' '}
            {sinAsignar.length > 0 ? (
              <span className="etiqueta etiqueta--sin-precio">
                {sinAsignar.length}
              </span>
            ) : null}
          </h2>
          {sinAsignar.length === 0 ? (
            <Vacio titulo="Nada esperando repartidor" enOrden />
          ) : (
            sinAsignar.map((e) => (
              <article key={e.id} className="ficha ficha--revision">
                <Envio e={e} />
                <FormularioAsignacion
                  shipmentId={e.id}
                  sugerencias={sugerencias.get(e.id) ?? []}
                />
              </article>
            ))
          )}
        </section>

        <section className="torre__columna">
          <h2>En la calle</h2>
          {enCurso.length === 0 ? (
            <Vacio titulo="Nadie en ruta ahora mismo" enOrden />
          ) : (
            enCurso.map((e) => (
              <article key={e.id} className="ficha">
                <Envio e={e} />
                <AccionesDelEnvio
                  shipmentId={e.id}
                  estado={e.status}
                  contraEntrega={
                    e.codAmount !== null &&
                    Number(e.codAmount) > 0 &&
                    !e.codCollected
                      ? solesDeTexto(e.codAmount)
                      : null
                  }
                />
                {/* El enlace se ofrece cuando el pedido ya va en camino, que es
                    cuando el seguimiento dice algo. Emitirlo antes daría una
                    página que solo pone «asignado» durante media hora. */}
                <BotonSeguimiento shipmentId={e.id} />
              </article>
            ))
          )}

          {problemas.length > 0 ? (
            <>
              <h2>Fallidos</h2>
              {problemas.map((e) => (
                <article key={e.id} className="ficha ficha--revision">
                  <Envio e={e} />
                  {/* Un envío devuelto es terminal: no hay nada que ofrecer
                      salvo que se vea. Uno fallido, en cambio, es una venta
                      que todavía se puede salvar. */}
                  {e.status === 'failed' ? (
                    <AccionesDeFallo shipmentId={e.id} />
                  ) : null}
                </article>
              ))}
            </>
          ) : null}
        </section>
      </div>

      <h2>Repartidores</h2>
      {repartidores.length === 0 ? (
        <Vacio
          titulo="Todavía no hay ningún repartidor"
          accion={{ href: '#alta', rotulo: 'Dar de alta al primero' }}
        >
          <p>Sin repartidores no se puede asignar ningún envío.</p>
        </Vacio>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Estado</th>
                <th>Vehículo</th>
                <th>En ruta</th>
                <th>Zonas</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {repartidores.map((r) => (
                <tr key={r.id}>
                  <td>{r.fullName}</td>
                  <td>
                    {r.status === 'off' ? (
                      <strong className="baja">
                        {ROTULO_REPARTIDOR[r.status]}
                      </strong>
                    ) : (
                      (ROTULO_REPARTIDOR[r.status] ?? r.status)
                    )}
                  </td>
                  <td>{r.vehicle ?? '—'}</td>
                  <td>{r.activeShipments}</td>
                  <td>
                    {/* Sin zonas asignadas el ranking no lo descarta, pero
                        tampoco lo prefiere: decirlo evita la conclusión de que
                        el sistema «no le da pedidos» por capricho. */}
                    {r.zoneIds.length === 0 ? (
                      <span className="tarjeta__pie">todas</span>
                    ) : (
                      r.zoneIds.length
                    )}
                  </td>
                  <td>
                    <BotonEstadoRepartidor courierId={r.id} status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 id="alta">Dar de alta</h3>
      <FormularioRepartidor
        locales={estructura.locations.map((l) => ({
          id: l.id,
          name: l.name,
        }))}
      />

      <h2>Efectivo por liquidar</h2>
      <p className="tarjeta__pie">
        Lo que cobraron contra entrega y todavía no ha entrado en la gaveta
        (RN-DLV-02). Se liquida contra una caja <strong>abierta</strong>: contra
        una cerrada sería un ingreso sin arqueo que lo respalde.
      </p>
      {saldos.length === 0 ? (
        <Vacio titulo="Nadie debe efectivo" enOrden />
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Repartidor</th>
                <th>Pedidos</th>
                <th className="dinero">Efectivo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {saldos.map((s) => (
                <tr key={s.courierId}>
                  <td>{s.courierName}</td>
                  <td>{s.pendingShipments}</td>
                  <td className="dinero">S/ {solesDeTexto(s.pendingAmount)}</td>
                  <td>
                    {cajaAbierta ? (
                      <BotonLiquidar
                        courierId={s.courierId}
                        sessionId={cajaAbierta.id}
                        importe={solesDeTexto(s.pendingAmount)}
                      />
                    ) : (
                      <span className="tarjeta__pie">
                        Abre una caja para liquidar
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
