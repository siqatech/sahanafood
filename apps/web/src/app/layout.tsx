import type { ReactNode } from 'react';
import './globals.css';

/**
 * Marco raíz de `apps/web`, que sirve DOS superficies distintas:
 *
 *  · La **tienda** del comprador — `(tienda)`, resuelta por el `Host`.
 *  · El **panel** de gestión — `/panel`, con sesión.
 *
 * Aquí no va nada más que `<html>` y `<body>`, y eso es el punto. Antes este
 * archivo resolvía la marca por el host y pintaba la cabecera de la tienda: si
 * el panel colgara de él, cada pantalla de gestión haría una llamada a la API
 * de tienda para pintar un rótulo que no le corresponde, y en un host que no es
 * de ninguna tienda esa llamada falla. Cada superficie tiene su usuario y su
 * contexto (docs/25); comparten el documento, no el marco.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
