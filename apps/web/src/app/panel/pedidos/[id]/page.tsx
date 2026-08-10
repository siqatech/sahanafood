import Link from 'next/link';
import { panel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { soles } from '../../caja/dinero';

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

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

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

  return (
    <>
      <h1>Pedido #{pedido.orderNumber}</h1>
      <p className="panel__subtitulo">
        <span className="etiqueta">{pedido.channel}</span>{' '}
        {ROTULO[pedido.status] ?? pedido.status} · entró el{' '}
        {momento(pedido.createdAt)}
        {pedido.externalRef ? ` · referencia ${pedido.externalRef}` : ''}
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
                  <td className="dinero">S/ {l.lineTotal}</td>
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
