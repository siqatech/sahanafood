import Link from 'next/link';
import {
  panel,
  type RentabilidadDelPanel,
  type ConciliacionDelPanel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { solesDeTexto } from '../caja/dinero';

/**
 * Rentabilidad y conciliación (spec 16).
 *
 * Las dos preguntas que justifican el producto y que no tenían pantalla:
 *
 * · **¿Qué marca gana dinero por qué canal?** Es la pregunta que justifica una
 *   dark kitchen —cuatro marcas en la misma cocina— y el endpoint existía desde
 *   T4.29 sin que nada lo pintara. Sin esta tabla, la decisión de seguir o no en
 *   un marketplace se toma mirando la facturación, que es justo el número que
 *   más engaña: el canal que más factura suele ser el que más comisión cobra.
 *
 * · **¿Cuadra lo que vendimos con lo que declaramos?** La spec 16 lo dice sin
 *   matices: una divergencia es un **bug crítico**. Un panel que dice S/ 12 000
 *   y una declaración que dice S/ 11 400 no es un redondeo: es que alguien va a
 *   decidir con un número inventado. Se comprobaba por API y no lo miraba nadie.
 */

function porcentaje(bps: number): string {
  // Enteros: `bps / 100` con dos decimales fijos, sin coma flotante en la
  // división que decide si un canal se cierra o no.
  const entero = Math.trunc(bps / 100);
  const resto = Math.abs(bps % 100);
  return `${entero},${String(resto).padStart(2, '0')} %`;
}

function hace(dias: number): string {
  return new Date(Date.now() - dias * 24 * 3_600_000)
    .toISOString()
    .slice(0, 10);
}

export default async function ReportesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const desde =
    typeof params['desde'] === 'string' ? params['desde'] : hace(30);
  const hasta = typeof params['hasta'] === 'string' ? params['hasta'] : hace(0);
  const dia = typeof params['dia'] === 'string' ? params['dia'] : hace(0);

  const [rentabilidad, conciliacion] = await Promise.all([
    cargar('/panel/reportes', yaSeIntento, () =>
      panel.rentabilidad({ from: desde, to: hasta }),
    ),
    // La conciliación se degrada sola: sin facturación configurada todavía no
    // hay nada que conciliar, y eso no puede tumbar el informe de márgenes.
    panel.conciliacion(dia).catch((): ConciliacionDelPanel | null => null),
  ]);

  // Ordenado por margen, no por facturación: la tabla contesta «cuál gana
  // dinero», y ordenarla por ventas pondría arriba justo al que puede estar
  // perdiéndolo.
  const filas = [...rentabilidad].sort((a, b) => a.marginBps - b.marginBps);
  const peor = filas[0];

  return (
    <>
      <h1>Rentabilidad</h1>
      <p className="panel__subtitulo">
        Qué marca gana dinero por qué canal. El que más factura no es el que más
        deja: la comisión y el food cost se descuentan aquí.
      </p>

      <form method="get" className="en-linea">
        <label htmlFor="rep-desde">Desde</label>
        <input id="rep-desde" name="desde" type="date" defaultValue={desde} />
        <label htmlFor="rep-hasta">Hasta</label>
        <input id="rep-hasta" name="hasta" type="date" defaultValue={hasta} />
        <button type="submit">Ver</button>
      </form>

      {filas.length === 0 ? (
        <p className="panel__vacio">
          Sin ventas en ese rango. El margen se calcula sobre pedidos
          entregados, no sobre los que están en curso.
        </p>
      ) : (
        <>
          {peor && peor.marginBps < 0 ? (
            // Un margen negativo no es un dato más de la tabla: es dinero que
            // se pierde en cada pedido, y cuanto más se venda peor.
            <p className="panel__error">
              {peor.brandName} por {peor.channel} está{' '}
              <strong>perdiendo dinero</strong> en cada pedido (
              {porcentaje(peor.marginBps)}). Vender más por ahí no lo arregla.
            </p>
          ) : null}

          <div className="tabla-envoltorio">
            <table>
              <thead>
                <tr>
                  <th>Marca</th>
                  <th>Canal</th>
                  <th>Pedidos</th>
                  <th className="dinero">Venta neta</th>
                  <th className="dinero">Comisión</th>
                  <th className="dinero">Food cost</th>
                  <th className="dinero">Margen</th>
                  <th className="dinero">%</th>
                  <th className="dinero">Ticket</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((r: RentabilidadDelPanel) => (
                  <tr key={`${r.brandId}-${r.channel}`}>
                    <td>{r.brandName}</td>
                    <td>
                      <span className="etiqueta">{r.channel}</span>
                    </td>
                    <td>
                      {r.orders}
                      {r.cancelled > 0 ? (
                        <>
                          <br />
                          <span className="tarjeta__pie">
                            {r.cancelled} cancelados
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="dinero">
                      S/ {solesDeTexto(r.netRevenue)}
                      {Number(r.discounts) > 0 ? (
                        <>
                          <br />
                          <span className="tarjeta__pie">
                            −{solesDeTexto(r.discounts)} dto.
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="dinero">S/ {solesDeTexto(r.commission)}</td>
                    <td className="dinero">S/ {solesDeTexto(r.foodCost)}</td>
                    <td className="dinero">
                      {/* Texto Y color: el rojo solo no se distingue en una
                          pantalla con luz directa (docs/25 §6). */}
                      {r.marginBps < 0 ? (
                        <strong className="baja">
                          −S/{' '}
                          {solesDeTexto(r.contributionMargin.replace('-', ''))}
                        </strong>
                      ) : (
                        `S/ ${solesDeTexto(r.contributionMargin)}`
                      )}
                    </td>
                    <td className="dinero">{porcentaje(r.marginBps)}</td>
                    <td className="dinero">
                      S/ {solesDeTexto(r.averageTicket)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="tarjeta__pie">
            Ordenado por margen, de peor a mejor: la pregunta es cuál gana
            dinero, y ordenar por facturación pondría arriba justo al que puede
            estar perdiéndolo. La comisión sale del tarifario del canal; el food
            cost, del consumo real de{' '}
            <Link href="/panel/inventario">inventario</Link>, así que un plato
            sin receta no aporta coste y hace parecer que deja más.
          </p>
        </>
      )}

      <h2>Cuadre del día</h2>
      <p className="tarjeta__pie">
        Lo que contamos como venta contra lo que declaramos a SUNAT. La spec lo
        dice sin matices: una diferencia <strong>no es un redondeo</strong>, es
        que alguien va a decidir con un número que no es.
      </p>

      <form method="get" className="en-linea">
        <input type="hidden" name="desde" value={desde} />
        <input type="hidden" name="hasta" value={hasta} />
        <label htmlFor="rep-dia">Día</label>
        <input id="rep-dia" name="dia" type="date" defaultValue={dia} />
        <button type="submit">Cuadrar</button>
      </form>

      {conciliacion === null ? (
        <p className="panel__vacio">
          No se pudo calcular el cuadre. Suele ser que todavía no hay
          facturación configurada.
        </p>
      ) : conciliacion.matches ? (
        <p className="tarjeta__pie">
          Cuadra: S/ {solesDeTexto(conciliacion.analyticsTotal)} vendidos y
          declarados el {conciliacion.businessDate}.
        </p>
      ) : (
        <>
          <p className="panel__error">
            NO cuadra por S/ {solesDeTexto(conciliacion.difference)}. Vendido S/{' '}
            {solesDeTexto(conciliacion.analyticsTotal)}, declarado S/{' '}
            {solesDeTexto(conciliacion.billingTotal)}.
          </p>
          <p className="tarjeta__pie">
            {conciliacion.ordersWithoutDocument} ventas sin comprobante aceptado
            y {conciliacion.documentsWithoutSale} comprobantes sin venta. Las
            primeras se resuelven en{' '}
            <Link href="/panel/comprobantes">Comprobantes</Link>.
          </p>
        </>
      )}
    </>
  );
}
