import Link from 'next/link';
import { panel, type LineaDeAuditoria } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';

/**
 * El histórico: quién hizo qué (spec 17, docs/14#auditoria).
 *
 * `audit_log` es **append-only por construcción** —el rol de aplicación no
 * tiene `UPDATE` ni `DELETE` sobre ella (migración 0002)— y eso solo vale de
 * algo si alguien puede leerlo. Se escribía desde F3 en cuarenta sitios y la
 * única ruta que lo devolvía entregaba las filas crudas, con el actor en UUID.
 *
 * Toda la trazabilidad que sostiene lo demás —cada cuenta con su nombre, cada
 * descuadre firmado por dos, cada precio con su autor— acaba aquí. Si esta
 * pantalla no existe, esa trazabilidad es una promesa que nadie ha comprobado.
 */

/**
 * Nombres en castellano para las acciones.
 *
 * Es un mapa PARCIAL y a propósito: lo que no está se enseña con su nombre
 * técnico en vez de esconderse. Una acción nueva que no aparezca aquí sigue
 * siendo legible; una acción que se ocultara por no estar en el mapa sería un
 * hueco en el histórico, que es exactamente lo que no puede pasar.
 */
const ROTULO: Record<string, string> = {
  'auth.login': 'Entró al sistema',
  'auth.refresh_reuse_detected': 'Sesión reutilizada (posible robo de token)',
  'tenant.created': 'Se creó el negocio',
  'tenant.suspended': 'Negocio suspendido',
  'identity.user_created': 'Alta de persona',
  'identity.role_changed': 'Cambio de rol',
  'identity.user_disabled': 'Baja de persona',
  'identity.user_enabled': 'Reactivación de persona',
  'device.paired': 'Tablet emparejada',
  'device.revoked': 'Tablet revocada',
  'device.pairing_code_issued': 'Código de emparejamiento emitido',
  'pin.changed': 'PIN cambiado',
  'pin.locked': 'PIN bloqueado por intentos',
  'catalog.price_set': 'Cambio de precio',
  'catalog.product_paused': 'Plato pausado',
  'catalog.product_resumed': 'Plato reactivado',
  'catalog.published': 'Carta publicada',
  'order.cancelled': 'Pedido cancelado',
  'order.modified': 'Pedido modificado',
  'order.discount_applied': 'Descuento aplicado',
  'order.discount_approved': 'Descuento aprobado por un supervisor',
  'order.mapping_resolved': 'Excepción resuelta',
  'cash.session_opened': 'Caja abierta',
  'cash.session_closed': 'Caja cerrada',
  'cash.session_closed_with_difference': 'Caja cerrada CON DESCUADRE',
  'inventory.adjusted': 'Ajuste de inventario',
  'invoice.credit_note': 'Nota de crédito',
  'billing.customer_corrected': 'Comprobante corregido',
  'payment.refund_requested': 'Devolución pedida',
  'payment.refunded': 'Dinero devuelto',
  'payment.link_created': 'Link de pago creado',
};

/**
 * Acciones que casi siempre se miran por un motivo concreto.
 *
 * Van arriba como atajos porque la pregunta que trae a alguien aquí rara vez
 * es «enséñame todo»: es «quién tocó el precio», «quién firmó ese descuadre».
 */
const ATAJOS = [
  { action: 'catalog.price_set', texto: 'Precios' },
  { action: 'order.discount_approved', texto: 'Descuentos aprobados' },
  { action: 'cash.session_closed_with_difference', texto: 'Descuadres' },
  { action: 'payment.refund_requested', texto: 'Devoluciones' },
  { action: 'identity.role_changed', texto: 'Cambios de rol' },
];

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

function Quien({ linea }: { linea: LineaDeAuditoria }) {
  if (linea.actorType === 'system') {
    // «Sistema» y «una persona» se distinguen siempre: un rechazo automático y
    // uno decidido por alguien no se explican igual.
    return <span className="tarjeta__pie">Sistema</span>;
  }
  if (linea.actorName) return <>{linea.actorName}</>;
  // Sin nombre no se enseña un UUID: no dice nada y ocupa la columna entera.
  return (
    <span className="tarjeta__pie">
      {linea.actorId ? 'Cuenta ya dada de baja' : 'Sin actor'}
    </span>
  );
}

/** Lo que hay dentro de `data`, en una línea legible. */
function detalle(linea: LineaDeAuditoria): string {
  const partes = Object.entries(linea.data)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return partes.join(' · ');
}

export default async function AuditoriaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const accion = typeof params['accion'] === 'string' ? params['accion'] : '';

  const [lineas, acciones] = await Promise.all([
    cargar('/panel/auditoria', yaSeIntento, () =>
      panel.auditoria({ ...(accion !== '' ? { action: accion } : {}) }),
    ),
    cargar('/panel/auditoria', yaSeIntento, () => panel.accionesAuditadas()),
  ]);

  const registradas = new Set(acciones.map((a) => a.action));

  return (
    <>
      <h1>Histórico</h1>
      <p className="panel__subtitulo">
        Quién hizo qué, y cuándo. Nada de lo que hay aquí se edita ni se borra:
        la base de datos no le concede permiso ni a la propia aplicación.
      </p>

      <p className="tarjeta__pie">
        {accion !== '' ? (
          <>
            <Link href="/panel/auditoria">Ver todo</Link> ·{' '}
          </>
        ) : null}
        {/* Solo se ofrecen los atajos que tienen algo detrás: un filtro que
            devuelve cero hace dudar de si falla el filtro o no pasó nunca. */}
        {ATAJOS.filter((a) => registradas.has(a.action)).map((a) => (
          <span key={a.action}>
            <Link href={`/panel/auditoria?accion=${a.action}`}>{a.texto}</Link>
            {' · '}
          </span>
        ))}
      </p>

      <form method="get">
        <div className="campo">
          <label htmlFor="aud-accion">Filtrar por acción</label>
          <select id="aud-accion" name="accion" defaultValue={accion}>
            <option value="">— todas —</option>
            {acciones.map((a) => (
              <option key={a.action} value={a.action}>
                {ROTULO[a.action] ?? a.action} ({a.count})
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Filtrar</button>
      </form>

      {lineas.length === 0 ? (
        <p className="panel__vacio">Nada registrado con ese filtro todavía.</p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Quién</th>
                <th>Qué</th>
                <th>Sobre qué</th>
              </tr>
            </thead>
            <tbody>
              {lineas.map((l) => (
                <tr key={l.id}>
                  <td>{momento(l.occurredAt)}</td>
                  <td>
                    <Quien linea={l} />
                  </td>
                  <td>
                    <strong>{ROTULO[l.action] ?? l.action}</strong>
                    {l.reason ? (
                      <>
                        <br />
                        <span className="tarjeta__pie">{l.reason}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {l.resourceType === 'order' && l.resourceId ? (
                      <Link href={`/panel/pedidos/${l.resourceId}`}>
                        Pedido
                      </Link>
                    ) : (
                      l.resourceType
                    )}
                    {detalle(l) ? (
                      <>
                        <br />
                        <span className="tarjeta__pie">{detalle(l)}</span>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tarjeta__pie">
        Se enseñan las {lineas.length} más recientes. El histórico completo se
        consulta por API con rango de fechas; una exportación masiva tendría que
        quedar auditada ella misma y todavía no existe.
      </p>
    </>
  );
}
