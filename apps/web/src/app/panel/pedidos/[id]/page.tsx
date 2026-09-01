import Link from 'next/link';
import { panel, type CobroDelPanel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { soles, solesDeTexto } from '../../caja/dinero';
import { FormularioDevolucion, BotonEnlaceDePago } from './formularios';
import { Canal } from '../../canal';
import { SenalCliente } from '../../senal-cliente';
import { momento } from '../../fechas';

/**
 * Trazabilidad de UN pedido (specs/ux/03: «la misma vista del runbook 1,
 * versión operador»).
 *
 * Responde las tres preguntas que llegan por teléfono, en este orden: **qué
 * pidió**, **en qué va** y **qué le pasó por el camino**. Lo primero es lo que
 * más se pregunta y lo que hasta ahora no se podía contestar desde ninguna
 * pantalla: `ord_order_lines` guarda el snapshot de lo vendido desde F4 —«no se
 * referencia el catálogo, se copia» (RN-ORD-02)— y ninguna ruta lo devolvía.
 *
 * El histórico se pinta del más reciente al más antiguo. Quien mira esta
 * pantalla quiere saber qué pasó ÚLTIMO, no cómo empezó.
 */

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

export default async function PedidoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const busqueda = await searchParams;
  const yaSeIntento = busqueda['intento'] === '1';
  const ruta = `/panel/pedidos/${id}`;

  const [pedido, hitos] = await Promise.all([
    cargar(ruta, yaSeIntento, () => panel.pedido(id)),
    cargar(ruta, yaSeIntento, () => panel.hitos(id)),
  ]);

  // Los cobros se degradan solos si falta `payments.read`: quien no ve el
  // dinero tiene que poder seguir viendo el pedido, que es para lo que la
  // mayoría entra aquí.
  const cobros = await panel.cobrosDe(id).catch((): CobroDelPanel[] => []);
  const equipo = await panel.usuarios().catch(() => []);
  // Igual: sin `payments.read` no hay pasarelas que ofrecer, y el pedido tiene
  // que seguir leyéndose.
  const pasarelas = await panel.pasarelas().catch(() => []);

  /**
   * Ya cobrado: hay un cobro capturado, o uno vivo esperando a que el cliente
   * pague. Emitir un segundo enlace sobre cualquiera de los dos es cómo un
   * cliente acaba pagando dos veces y el negocio devolviendo dinero.
   */
  const yaCobrado = cobros.some((c) =>
    ['captured', 'authorized', 'pending'].includes(c.status),
  );
  // Se ofrecen como aprobadores los que PUEDEN devolver dinero. El permiso lo
  // comprueba la API de todas formas; ofrecer a todo el equipo solo conseguiría
  // que la mitad de los intentos fallara con «no tiene el permiso».
  const aprobadores = equipo
    .filter(
      (u) =>
        u.status === 'active' &&
        (u.isOwner || u.roles.some((r) => r.code === 'admin')),
    )
    .map((u) => ({ id: u.id, name: u.fullName }));

  return (
    <>
      <h1>Pedido #{pedido.orderNumber}</h1>
      <p className="panel__subtitulo">
        <Canal canal={pedido.channel} />{' '}
        {ROTULO[pedido.status] ?? pedido.status} · entró el{' '}
        {momento(pedido.createdAt)}
        {pedido.externalRef ? ` · referencia ${pedido.externalRef}` : ''}
      </p>

      {/* Arriba, junto al número, y no enterrado en «Cliente»: el operador que
          coge el teléfono decide en el primer vistazo si está hablando con
          alguien que viene por primera vez o con uno de los de siempre. El dato
          estaba en el CRM desde F5 y para verlo había que salir del pedido y
          buscar el teléfono; nadie lo hace con la cocina llena. */}
      <p>
        <SenalCliente pedidos={pedido.customerOrders} />
      </p>

      {pedido.cancelReason ? (
        <p className="panel__error">Motivo: {pedido.cancelReason}</p>
      ) : null}

      <h2>Qué pidió</h2>
      {pedido.lines.length === 0 ? (
        <p className="panel__vacio">
          Sin líneas. Es lo normal en un pedido apartado en revisión: no se supo
          traducir lo que mandó el canal.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Cant.</th>
                <th className="dinero">Importe</th>
              </tr>
            </thead>
            <tbody>
              {pedido.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.productName}
                    {/* Una línea de ajuste es una modificación posterior, no
                        algo que el cliente pidiera: decirlo evita leer el
                        ticket como si hubiera pedido dos veces. */}
                    {l.isAdjustment ? (
                      <>
                        {' '}
                        <span className="etiqueta">ajuste</span>
                      </>
                    ) : null}
                    {l.notes ? (
                      <>
                        <br />
                        <span className="tarjeta__pie">{l.notes}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{l.quantity}</td>
                  {/* Por el formateador, no crudo. `lineTotal` llega como el
                      `NUMERIC(14,4)` de la base —«76.0000»— y enseñarlo tal cual
                      ponía cuatro decimales en la línea y dos en el total de
                      abajo, en la misma pantalla. Quien la mira para contestar
                      un reclamo no tiene por qué saber que son la misma cifra. */}
                  <td className="dinero">S/ {solesDeTexto(l.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="dinero">
        <strong>Total: S/ {soles(pedido.total)}</strong>
      </p>

      <h2>Cliente</h2>
      <p className="tarjeta__pie">
        {pedido.customerName ?? 'sin nombre'}
        {pedido.customerPhone ? ` · ${pedido.customerPhone}` : ''}
        {pedido.deliveryAddress ? ` · ${pedido.deliveryAddress}` : ''}
      </p>
      {pedido.notes ? (
        <p className="tarjeta__pie">Nota: {pedido.notes}</p>
      ) : null}

      <h2>Cobros</h2>

      {/* El enlace se ofrece mientras el pedido NO esté cobrado. Es la única
          forma de cobrarle a quien pidió por WhatsApp o por teléfono: el
          módulo lo sabía hacer desde T5.05 y no había ninguna pantalla, así
          que la alternativa era un `curl` o cobrar a la entrega. */}
      {yaCobrado ? (
        <p className="tarjeta__pie">
          Este pedido ya está cobrado. No se emite otro enlace: dos enlaces
          vivos sobre el mismo pedido es cómo un cliente paga dos veces.
        </p>
      ) : (
        <BotonEnlaceDePago
          orderId={id}
          pasarelas={pasarelas.map((p) => ({ id: p.id, provider: p.provider }))}
        />
      )}

      {cobros.length > 0 ? (
        <>
          {cobros.map((c) => (
            <article key={c.id} className="ficha">
              <p>
                <strong>S/ {solesDeTexto(c.amount)}</strong> ·{' '}
                <span className="etiqueta">{c.status}</span>
              </p>

              {c.refund ? (
                <>
                  {/* El motivo se escribió desde T5.04 «para el panel y la
                      auditoría» y hasta ahora solo llegaba a la auditoría. */}
                  <p className="tarjeta__pie">
                    Devolución: {c.refund.reason ?? 'sin motivo'}
                    {c.refund.refundedAt
                      ? ` · devuelta el ${momento(c.refund.refundedAt)}`
                      : ' · en cola'}
                  </p>
                  {c.refund.exhausted ? (
                    // La alarma que la migración describía y nadie podía oír:
                    // el barrido se rindió, el dinero sigue retenido y el
                    // cobro se veía idéntico a uno normal.
                    <p className="panel__error">
                      La pasarela rechazó la devolución {c.refund.attempts}{' '}
                      veces y el sistema dejó de intentarlo:{' '}
                      {c.refund.lastError ?? 'sin detalle'}. Hay que resolverlo
                      con la pasarela a mano — el dinero sigue retenido.
                    </p>
                  ) : null}
                </>
              ) : c.status === 'captured' ? (
                <FormularioDevolucion
                  intentId={c.id}
                  orderId={id}
                  importe={solesDeTexto(c.amount)}
                  aprobadores={aprobadores}
                />
              ) : (
                <p className="tarjeta__pie">
                  Solo se devuelve un cobro capturado.
                </p>
              )}
            </article>
          ))}
        </>
      ) : null}

      <h2>Qué le pasó</h2>
      {hitos.length === 0 ? (
        <p className="panel__vacio">Sin historial.</p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Qué</th>
                <th>Quién</th>
              </tr>
            </thead>
            <tbody>
              {[...hitos].reverse().map((h, i) => (
                <tr key={`${h.occurredAt}-${i}`}>
                  <td>{momento(h.occurredAt)}</td>
                  <td>
                    {h.fromStatus
                      ? `${ROTULO[h.fromStatus] ?? h.fromStatus} → `
                      : ''}
                    <strong>{ROTULO[h.toStatus] ?? h.toStatus}</strong>
                    {h.reason ? (
                      <>
                        <br />
                        <span className="tarjeta__pie">{h.reason}</span>
                      </>
                    ) : null}
                  </td>
                  {/* «sistema» y «persona» se distinguen a propósito: un
                      rechazo automático y uno decidido por alguien no se
                      explican igual al cliente ni al canal. */}
                  <td>
                    {h.actorType === 'system' ? 'Sistema' : 'Una persona'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 24 }}>
        <Link href="/panel/pedidos">← Volver a pedidos</Link>
      </p>
    </>
  );
}
