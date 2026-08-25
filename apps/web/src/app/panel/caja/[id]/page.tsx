import Link from 'next/link';
import { panel } from '../../../../lib/panel-api';
import { cargar } from '../../../../lib/panel-guard';
import { soles, hayDiferencia } from '../dinero';
import { momento } from '../../fechas';

/**
 * El arqueo de UN turno (specs/ux/03).
 *
 * Existe para resolver la única conversación difícil de la caja: **por qué no
 * cuadra**. Y para eso no basta el número final — hacen falta las dos vistas
 * que el servidor ya calcula y que hasta ahora no leía nadie:
 *
 *  · **Por tipo, en efectivo** — venta, devolución, entrada, salida, propina.
 *    Es lo que explica el esperado: fondo + entradas − salidas.
 *  · **Por medio de pago** — incluidos los que NO tocan la gaveta. Sin esta
 *    columna, un turno con mucha tarjeta parece un faltante enorme, y el
 *    cajero acaba defendiéndose de una acusación que era un error de lectura.
 */

const ROTULO_TIPO: Record<string, string> = {
  sale: 'Ventas',
  refund: 'Devoluciones',
  cash_in: 'Entradas',
  cash_out: 'Salidas',
  tip: 'Propinas',
};

const ROTULO_METODO: Record<string, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  wallet: 'Billetera (Yape/Plin)',
  transfer: 'Transferencia',
  other: 'Otro',
};

export default async function ArqueoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const busqueda = await searchParams;
  const yaSeIntento = busqueda['intento'] === '1';
  const ruta = `/panel/caja/${id}`;

  const [arqueo, turnos] = await Promise.all([
    cargar(ruta, yaSeIntento, () => panel.arqueo(id)),
    cargar(ruta, yaSeIntento, () => panel.turnos()),
  ]);
  const turno = turnos.find((t) => t.id === id);

  return (
    <>
      <h1>Arqueo del turno</h1>
      <p className="panel__subtitulo">
        {turno
          ? `Abierto el ${momento(turno.openedAt)}${
              turno.closedAt
                ? ` · cerrado el ${momento(turno.closedAt)}`
                : ' · sigue abierto'
            }`
          : 'Turno no encontrado en la lista reciente.'}
        {' · '}
        {arqueo.movements === 1
          ? '1 movimiento'
          : `${arqueo.movements} movimientos`}
      </p>

      {turno && hayDiferencia(turno.difference) ? (
        <p className="panel__error">
          Diferencia de S/ {soles(turno.difference!)}
          {turno.differenceReason ? ` — ${turno.differenceReason}` : ''}
        </p>
      ) : null}

      <h2>Lo que debería haber en la gaveta</h2>
      <div className="tarjetas">
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Fondo inicial</p>
          <p className="tarjeta__cifra">S/ {soles(arqueo.openingFloat)}</p>
        </div>
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Esperado</p>
          <p className="tarjeta__cifra">S/ {soles(arqueo.expectedCash)}</p>
          <p className="tarjeta__pie">
            Fondo + entradas − salidas, en efectivo
          </p>
        </div>
        {turno?.declaredCash ? (
          <div className="tarjeta">
            <p className="tarjeta__rotulo">Contado</p>
            <p className="tarjeta__cifra">S/ {soles(turno.declaredCash)}</p>
          </div>
        ) : null}
      </div>

      <h2>Por tipo (solo efectivo)</h2>
      <div className="tabla-envoltorio">
        <table>
          <tbody>
            {Object.entries(arqueo.byKind).map(([tipo, importe]) => (
              <tr key={tipo}>
                <td>{ROTULO_TIPO[tipo] ?? tipo}</td>
                <td className="dinero">S/ {soles(importe)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Por medio de pago</h2>
      <p className="tarjeta__pie">
        Incluye los que no tocan la gaveta. Una venta con tarjeta cuadra el
        turno pero no pone billetes en la caja.
      </p>
      {Object.keys(arqueo.byMethod).length === 0 ? (
        <p className="panel__vacio">Sin movimientos todavía.</p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <tbody>
              {Object.entries(arqueo.byMethod).map(([metodo, importe]) => (
                <tr key={metodo}>
                  <td>{ROTULO_METODO[metodo] ?? metodo}</td>
                  <td className="dinero">S/ {soles(importe)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 24 }}>
        <Link href="/panel/caja">← Volver a caja</Link>
      </p>
    </>
  );
}
