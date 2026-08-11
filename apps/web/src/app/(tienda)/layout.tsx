import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { shop, type Cart } from '../../lib/api';
import { getCartToken } from '../../lib/cart-cookie';
import { formatDecimal } from '../../lib/money';
import { Bienvenida } from './bienvenida';

/**
 * El marco de la tienda.
 *
 * El nombre de la marca sale del HOST, resuelto en el servidor: es la misma
 * regla que rige toda la tienda y aquí es visible a simple vista — no hay
 * ningún parámetro del que sacarlo.
 *
 * Va en un grupo de rutas `(tienda)` —que no aparece en la URL— para que el
 * panel NO herede esta cabecera ni esta resolución por host.
 *
 * Lo que se añadió después de mirar la tienda en un móvil: **el carrito tiene
 * que estar siempre a la vista**. Antes era un enlace que ponía «Carrito», sin
 * número y sin importe, así que no había forma de saber si lo que acababas de
 * pulsar había entrado. La barra de abajo aparece en cuanto hay algo y dice
 * cuánto llevas y cuánto suma; es el patrón que usa cualquier app de delivery
 * porque es el que responde a la pregunta que uno se hace mientras pide.
 */

export async function generateMetadata(): Promise<Metadata> {
  try {
    const ctx = await shop.context();
    return {
      title: ctx.brandName,
      description: `Pide en línea de ${ctx.brandName}.`,
    };
  } catch {
    // Un host sin tienda no debe reventar el marco: la página de dentro ya
    // explica lo que pasa.
    return { title: 'Tienda' };
  }
}

/** El carrito actual, o `null`. Nunca lanza: es adorno, no es la página. */
async function carritoActual(): Promise<Cart | null> {
  const token = await getCartToken();
  if (!token) return null;
  try {
    return await shop.getCart(token);
  } catch {
    return null;
  }
}

export default async function TiendaLayout({
  children,
}: {
  children: ReactNode;
}) {
  let brandName = 'Tienda';
  let bienvenida: Awaited<ReturnType<typeof shop.context>>['welcome'] = null;
  let marcaId = '';
  let marca: Awaited<ReturnType<typeof shop.context>>['branding'] | null = null;
  try {
    const ctx = await shop.context();
    brandName = ctx.brandName;
    bienvenida = ctx.welcome;
    marcaId = ctx.brandId;
    marca = ctx.branding;
  } catch {
    // Se deja el rótulo neutro.
  }

  // Los colores del cliente entran como VARIABLES CSS, que es lo que permite
  // que toda la hoja de estilos —escrita una vez— se repinte con su marca sin
  // duplicar una sola regla.
  //
  // Los valores llegan validados por el servidor como `#rrggbb` y nada más. Es
  // la comprobación que importa: esto acaba dentro de un atributo `style`, y un
  // valor libre ahí es CSS de un tercero decidiendo cómo se ve —o si se ve— la
  // página.
  const tema: Record<string, string> = {};
  if (marca?.colorBase) tema['--color-marca'] = marca.colorBase;
  if (marca?.colorHover) tema['--color-marca-hover'] = marca.colorHover;
  if (marca?.colorTexto) tema['--color-texto'] = marca.colorTexto;

  const carrito = await carritoActual();
  const unidades =
    carrito?.lines.reduce((suma, l) => suma + l.quantity, 0) ?? 0;

  return (
    <>
      <header className="cabecera" style={tema}>
        <Link href="/" className="marca">
          {marca?.logoUrl ? (
            <img
              className="marca__logo"
              src={marca.logoUrl}
              alt={brandName}
              height={36}
            />
          ) : (
            brandName
          )}
        </Link>
        <Link href="/carrito" className="enlace-carrito">
          Carrito
          {unidades > 0 ? (
            <span className="contador" aria-label={`${unidades} en el pedido`}>
              {unidades}
            </span>
          ) : null}
        </Link>
      </header>

      {/* El hueco de abajo evita que la barra fija tape el último plato: sin
          él, el producto del final de la carta queda siempre medio oculto. */}
      <main className={unidades > 0 ? 'con-barra' : undefined} style={tema}>
        {marca?.coverUrl ? (
          <img className="portada" src={marca.coverUrl} alt="" />
        ) : null}
        {marca?.tagline ? <p className="lema">{marca.tagline}</p> : null}
        {children}
      </main>

      {unidades > 0 && carrito ? (
        <Link href="/carrito" className="barra-carrito" style={tema}>
          <span className="barra-carrito__cuenta">
            {unidades} {unidades === 1 ? 'producto' : 'productos'}
          </span>
          <span className="barra-carrito__ver">Ver mi pedido</span>
          <span className="barra-carrito__total">
            {formatDecimal(carrito.total)}
          </span>
        </Link>
      ) : null}

      {/* La oferta de bienvenida solo aparece si el dueño ha marcado una y
          sigue vigente: no hay ningún descuento inventado por la tienda. */}
      {bienvenida ? (
        <Bienvenida
          marca={marcaId}
          codigo={bienvenida.code}
          texto={bienvenida.label}
        />
      ) : null}

      <footer className="pie">
        <p>
          Los precios incluyen IGV. Al pedir aceptas nuestros términos y la
          política de privacidad.
        </p>
      </footer>
    </>
  );
}
