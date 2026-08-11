import Link from 'next/link';
import { notFound } from 'next/navigation';
import { shop, ApiError, type CatalogProduct } from '../../../../lib/api';
import { formatMoney } from '../../../../lib/money';
import { FormularioProducto } from './formulario';

/**
 * La ficha de un plato: foto, qué lleva, opciones y cuántos.
 *
 * Es una RUTA de verdad y no una ventana emergente, y eso decide bastante más
 * de lo que parece:
 *
 *  · **El botón atrás del móvil funciona.** Es el gesto que más se usa en un
 *    teléfono, y con un modal deja de cerrar la ficha para sacarte de la tienda.
 *  · **Se puede compartir por WhatsApp.** «Mira este», con su enlace, es cómo se
 *    piden las cosas aquí.
 *  · **Funciona sin JavaScript**, igual que el resto de la tienda.
 *
 * Antes los modificadores se pintaban DENTRO de cada tarjeta de la carta. Con
 * tres platos parecía razonable; con treinta, la carta era un formulario de
 * varias pantallas por el que había que bajar para ver el segundo plato. Elegir
 * opciones es una decisión sobre UN plato, y su sitio es la pantalla de ese
 * plato.
 */

export const dynamic = 'force-dynamic';

export default async function ProductoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  let catalogo;
  try {
    catalogo = await shop.catalog();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const producto: CatalogProduct | undefined = catalogo.products.find(
    (p) => p.id === id,
  );
  // Un plato que ya no está en la carta —se pausó mientras alguien lo miraba—
  // es un 404 de verdad, no una página vacía: así el navegador y los buscadores
  // se enteran, y quien llega desde un enlace viejo entiende qué pasó.
  if (!producto) notFound();

  const categoria = catalogo.categories.find(
    (c) => c.id === producto.categoryId,
  );

  return (
    <article className="ficha">
      <nav className="ficha__volver">
        <Link href="/">← Volver a la carta</Link>
      </nav>

      {producto.imageUrl ? (
        <img
          className="ficha__foto"
          src={producto.imageUrl}
          alt={producto.name}
          width={720}
          height={480}
        />
      ) : null}

      <header className="ficha__cabecera">
        {categoria ? (
          <p className="ficha__categoria">{categoria.name}</p>
        ) : null}
        <h1>{producto.name}</h1>
        <p className="ficha__precio">{formatMoney(producto.price)}</p>
        {producto.description ? (
          <p className="ficha__descripcion">{producto.description}</p>
        ) : null}
      </header>

      <FormularioProducto
        producto={producto}
        error={typeof sp['error'] === 'string' ? sp['error'] : undefined}
      />
    </article>
  );
}
