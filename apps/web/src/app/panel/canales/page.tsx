import Link from 'next/link';
import {
  panel,
  type ConexionDelPanel,
  type DominioDelPanel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioConexion,
  BotonEstadoDeConexion,
  FormularioDominio,
  BotonVerificar,
} from './formularios';

/**
 * Por dónde entran los pedidos (specs 13 y 11).
 *
 * Dos cosas que solo se podían hacer por API y que un negocio necesita el
 * primer día:
 *
 * · **Conectar un canal.** `POST /integrations/connections` existía y no lo
 *   llamaba nada, así que dar de alta un marketplace exigía un `curl` con el
 *   secreto de firma dentro. Y peor: la pantalla de operaciones enseñaba los
 *   conectores degradados sin ninguna forma de reactivarlos.
 *
 * · **El dominio de la tienda.** Se podía registrar y verificar por API, y
 *   **no había forma de listarlos**: el dato más importante de la tienda —en
 *   qué dirección vive— no lo devolvía ninguna ruta. Quien registrara un
 *   dominio y cerrara la pestaña perdía el token de verificación.
 */

const ROTULO_CIRCUITO: Record<string, string> = {
  closed: 'Sano',
  half_open: 'Probando',
  open: 'Cortado',
};

function momento(iso: string | null): string {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' });
}

export default async function CanalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';

  const estructura = await cargar('/panel/canales', yaSeIntento, () =>
    panel.estructura(),
  );

  // Cada bloque se degrada solo: `integrations.read` y `storefront.read` son
  // permisos distintos, y quien tenga uno tiene que poder usar su mitad.
  const [conexiones, dominios] = await Promise.all([
    panel.conexiones().catch((): ConexionDelPanel[] => []),
    panel.dominios().catch((): DominioDelPanel[] => []),
  ]);

  const marcas = estructura.brands.map((b) => ({ id: b.id, name: b.name }));
  const locales = estructura.locations.map((l) => ({
    id: l.id,
    name: l.name,
  }));
  const nombreDeMarca = new Map(marcas.map((m) => [m.id, m.name]));

  return (
    <>
      <h1>Canales</h1>
      <p className="panel__subtitulo">
        Por dónde entran los pedidos: los marketplaces conectados y la tienda
        propia. Lo que está pausado o cortado se ve aquí y se arregla aquí.
      </p>

      <h2>Marketplaces</h2>
      {conexiones.length === 0 ? (
        <p className="panel__vacio">
          Ningún canal conectado. Los pedidos entran solo por la tienda y el
          POS.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Canal</th>
                <th>Marca</th>
                <th>Estado</th>
                <th>Conector</th>
                <th>Última vez que funcionó</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {conexiones.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="etiqueta">{c.channel}</span>
                  </td>
                  <td>{nombreDeMarca.get(c.brandId) ?? '—'}</td>
                  <td>
                    {c.status === 'active' ? (
                      'Activo'
                    ) : (
                      <strong className="baja">
                        {c.status === 'paused' ? 'Pausado' : 'Desactivado'}
                      </strong>
                    )}
                  </td>
                  <td>
                    {/* El cortacircuitos, con texto además de estado: un canal
                        con el circuito abierto no recibe pedidos ni cambios de
                        carta, y por fuera parece «hoy hay poca venta». */}
                    {c.circuit === 'closed' ? (
                      ROTULO_CIRCUITO[c.circuit]
                    ) : (
                      <strong className="baja">
                        {ROTULO_CIRCUITO[c.circuit] ?? c.circuit}
                        {c.consecutiveFailures > 0
                          ? ` (${c.consecutiveFailures} fallos)`
                          : ''}
                      </strong>
                    )}
                  </td>
                  <td>{momento(c.lastSuccessAt)}</td>
                  <td>
                    <BotonEstadoDeConexion
                      connectionId={c.id}
                      status={c.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="tarjeta__pie">
        Lo que llegue y no se sepa traducir no se pierde: se aparta en{' '}
        <Link href="/panel/excepciones">Excepciones</Link> (RN-ORD-10).
      </p>

      <h3>Conectar un canal</h3>
      {marcas.length === 0 || locales.length === 0 ? (
        <p className="panel__vacio">
          Hace falta al menos una marca y un local antes de conectar nada.
        </p>
      ) : (
        <FormularioConexion marcas={marcas} locales={locales} />
      )}

      <h2>Tienda propia</h2>
      {dominios.length === 0 ? (
        <p className="panel__vacio">
          Sin dominio, la tienda no se sirve en ninguna dirección.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Dominio</th>
                <th>Marca</th>
                <th>Estado</th>
                <th>Qué falta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {dominios.map((d) => (
                <tr key={d.id}>
                  <td>{d.host}</td>
                  <td>{nombreDeMarca.get(d.brandId) ?? '—'}</td>
                  <td>
                    {d.status === 'active' ? (
                      'Sirviendo'
                    ) : (
                      <strong className="baja">Sin verificar</strong>
                    )}
                  </td>
                  <td>
                    {d.status === 'active' ? (
                      <span className="tarjeta__pie">
                        verificado {momento(d.verifiedAt)}
                      </span>
                    ) : d.verificationToken ? (
                      <>
                        {/* El token se enseña las veces que haga falta: NO es
                            un secreto, es un valor que hay que publicar en un
                            TXT. Ocultarlo haría imposible el paso que existe
                            para demostrar que el dominio es tuyo. */}
                        <span className="tarjeta__pie">
                          Añade este TXT en tu DNS:
                        </span>
                        <br />
                        <code>{d.verificationToken}</code>
                      </>
                    ) : (
                      <span className="tarjeta__pie">—</span>
                    )}
                  </td>
                  <td>
                    {d.status === 'active' ? null : (
                      <BotonVerificar domainId={d.id} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Registrar un dominio</h3>
      <p className="tarjeta__pie">
        Hasta que el DNS no se compruebe, el dominio <strong>no sirve</strong>{' '}
        la tienda: servir el catálogo de una marca en un host que todavía no es
        suyo es exactamente cómo se secuestra una tienda.
      </p>
      {marcas.length === 0 ? (
        <p className="panel__vacio">Hace falta una marca antes.</p>
      ) : (
        <FormularioDominio marcas={marcas} />
      )}
    </>
  );
}
