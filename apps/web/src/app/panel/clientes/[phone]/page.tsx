import Link from 'next/link';
import { panel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { solesDeTexto } from '../../caja/dinero';
import { Canal } from '../../canal';
import { BotonAnonimizar } from '../formulario';

/** La ficha de un cliente: quién es, cuánto deja y qué pidió (spec 14). */
const ROTULO_ESTADO: Record<string, string> = {
  received: 'Recibido',
  accepted: 'Aceptado',
  preparing: 'En preparación',
  ready: 'Listo',
  dispatched: 'En camino',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  rejected: 'Rechazado',
};

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

export default async function ClientePage({
  params,
  searchParams,
}: {
  params: Promise<{ phone: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { phone } = await params;
  const sp = await searchParams;
  const telefono = decodeURIComponent(phone);

  const cliente = await cargar(
    `/panel/clientes/${phone}`,
    sp['intento'] === '1',
    () => panel.cliente(telefono),
  );

  return (
    <>
      <h1>{cliente.name ?? 'Cliente sin nombre'}</h1>
      <p className="panel__subtitulo">
        {cliente.anonymized ? 'Datos personales borrados' : cliente.phone} ·
        cliente desde{' '}
        {new Date(cliente.firstOrderAt).toLocaleDateString('es-PE', {
          timeZone: 'America/Lima',
        })}
      </p>

      <div className="tarjetas">
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Ha gastado</p>
          <p className="tarjeta__cifra">
            S/ {solesDeTexto(cliente.totalSpent)}
          </p>
          <p className="tarjeta__pie">Solo pedidos entregados</p>
        </div>
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Pedidos</p>
          <p className="tarjeta__cifra">{cliente.orders}</p>
          <p className="tarjeta__pie">
            Ticket promedio S/ {solesDeTexto(cliente.averageTicket)}
          </p>
        </div>
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Por dónde pide</p>
          <p className="tarjeta__pie" style={{ marginTop: 8 }}>
            {cliente.channels.map((c) => (
              <Canal key={c} canal={c} />
            ))}
          </p>
        </div>
      </div>

      {cliente.optedOut ? (
        <p className="panel__error">
          Pidió la baja de mensajes: <strong>no se le escribe</strong> ni para
          avisarle de su pedido (RN-CRM-01).
        </p>
      ) : null}

      <h2>Historial</h2>
      <div className="tabla-envoltorio">
        <table>
          <thead>
            <tr>
              <th>Nº</th>
              <th>Canal</th>
              <th>Estado</th>
              <th className="dinero">Total</th>
              <th>Cuándo</th>
            </tr>
          </thead>
          <tbody>
            {cliente.historial.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/panel/pedidos/${p.id}`}>#{p.orderNumber}</Link>
                </td>
                <td>
                  <Canal canal={p.channel} />
                </td>
                <td>{ROTULO_ESTADO[p.status] ?? p.status}</td>
                <td className="dinero">S/ {solesDeTexto(p.total)}</td>
                <td>{momento(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {cliente.anonymized ? null : (
        <>
          <h2>Datos personales</h2>
          <p className="tarjeta__pie">
            La Ley 29733 le da derecho a pedir que se borren. Sus pedidos se
            quedan: son un registro contable con cinco años de retención.
          </p>
          <BotonAnonimizar
            phone={cliente.phone}
            nombre={cliente.name ?? cliente.phone}
          />
        </>
      )}

      <p className="pie-listado">
        <Link href="/panel/clientes">Volver a clientes</Link>
      </p>
    </>
  );
}
