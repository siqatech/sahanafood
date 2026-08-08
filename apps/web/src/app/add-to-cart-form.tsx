'use client';

import { useActionState } from 'react';
import { addToCart, type ActionState } from './actions';
import type { CatalogProduct } from '../lib/api';
import { formatDelta } from '../lib/money';

/**
 * El único componente de cliente del catálogo, y solo por una razón: enseñar el
 * error sin recargar la página cuando falta elegir un grupo obligatorio.
 *
 * Sin JavaScript **también funciona**: es un `<form>` de verdad que postea a una
 * acción de servidor. Quien tenga la red mal o el bundle a medio cargar puede
 * comprar igual. Eso no es una concesión: es lo que se pide desde un móvil en
 * una zona con cobertura irregular.
 *
 * La validación de los modificadores NO se duplica aquí. El `required` del HTML
 * ayuda a no enviar en balde, pero quien decide es el servidor —con la misma
 * función que usa el pedido—, así que la tienda no puede discrepar de la caja.
 */
export function AddToCartForm({ producto }: { producto: CatalogProduct }) {
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    addToCart,
    {},
  );

  return (
    <form action={accion}>
      <input type="hidden" name="productId" value={producto.id} />
      <input type="hidden" name="quantity" value="1" />

      {producto.modifierGroups.map((grupo) => {
        const obligatorio = grupo.minSelections > 0;
        const unaSola = grupo.maxSelections === 1;
        return (
          <fieldset key={grupo.id}>
            <legend>
              {grupo.name}{' '}
              {obligatorio ? (
                <span className="obligatorio">· obligatorio</span>
              ) : (
                <span className="nota">· opcional</span>
              )}
            </legend>
            {grupo.options
              .filter((o) => o.available)
              .map((opcion) => (
                <div className="opcion" key={opcion.id}>
                  <input
                    id={`${producto.id}-${opcion.id}`}
                    type={unaSola ? 'radio' : 'checkbox'}
                    name="modifierOptionIds"
                    value={opcion.id}
                    // El `required` del navegador solo sirve en grupos de una
                    // sola opción; en los de varias, el mínimo lo comprueba el
                    // servidor, que es donde vive la regla.
                    required={obligatorio && unaSola}
                  />
                  <label htmlFor={`${producto.id}-${opcion.id}`}>
                    {opcion.name}
                    {opcion.priceDeltaMinor !== 0
                      ? ` (${formatDelta(opcion.priceDeltaMinor)})`
                      : ''}
                  </label>
                </div>
              ))}
          </fieldset>
        );
      })}

      {estado.error ? (
        <p className="aviso" role="alert">
          {estado.error}
        </p>
      ) : null}

      <button type="submit" disabled={pendiente}>
        {pendiente ? 'Añadiendo…' : 'Añadir al carrito'}
      </button>
    </form>
  );
}
