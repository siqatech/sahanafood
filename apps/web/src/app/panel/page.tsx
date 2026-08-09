import Link from 'next/link';
import { panel } from '../../lib/panel-api';
import { cargar } from '../../lib/panel-guard';
import { formatDecimal } from '../../lib/money';

/**
 * Portada del panel: **«¿cómo vamos hoy?»** (specs/ux/03).
 *
 * Cero configuración visible. El dueño abre el celular a las once de la noche y
 * lo que quiere saber cabe en una pantalla: cuánto se vendió, cuántos pedidos,
 * cómo va contra la semana pasada y qué hay en marcha ahora mismo.
 *
 * La comparación es contra **el mismo día de la semana pasada** y no contra
 * ayer: un martes no se parece a un lunes en un restaurante, y comparar con
 * ayer produce alarmas los lunes y euforia los viernes hasta que el número deja
 * de mirarse.
 */

function Variacion({ bps }: { bps: number | null }) {
  if (bps === null) {
    // No se inventa un «+100 %»: sin venta la semana pasada no hay con qué
    // comparar, y decir lo contrario es mentir con un número.
    return <span className="tarjeta__pie">sin datos de la semana pasada</span>;
  }
  const porcentaje = (bps / 100).toFixed(1);
  const sube = bps >= 0;
  return (
    <span className={sube ? 'sube' : 'baja'}>
      {sube ? '▲' : '▼'} {Math.abs(Number(porcentaje))} % vs. la semana pasada
    </span>
  );
}

export default async function PanelHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const hoy = await cargar('/panel', params['intento'] === '1', () =>
    panel.hoy(),
  );

  return (
    <>
      <h1>Hoy</h1>
      <p className="panel__subtitulo">
        Día de negocio {hoy.businessDate} · comparado con {hoy.comparedDate}
      </p>

      <div className="tarjetas">
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Ventas</p>
          <p className="tarjeta__cifra">{formatDecimal(hoy.netRevenue)}</p>
          <p className="tarjeta__pie">
            <Variacion bps={hoy.changeBps} />
          </p>
        </div>
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Pedidos</p>
          <p className="tarjeta__cifra">{hoy.orders}</p>
          <p className="tarjeta__pie">
            {hoy.comparedOrders} la semana pasada
            {hoy.cancelled > 0 ? ` · ${hoy.cancelled} cancelados` : ''}
          </p>
        </div>
        <div className="tarjeta">
          <p className="tarjeta__rotulo">Ticket promedio</p>
          <p className="tarjeta__cifra">{formatDecimal(hoy.averageTicket)}</p>
          <p className="tarjeta__pie">sin contar cancelados</p>
        </div>
        <div className="tarjeta">
          <p className="tarjeta__rotulo">En marcha ahora</p>
          <p className="tarjeta__cifra">{hoy.activeNow}</p>
          <p className="tarjeta__pie">
            pedidos que la cocina tiene entre manos
          </p>
        </div>
      </div>

      <h2>Por marca</h2>
      {hoy.byBrand.length === 0 ? (
        <p className="panel__vacio">
          Todavía no hay ventas hoy. Cuando entre el primer pedido aparecerá
          aquí, repartido por marca.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Marca</th>
                <th className="dinero">Pedidos</th>
                <th className="dinero">Ventas</th>
              </tr>
            </thead>
            <tbody>
              {hoy.byBrand.map((m) => (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="dinero">{m.orders}</td>
                  <td className="dinero">{formatDecimal(m.netRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Por canal</h2>
      {hoy.byChannel.length === 0 ? (
        <p className="panel__vacio">
          Nada todavía. Si aún no has publicado tu carta, empieza por{' '}
          <Link href="/panel/catalogo">la carta</Link>.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Canal</th>
                <th className="dinero">Pedidos</th>
                <th className="dinero">Ventas</th>
              </tr>
            </thead>
            <tbody>
              {hoy.byChannel.map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td className="dinero">{c.orders}</td>
                  <td className="dinero">{formatDecimal(c.netRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
