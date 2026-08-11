'use client';

import { useActionState } from 'react';
import { addToCart, type ActionState } from './actions';
import type { CatalogProduct } from '../../lib/api';

/**
 * Añadir en un toque, para los platos que no hay que configurar.
 *
 * Una gaseosa no tiene tamaño ni extras: mandar a una ficha para pulsar otro
 * botón es un paso de más justo donde más gente abandona. Los platos que SÍ
 * tienen opciones no llevan este botón — enseñar «Añadir» y que el añadido
 * falle porque faltaba elegir el tamaño es exactamente el fallo que esta
 * pantalla venía a arreglar.
 *
 * Es un `<form>` de verdad: sin JavaScript también añade.
 */
export function BotonRapido({ producto }: { producto: CatalogProduct }) {
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    addToCart,
    {},
  );

  return (
    <form action={accion} className="plato__form">
      <input type="hidden" name="productId" value={producto.id} />
      <input type="hidden" name="quantity" value="1" />
      <button type="submit" className="plato__accion" disabled={pendiente}>
        {pendiente ? 'Añadiendo…' : 'Añadir'}
      </button>
      {estado.error ? (
        <span className="plato__error" role="alert">
          {estado.error}
        </span>
      ) : null}
    </form>
  );
}
