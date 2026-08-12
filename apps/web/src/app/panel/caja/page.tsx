import Link from 'next/link';
import { panel, type DocumentoDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { soles, solesDeTexto, hayDiferencia } from './dinero';

/**
 * Caja y comprobantes (specs/ux/03).
 *
 * El cajero cierra su turno en el POS, contando billete a billete. Esta es la
 * pantalla donde alguien que no estuvo ahí revisa **qué cuadró y qué no** — y
 * hasta ahora no existía: la única forma de ver un arqueo era la base de datos.
 *
 * Lo que manda el orden de la pantalla: **la diferencia**. Un turno que cuadra
 * no necesita a nadie; uno que no cuadra necesita una conversación hoy, no a
 * fin de mes. Por eso los descuadres se marcan y el resto se lee de corrido.
 */

const ESTADO_TURNO: Record<string, string> = {
  open: 'Abierto',
  closing: 'Cerrando',
  closed: 'Cerrado',
};

const ESTADO_DOC: Record<string, string> = {
  pending: 'En cola',
  queued: 'Enviado',
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  voided: 'Anulado',
};

const FILTROS_DOC = [
  { id: '', rotulo: 'Todos' },
  { id: 'rejected', rotulo: 'Rechazados' },
  { id: 'pending', rotulo: 'En cola' },
  { id: 'accepted', rotulo: 'Aceptados' },
] as const;

function fecha(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function CajaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const filtro = typeof params['doc'] === 'string' ? params['doc'] : '';

  const turnos = await cargar('/panel/caja', yaSeIntento, () => panel.turnos());

  // Los comprobantes son opcionales: sin permiso de facturación, los turnos se
  // siguen viendo. Al revés sería peor — quien revisa caja no siempre factura.
  const documentos = await panel
    .documentos(filtro === '' ? undefined : filtro)
    .catch((): DocumentoDelPanel[] => []);

  const descuadrados = turnos.filter((t) => hayDiferencia(t.difference));

  return (
    <>
      <h1>Caja y comprobantes</h1>
      <p className="panel__subtitulo">
        Cómo cerró cada turno y en qué va cada comprobante. Un turno que cuadra
        no necesita a nadie; uno que no, sí.
      </p>

      <h2>
        Turnos{' '}
        {descuadrados.length > 0 ? (
          <span className="etiqueta etiqueta--pausado">
            {descuadrados.length} con diferencia
          </span>
        ) : null}
      </h2>

      {turnos.length === 0 ? (
        <p className="panel__vacio">
          Todavía no se ha abierto ninguna caja. Se abren desde el POS, al
          empezar el turno.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Abierto</th>
                <th>Estado</th>
                <th className="dinero">Fondo</th>
                <th className="dinero">Esperado</th>
                <th className="dinero">Contado</th>
                <th className="dinero">Diferencia</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {turnos.map((t) => (
                <tr key={t.id}>
                  <td>{fecha(t.openedAt)}</td>
                  <td>{ESTADO_TURNO[t.status] ?? t.status}</td>
                  <td className="dinero">S/ {soles(t.openingFloat)}</td>
                  <td className="dinero">
                    {t.expectedCash ? `S/ ${soles(t.expectedCash)}` : '—'}
                  </td>
                  <td className="dinero">
                    {t.declaredCash ? `S/ ${soles(t.declaredCash)}` : '—'}
                  </td>
                  <td className="dinero">
                    {t.difference === null ? (
                      '—'
                    ) : hayDiferencia(t.difference) ? (
                      // Texto Y color: en una pantalla con luz directa el rojo
                      // solo no se distingue (docs/25 §6). El signo ya dice si
                      // falta o sobra, que es lo primero que se pregunta.
                      <strong className="baja">S/ {soles(t.difference)}</strong>
                    ) : (
                      'cuadra'
                    )}
                    {t.differenceReason ? (
                      <>
                        <br />
                        <span className="tarjeta__pie">
                          {t.differenceReason}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <Link href={`/panel/caja/${t.id}`}>Ver</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Comprobantes</h2>
      <form className="en-linea" method="get">
        <select
          name="doc"
          defaultValue={filtro}
          aria-label="Estado del documento"
        >
          {FILTROS_DOC.map((f) => (
            <option key={f.id} value={f.id}>
              {f.rotulo}
            </option>
          ))}
        </select>
        <button type="submit">Filtrar</button>
      </form>

      {documentos.length === 0 ? (
        <p className="panel__vacio">
          {filtro === ''
            ? 'Todavía no se ha emitido ningún comprobante.'
            : 'Ninguno en ese estado.'}
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Número</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th className="dinero">Total</th>
                <th>Emitido</th>
              </tr>
            </thead>
            <tbody>
              {documentos.map((d) => (
                <tr key={d.id}>
                  <td>{d.number ?? 'sin numerar'}</td>
                  <td>{d.docType}</td>
                  <td>
                    {ESTADO_DOC[d.status] ?? d.status}
                    {d.status === 'rejected' ? (
                      <>
                        <br />
                        {/* La venta NO se pierde por un rechazo (RN-BIL-02):
                            se corrige y se reenvía. Decirlo aquí evita el
                            reflejo de volver a cobrar. */}
                        <span className="tarjeta__pie">
                          {d.rejectionReason ?? 'sin motivo devuelto'} · la
                          venta no se pierde: se corrige y se reenvía
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="dinero">S/ {solesDeTexto(d.total)}</td>
                  <td>{fecha(d.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
