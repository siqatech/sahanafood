import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { shop } from '../lib/api';
import './globals.css';

/**
 * El marco de la tienda.
 *
 * El nombre de la marca sale del HOST, resuelto en el servidor: es la misma
 * regla que rige toda la tienda y aquí es visible a simple vista — no hay
 * ningún parámetro del que sacarlo.
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

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  let brandName = 'Tienda';
  try {
    brandName = (await shop.context()).brandName;
  } catch {
    // Se deja el rótulo neutro.
  }

  return (
    <html lang="es">
      <body>
        <header className="cabecera">
          <Link href="/" className="marca">
            {brandName}
          </Link>
          <Link href="/carrito" className="enlace-carrito">
            Carrito
          </Link>
        </header>
        <main>{children}</main>
        <footer className="pie">
          <p>
            Los precios incluyen IGV. Al pedir aceptas nuestros términos y la
            política de privacidad.
          </p>
        </footer>
      </body>
    </html>
  );
}
