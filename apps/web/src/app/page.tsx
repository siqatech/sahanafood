import { shop, ApiError, type CatalogProduct } from '../lib/api';
import { formatMoney } from '../lib/money';
import { AddToCartForm } from './add-to-cart-form';

/**
 * El catálogo. La página que tiene que ser rápida (T5.14).
 *
 * Es un componente de SERVIDOR: el HTML sale ya montado y el navegador no
 * recibe ni el catálogo en JSON ni el código para pintarlo. Lo único que se
 * hidrata es el formulario de cada producto, que necesita enseñar el error si
 * falta elegir el tamaño.
 */

export const dynamic = 'force-dynamic';

function precio(p: CatalogProduct): string {
  // El importe llega ya calculado por el servidor y aquí solo se formatea, con
  // el `Money` del dominio. La tienda NUNCA calcula precios: es la regla de
  // «cálculo solo en @sahana/domain».
  return formatMoney(p.price);
}

export default async function CatalogPage() {
  let catalogo;
  try {
    catalogo = await shop.catalog();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="aviso">
          <strong>No hay ninguna tienda en este dominio.</strong>
          <p className="nota">
            Si acabas de configurar tu dominio, la verificación puede tardar
            unos minutos en propagarse.
          </p>
        </div>
      );
    }
    throw error;
  }

  const porCategoria = new Map<string, CatalogProduct[]>();
  for (const producto of catalogo.products) {
    const clave = producto.categoryId ?? 'sin-categoria';
    porCategoria.set(clave, [...(porCategoria.get(clave) ?? []), producto]);
  }

  if (catalogo.products.length === 0) {
    return (
      <div className="aviso">
        <strong>La carta no está disponible ahora mismo.</strong>
        <p className="nota">Vuelve en un rato: estamos preparando el menú.</p>
      </div>
    );
  }

  return (
    <>
      <h1>Nuestra carta</h1>
      {catalogo.categories.map((categoria) => {
        const productos = porCategoria.get(categoria.id) ?? [];
        if (productos.length === 0) return null;
        return (
          <section key={categoria.id}>
            <h2>{categoria.name}</h2>
            {productos.map((producto) => (
              <article className="producto" key={producto.id}>
                <div className="producto__cabecera">
                  <span className="producto__nombre">{producto.name}</span>
                  <span className="producto__precio">{precio(producto)}</span>
                </div>
                {producto.description ? (
                  <p className="producto__descripcion">
                    {producto.description}
                  </p>
                ) : null}
                <AddToCartForm producto={producto} />
              </article>
            ))}
          </section>
        );
      })}
      {(porCategoria.get('sin-categoria') ?? []).length > 0 ? (
        <section>
          <h2>Otros</h2>
          {(porCategoria.get('sin-categoria') ?? []).map((producto) => (
            <article className="producto" key={producto.id}>
              <div className="producto__cabecera">
                <span className="producto__nombre">{producto.name}</span>
                <span className="producto__precio">{precio(producto)}</span>
              </div>
              <AddToCartForm producto={producto} />
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}
