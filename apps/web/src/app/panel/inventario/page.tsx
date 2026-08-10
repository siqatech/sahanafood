import Link from 'next/link';
import { panel, type MovimientoDeKardex } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';

/**
 * Inventario: existencias y kardex (specs/ux/03, spec 08).
 *
 * Dos preguntas, en este orden: **qué falta** y **por qué**.
 *
 * La segunda es la que no se podía contestar. `inv_movements` es append-only
 * por diseño —`UPDATE` y `DELETE` revocados al rol de aplicación (RN-INV-02)—
 * y eso solo sirve de algo si alguien puede leerlo; se escribía desde F4 en
 * tres sitios y ninguna ruta lo devolvía. El libro existía, era inalterable, y
 * era ilegible: al preguntar por qué faltan 3 kg de carne, la respuesta seguía
 * siendo «alguien lo ajustó».
 */

const ROTULO_TIPO: Record<string, string> = {
  consumption: 'Consumo',
  reversal: 'Reversa',
  waste: 'Merma',
  adjustment: 'Ajuste',
  purchase: 'Compra',
  transfer: 'Transferencia',
};

/**
 * Cantidad tal cual la devuelve la API, recortada a lo que se lee.
 *
 * Llega como decimal a escala 4 y **con signo**: negativo descuenta, positivo
 * repone. El signo NO se deduce del tipo a propósito —una reversa suma y una
 * merma resta bajo tipos distintos, y un ajuste puede ir en cualquier
 * dirección—, así que se enseña tal cual viene.
 */
function cantidad(valor: string, unidad: string): string {
  const [entero = '0', decimales = ''] = valor.split('.');
  const recortado = decimales.replace(/0+$/, '').slice(0, 3);
  return `${entero}${recortado ? `.${recortado}` : ''} ${unidad}`;
}

function momento(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Kardex({ movimientos }: { movimientos: MovimientoDeKardex[] }) {
  if (movimientos.length === 0) {
    return <p className="panel__vacio">Sin movimientos todavía.</p>;
  }
  return (
    <div className="tabla-envoltorio">
      <table>
        <thead>
          <tr>
            <th>Cuándo</th>
            <th>Qué</th>
            <th>Insumo</th>
            <th className="dinero">Cantidad</th>
            <th className="dinero">Costo unit.</th>
            <th>Por qué</th>
          </tr>
        </thead>
        <tbody>
          {movimientos.map((m) => (
            <tr key={m.id}>
              <td>{momento(m.occurredAt)}</td>
              <td>{ROTULO_TIPO[m.kind] ?? m.kind}</td>
              <td>
                {m.itemName}
                <br />
                <span className="tarjeta__pie">{m.warehouseName}</span>
              </td>
              <td className="dinero">{cantidad(m.quantity, m.unit)}</td>
              {/* El costo del MOMENTO, no el de hoy (RN-INV-04). Es el dato del
                  que depende toda la conciliación de F6: recalcular el food
                  cost histórico con los precios de hoy convierte un análisis de
                  margen en ficción. */}
              <td className="dinero">S/ {m.unitCost}</td>
              <td>
                {m.orderNumber !== null ? (
                  <Link href={`/panel/pedidos/${m.orderId}`}>
                    Pedido #{m.orderNumber}
                  </Link>
                ) : null}
                {m.reason ? (
                  <>
                    {m.orderNumber !== null ? <br /> : null}
                    <span className="tarjeta__pie">{m.reason}</span>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function InventarioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const insumo = typeof params['insumo'] === 'string' ? params['insumo'] : '';

  const [existencias, movimientos] = await Promise.all([
    cargar('/panel/inventario', yaSeIntento, () => panel.existencias()),
    cargar('/panel/inventario', yaSeIntento, () =>
      panel.kardex({ limit: 100, ...(insumo !== '' ? { item: insumo } : {}) }),
    ),
  ]);

  const bajoMinimo = existencias.filter((e) => e.belowMinimum);
  const elegido = existencias.find((e) => e.itemId === insumo);

  return (
    <>
      <h1>Inventario</h1>
      <p className="panel__subtitulo">
        Qué falta y por qué. El stock puede quedar negativo: nunca se bloquea
        una venta por inventario (RN-INV-02), pero se avisa.
      </p>

      <h2>
        Existencias{' '}
        {bajoMinimo.length > 0 ? (
          <span className="etiqueta etiqueta--pausado">
            {bajoMinimo.length} bajo mínimo
          </span>
        ) : null}
      </h2>

      {existencias.length === 0 ? (
        <p className="panel__vacio">
          Todavía no hay insumos con stock. Se crean con recetas y entran con
          las compras, que llegan en F6.
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Insumo</th>
                <th>Almacén</th>
                <th className="dinero">Stock</th>
                <th className="dinero">Mínimo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {existencias.map((e) => (
                <tr key={`${e.warehouseId}-${e.itemId}`}>
                  <td>{e.itemName}</td>
                  <td>{e.warehouseName}</td>
                  <td className="dinero">
                    {e.belowMinimum ? (
                      // Texto Y color: el rojo solo no se distingue en una
                      // pantalla con luz directa (docs/25 §6).
                      <strong className="baja">
                        {cantidad(e.quantity, e.unit)}
                      </strong>
                    ) : (
                      cantidad(e.quantity, e.unit)
                    )}
                  </td>
                  <td className="dinero">
                    {e.minStock ? cantidad(e.minStock, e.unit) : '—'}
                  </td>
                  <td>
                    <Link href={`/panel/inventario?insumo=${e.itemId}`}>
                      Ver movimientos
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>
        {elegido ? `Movimientos de ${elegido.itemName}` : 'Últimos movimientos'}
      </h2>
      <p className="tarjeta__pie">
        El libro es <strong>append-only</strong>: nada de lo que hay aquí se
        edita ni se borra. Un error se corrige con otro movimiento, y los dos
        quedan.
        {insumo !== '' ? (
          <>
            {' '}
            <Link href="/panel/inventario">Ver todos</Link>
          </>
        ) : null}
      </p>
      <Kardex movimientos={movimientos} />
    </>
  );
}
