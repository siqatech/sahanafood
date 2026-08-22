import Link from 'next/link';
import {
  panel,
  type MovimientoDeKardex,
  type RecetaDelPanel,
} from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import { Chips } from '../chips';
import { Vacio } from '../vacio';
import { FormularioInsumo, FormularioReceta } from './formularios';

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

  const [existencias, movimientos, insumosDeclarados, recetas, estructura] =
    await Promise.all([
      cargar('/panel/inventario', yaSeIntento, () => panel.existencias()),
      cargar('/panel/inventario', yaSeIntento, () =>
        panel.kardex({
          limit: 100,
          ...(insumo !== '' ? { item: insumo } : {}),
        }),
      ),
      cargar('/panel/inventario', yaSeIntento, () => panel.insumos()),
      cargar('/panel/inventario', yaSeIntento, () => panel.recetas()),
      cargar('/panel/inventario', yaSeIntento, () => panel.estructura()),
    ]);

  // Los platos de la primera marca: es una versión mínima a propósito, y el
  // texto de la pantalla lo dice en vez de fingir que cubre el caso multimarca.
  const primeraMarca = estructura.brands[0];
  const productos = primeraMarca
    ? (await panel.productos(primeraMarca.id).catch(() => [])).map((p) => ({
        id: p.id,
        name: p.name,
      }))
    : [];

  const bajoMinimo = existencias.filter((e) => e.belowMinimum);
  const elegido = existencias.find((e) => e.itemId === insumo);

  // «Bajo mínimo» es la única pregunta que se le hace de verdad a esta tabla —
  // qué hay que comprar hoy— y hasta ahora había que buscarla a ojo entre las
  // filas en rojo. Como chip, además, el filtro queda en la URL y se comparte
  // por WhatsApp con quien va al mercado.
  const soloFaltantes = params['ver'] === 'bajo-minimo';
  const visibles = soloFaltantes ? bajoMinimo : existencias;

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

      <Chips
        nombre="ver"
        actual={soloFaltantes ? 'bajo-minimo' : ''}
        base="/panel/inventario"
        otros={insumo !== '' ? { insumo } : {}}
        etiqueta="Filtrar existencias"
        opciones={[
          { valor: '', rotulo: 'Todo', cuenta: existencias.length },
          {
            valor: 'bajo-minimo',
            rotulo: 'Bajo mínimo',
            cuenta: bajoMinimo.length,
          },
        ]}
      />

      {existencias.length === 0 ? (
        <Vacio titulo="Todavía no hay insumos con stock">
          <p>
            Se crean al declarar un insumo aquí abajo y entran con las compras,
            que llegan en F6.
          </p>
        </Vacio>
      ) : visibles.length === 0 ? (
        <Vacio titulo="Nada bajo mínimo" enOrden>
          <p>Todos los insumos están por encima de su mínimo declarado.</p>
        </Vacio>
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
              {visibles.map((e) => (
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

      <p className="pie-listado">
        <Link
          href="/panel/inventario/csv"
          className="boton-enlace"
          prefetch={false}
        >
          Exportar existencias
        </Link>{' '}
        <span className="tarjeta__pie">
          Para el conteo físico: se imprime, se cuenta a mano y se compara.
        </span>
      </p>

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

      <h2>Declarar un insumo</h2>
      <p className="tarjeta__pie">
        Guardar dos veces el mismo SKU no duplica: actualiza. Así el alta desde
        un archivo se puede repetir sin miedo.
      </p>
      <FormularioInsumo />

      <h2>Recetas</h2>
      {recetas.length === 0 ? (
        <Vacio
          titulo="Ningún plato descuenta stock todavía"
          accion={{ href: '/panel/reportes', rotulo: 'Ver rentabilidad' }}
        >
          <p>
            Sin receta, el consumo automático no se dispara y el food cost se
            queda en cero — así que el margen de ese plato sale más alto de lo
            que es.
          </p>
        </Vacio>
      ) : (
        <ul>
          {recetas.map((r: RecetaDelPanel) => (
            <li key={r.id}>
              <strong>{r.name}</strong>
              {r.productName ? ` → ${r.productName}` : ' (subreceta)'} ·{' '}
              {r.lines.map((l) => `${l.name} ${l.quantity}`).join(', ')}
            </li>
          ))}
        </ul>
      )}

      <h3>Añadir una receta</h3>
      <p className="tarjeta__pie">
        Versión mínima: un plato y su insumo principal, que es lo que hace que
        el descuento empiece a ocurrir. Las recetas con varios componentes y
        subrecetas se arman por API o por el archivo de alta.
        {primeraMarca ? ` Platos de ${primeraMarca.name}.` : ''}
      </p>
      <FormularioReceta
        insumos={insumosDeclarados.map((i) => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
        }))}
        productos={productos}
      />
    </>
  );
}
