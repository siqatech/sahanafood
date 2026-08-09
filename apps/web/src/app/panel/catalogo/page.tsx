import Link from 'next/link';
import { panel, type ProductoDelPanel } from '../../../lib/panel-api';
import { cargar } from '../../../lib/panel-guard';
import {
  FormularioNuevoProducto,
  FormularioPausa,
  FormularioPrecio,
} from './formularios';

/**
 * La carta (specs/ux/03, «Catálogo»).
 *
 * Es la pantalla que un dueño usa cada semana: la carta cambia, la estructura
 * del negocio no. Enseña **los tres canales propios en columnas** —base, tienda
 * web y mostrador— porque la diferencia de precio por canal es la palanca de
 * rentabilidad del negocio y esconderla detrás de un menú la vuelve invisible.
 *
 * Lo que se lista es la carta TAL COMO ESTÁ, no la resuelta: aparecen el
 * producto sin precio —el que hay que arreglar— y el pausado —el que hay que
 * reactivar—, que son justo los que la tienda oculta al cliente. Una pantalla
 * de gestión que ocultara el trabajo pendiente no serviría para gestionar.
 */

/** Canales propios, los que un dueño toca a mano. Los marketplaces, por API. */
const CANALES = [
  { id: 'base', rotulo: 'Base' },
  { id: 'web', rotulo: 'Tienda web' },
  { id: 'pos', rotulo: 'Mostrador' },
] as const;

function precioDe(p: ProductoDelPanel, canal: string): string {
  const buscado = canal === 'base' ? null : canal;
  const fila = p.prices.find(
    (x) => x.channel === buscado && x.locationId === null,
  );
  // Cadena vacía y no «0.00»: un precio que no existe no es un precio de cero,
  // y enseñarlo como cero invita a dejarlo así.
  if (!fila) return '';
  const [entero = '0', decimales = ''] = fila.price.split('.');
  return `${entero}.${(decimales + '00').slice(0, 2)}`;
}

export default async function CatalogoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const yaSeIntento = params['intento'] === '1';
  const marcaPedida =
    typeof params['marca'] === 'string' ? params['marca'] : undefined;

  const estructura = await cargar('/panel/catalogo', yaSeIntento, () =>
    panel.estructura(),
  );
  const marcas = estructura.brands;

  if (marcas.length === 0) {
    return (
      <>
        <h1>Carta</h1>
        <p className="panel__vacio">
          Todavía no tienes ninguna marca, y la carta cuelga de una marca.
          Empieza por <Link href="/panel/negocio">tu negocio</Link>.
        </p>
      </>
    );
  }

  const marca = marcas.find((m) => m.id === marcaPedida) ?? marcas[0]!;
  const productos = await cargar('/panel/catalogo', yaSeIntento, () =>
    panel.productos(marca.id),
  );

  return (
    <>
      <h1>Carta de {marca.name}</h1>
      <p className="panel__subtitulo">
        Los precios incluyen IGV. Un plato sin precio en un canal no se vende en
        ese canal.
      </p>

      {marcas.length > 1 ? (
        <p>
          {marcas.map((m) => (
            <Link
              key={m.id}
              href={`/panel/catalogo?marca=${m.id}`}
              className="etiqueta"
              style={{ marginRight: 8 }}
            >
              {m.name}
            </Link>
          ))}
        </p>
      ) : null}

      {productos.length === 0 ? (
        <p className="panel__vacio">
          Aún no hay platos en esta carta. Crea el primero aquí abajo — o sube
          la carta entera de golpe con el archivo de configuración (
          <code>docs/34-puesta-en-marcha.md</code> §5).
        </p>
      ) : (
        <div className="tabla-envoltorio">
          <table>
            <thead>
              <tr>
                <th>Plato</th>
                {CANALES.map((c) => (
                  <th key={c.id} className="dinero">
                    {c.rotulo}
                  </th>
                ))}
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {productos.map((p) => {
                const pausadoEn = new Set(p.pauses.map((x) => x.channel));
                const sinNingunPrecio = p.prices.length === 0;
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.sku ? (
                        <>
                          <br />
                          <span className="tarjeta__pie">{p.sku}</span>
                        </>
                      ) : null}
                      {p.categoryName ? (
                        <>
                          <br />
                          <span className="tarjeta__pie">{p.categoryName}</span>
                        </>
                      ) : null}
                    </td>
                    {CANALES.map((c) => (
                      <td key={c.id} className="dinero">
                        <FormularioPrecio
                          productId={p.id}
                          channel={c.id}
                          actual={precioDe(p, c.id)}
                        />
                      </td>
                    ))}
                    <td>
                      {sinNingunPrecio ? (
                        <span className="etiqueta etiqueta--sin-precio">
                          sin precio
                        </span>
                      ) : null}
                      {pausadoEn.size > 0 ? (
                        <span className="etiqueta etiqueta--pausado">
                          pausado en {[...pausadoEn].join(', ')}
                        </span>
                      ) : null}
                      <FormularioPausa
                        productId={p.id}
                        channel="*"
                        pausado={pausadoEn.has('*')}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Añadir</h2>
      <FormularioNuevoProducto brandId={marca.id} />

      <p className="tarjeta__pie">
        {productos.length === 1 ? '1 plato' : `${productos.length} platos`} ·{' '}
        {productos.filter((p) => p.prices.length === 0).length} sin precio ·{' '}
        {productos.filter((p) => p.pauses.length > 0).length} pausados
      </p>
    </>
  );
}
