import Link from 'next/link';
import { shop, ApiError, type CatalogProduct } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { BotonRapido } from './boton-rapido';

/**
 * La carta. La página que tiene que ser rápida (T5.14) y la que vende.
 *
 * Es un componente de SERVIDOR: el HTML sale montado y el navegador no recibe
 * ni el catálogo en JSON ni el código para pintarlo. Lo único que se hidrata es
 * el botón de añadido rápido.
 *
 * La versión anterior pintaba TODOS los modificadores de TODOS los platos
 * dentro de la lista. Con los tres platos de la demo colaba; con una carta real
 * de treinta, había que bajar dos pantallas para ver el segundo plato, y elegir
 * el tamaño de un pollo obligaba a leer por encima las opciones de los otros
 * veintinueve. Ahora la carta es una lista para ojear —foto, nombre, precio— y
 * elegir opciones ocurre en la ficha del plato.
 *
 * Los platos SIN opciones se añaden desde aquí, en un toque. Obligar a entrar a
 * una ficha para pedir una gaseosa es un paso de más en el sitio donde más
 * gente abandona.
 *
 * Las fotos van con `<img>` y no con `next/image` a propósito: las URL las pone
 * cada cliente en su carta, y `next/image` exige declarar de antemano los
 * dominios permitidos —habría que tocar la configuración y volver a desplegar
 * cada vez que un restaurante cambia de proveedor de imágenes— además de sumar
 * JavaScript al presupuesto de T5.14. `loading="lazy"` da lo que aquí importa:
 * que las fotos de abajo no retrasen la primera pantalla.
 */

export const dynamic = 'force-dynamic';

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const anadido = typeof sp['anadido'] === 'string' ? sp['anadido'] : '';

  let catalogo;
  try {
    catalogo = await shop.catalog();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div className="alerta">
          <strong>No hay ninguna tienda en este dominio.</strong>
          <p className="pista">
            Si acabas de configurar tu dominio, la verificación puede tardar
            unos minutos en propagarse.
          </p>
        </div>
      );
    }
    throw error;
  }

  if (catalogo.products.length === 0) {
    return (
      <div className="alerta">
        <strong>La carta no está disponible ahora mismo.</strong>
        <p className="pista">Vuelve en un rato: estamos preparando el menú.</p>
      </div>
    );
  }

  const porCategoria = new Map<string, CatalogProduct[]>();
  for (const producto of catalogo.products) {
    const clave = producto.categoryId ?? 'sin-categoria';
    porCategoria.set(clave, [...(porCategoria.get(clave) ?? []), producto]);
  }

  const secciones = [
    ...catalogo.categories
      .map((c) => ({
        id: c.id,
        nombre: c.name,
        productos: porCategoria.get(c.id) ?? [],
      }))
      .filter((s) => s.productos.length > 0),
    ...((porCategoria.get('sin-categoria') ?? []).length > 0
      ? [
          {
            id: 'sin-categoria',
            nombre: 'Otros',
            productos: porCategoria.get('sin-categoria') ?? [],
          },
        ]
      : []),
  ];

  return (
    <>
      {anadido ? (
        // La confirmación de que el plato entró. Antes no existía: añadir con
        // éxito y fallar se veían igual, y de ahí salía «el carrito no
        // funciona».
        <p className="confirmacion" role="status">
          <strong>{anadido}</strong> está en tu pedido.
        </p>
      ) : null}

      {/* Navegación por categorías: en una carta de treinta platos, llegar a
          «Bebidas» no puede costar cinco deslizamientos. Son anclas de HTML, así
          que funcionan sin JavaScript. */}
      {secciones.length > 1 ? (
        <nav className="categorias" aria-label="Categorías de la carta">
          {secciones.map((s) => (
            <a key={s.id} href={`#cat-${s.id}`} className="categorias__chip">
              {s.nombre}
            </a>
          ))}
        </nav>
      ) : null}

      {secciones.map((seccion) => (
        <section key={seccion.id} id={`cat-${seccion.id}`} className="seccion">
          <h2 className="seccion__titulo">{seccion.nombre}</h2>
          <ul className="platos">
            {seccion.productos.map((producto) => {
              const necesitaElegir = producto.modifierGroups.some(
                (g) => g.minSelections > 0,
              );
              const tieneOpciones = producto.modifierGroups.length > 0;
              return (
                <li className="plato" key={producto.id}>
                  <Link
                    href={`/producto/${producto.id}`}
                    className="plato__enlace"
                  >
                    <div className="plato__texto">
                      <h3 className="plato__nombre">{producto.name}</h3>
                      {producto.description ? (
                        <p className="plato__descripcion">
                          {producto.description}
                        </p>
                      ) : null}
                      <p className="plato__precio">
                        {formatMoney(producto.price)}
                        {necesitaElegir ? (
                          <span className="plato__desde"> · a elegir</span>
                        ) : null}
                      </p>
                    </div>
                    {producto.imageUrl ? (
                      <img
                        className="plato__foto"
                        src={producto.imageUrl}
                        alt=""
                        width={200}
                        height={200}
                        loading="lazy"
                      />
                    ) : null}
                  </Link>
                  {tieneOpciones ? (
                    <Link
                      href={`/producto/${producto.id}`}
                      className="plato__accion"
                    >
                      Elegir opciones
                    </Link>
                  ) : (
                    <BotonRapido producto={producto} />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}
