import Link from 'next/link';
import {
  panel,
  type ConsentimientoDelPanel,
  type ContactoDelPanel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { FormularioConsentimiento } from './formularios';

/**
 * Mensajería: a quién se le puede escribir (RN-T10, RN-WA-04).
 *
 * `wa_consents` guarda **el texto exacto que aceptó la persona** —un booleano
 * no demuestra qué aceptó nadie— y `wa_contacts.opted_out` decide en cada envío
 * si se manda o no. Las dos cosas funcionaban y **ninguna ruta las devolvía**:
 * la baja se respetaba y nadie podía comprobarla.
 *
 * Eso importa el día que alguien dice «pedí que no me escribieran». La
 * respuesta era mirar la base de datos a mano; ahora se enseña cuándo lo pidió,
 * por qué vía y con qué palabras.
 *
 * No se llama «Clientes» a propósito: esto no es un CRM —eso es F6— sino la
 * lista de con quién se puede hablar por WhatsApp y con qué permiso.
 */

const ROTULO_ACCION: Record<string, string> = {
  granted: 'Dio consentimiento',
  revoked: 'Pidió la baja',
};

const ROTULO_ORIGEN: Record<string, string> = {
  whatsapp_inbound: 'escribió BAJA por WhatsApp',
  storefront: 'la tienda web',
  mostrador: 'el mostrador',
};

function momento(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

export default async function MensajeriaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const busqueda = typeof params['tel'] === 'string' ? params['tel'] : '';
  const elegido =
    typeof params['contacto'] === 'string' ? params['contacto'] : '';

  const contactos = await cargar('/panel/mensajeria', yaSeIntento, () =>
    panel.contactos(busqueda !== '' ? busqueda : undefined),
  );

  // El histórico se pide SOLO del contacto elegido: una lista completa de
  // textos de consentimiento es justo el volcado de datos personales que no
  // debe existir como pantalla.
  const historial: ConsentimientoDelPanel[] =
    elegido !== '' ? await panel.consentimientos(elegido).catch(() => []) : [];

  const kpi = await panel.kpiDeMensajeria().catch(() => null);
  const deBaja = contactos.filter((c: ContactoDelPanel) => c.optedOut);

  return (
    <>
      <h1>Mensajería</h1>
      <p className="panel__subtitulo">
        A quién se le puede escribir por WhatsApp, y con qué permiso. Una baja
        se respeta desde el momento en que se pide, y aquí se puede comprobar.
      </p>

      {kpi ? (
        <p className="tarjeta__pie">
          {/* Desde el cambio de precios de Meta cada mensaje de servicio se
              cobra: esta media es la que dice si el canal gana o pierde. */}
          Últimos 30 días: {kpi.messages} mensajes en {kpi.orders} pedidos —{' '}
          <strong>{kpi.average.toFixed(2)} por pedido</strong>. Cada mensaje de
          servicio se cobra, así que esta media decide si el canal sale a
          cuenta.
        </p>
      ) : null}

      <form method="get" className="en-linea">
        <label htmlFor="ms-buscar">Buscar</label>
        <input
          id="ms-buscar"
          name="tel"
          className="corto"
          defaultValue={busqueda}
          placeholder="987"
        />
        <button type="submit">Buscar</button>
      </form>

      <h2>
        Contactos{' '}
        {deBaja.length > 0 ? (
          <span className="etiqueta etiqueta--pausado">
            {deBaja.length} de baja
          </span>
        ) : null}
      </h2>

      {contactos.length === 0 ? (
        <p className="panel__vacio">
          Ningún contacto todavía. Se crean solos con el primer mensaje o el
          primer pedido con teléfono.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Teléfono</th>
                <th>Nombre</th>
                <th>Estado</th>
                <th>Último mensaje suyo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {contactos.map((c: ContactoDelPanel) => (
                <tr key={c.id}>
                  <td>{c.phone}</td>
                  <td>{c.displayName ?? '—'}</td>
                  <td>
                    {c.optedOut ? (
                      <>
                        <strong className="baja">De baja</strong>
                        <br />
                        <span className="tarjeta__pie">
                          desde {momento(c.optedOutAt)}
                        </span>
                      </>
                    ) : (
                      'Se le puede escribir'
                    )}
                  </td>
                  <td>
                    {/* La ventana de 24 h de Meta se abre con el último
                        mensaje ENTRANTE: fuera de ella solo entran plantillas
                        aprobadas, y por eso se enseña esta fecha y no la del
                        último envío nuestro. */}
                    {momento(c.lastInboundAt)}
                  </td>
                  <td>
                    <Link
                      href={`/panel/mensajeria?contacto=${c.id}${
                        busqueda !== '' ? `&tel=${busqueda}` : ''
                      }`}
                    >
                      Ver permiso
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {elegido !== '' ? (
        <>
          <h2>Qué aceptó, y cuándo</h2>
          {historial.length === 0 ? (
            <p className="panel__vacio">
              Sin registro de consentimiento. Si se le escribe, es por la
              ventana de 24 h que abre su propio mensaje.
            </p>
          ) : (
            <ul>
              {historial.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <strong>{ROTULO_ACCION[h.action] ?? h.action}</strong> ·{' '}
                  {momento(h.at)} · {ROTULO_ORIGEN[h.source] ?? h.source}
                  <br />
                  {/* El texto va entre comillas y literal: es la prueba. */}
                  <span className="tarjeta__pie">«{h.consentText}»</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      <h2>Registrar a mano</h2>
      <p className="tarjeta__pie">
        Para cuando alguien lo dice en el mostrador o por teléfono. Dar de baja
        se puede siempre: exigirle a alguien que escriba «BAJA» por WhatsApp
        para dejar de escribirle sería usar la herramienta como excusa.
      </p>
      <FormularioConsentimiento />
    </>
  );
}
