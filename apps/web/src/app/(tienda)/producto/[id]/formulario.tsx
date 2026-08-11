'use client';

import { useActionState, useState } from 'react';
import { addToCart, type ActionState } from '../../actions';
import type { CatalogProduct } from '../../../../lib/api';
import { formatDelta, formatMoney } from '../../../../lib/money';

/**
 * Elegir opciones y cantidad, con el precio actualizándose a la vista.
 *
 * Dos decisiones que vienen de mirar cómo falla la versión anterior:
 *
 * **La validación se dice en español y en la página.** Antes se dejaba en manos
 * del `required` del navegador, que en un grupo obligatorio saca un globo del
 * sistema —«Please select one of these options», en inglés, aunque la tienda
 * esté en español— que desaparece solo a los pocos segundos. El resultado es
 * que pulsabas «Añadir», no pasaba nada visible y el carrito seguía vacío. Un
 * error que se va solo no es un error: es un misterio.
 *
 * **El total se ve antes de decidir.** Que el precio suba al marcar «Grande» es
 * lo que evita la sorpresa en el carrito, y es un cálculo de suma sobre
 * importes que ya vienen del servidor — no se duplica ninguna regla de precios
 * aquí, que es lo que prohíbe CLAUDE.md. Sin JavaScript el total simplemente no
 * se mueve, y el servidor cobra lo mismo igual.
 */
export function FormularioProducto({
  producto,
  error,
}: {
  producto: CatalogProduct;
  error?: string | undefined;
}) {
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    addToCart,
    error ? { error } : {},
  );

  const [elegidas, setElegidas] = useState<Record<string, string[]>>({});
  const [cantidad, setCantidad] = useState(1);

  const obligatoriosSinElegir = producto.modifierGroups.filter(
    (g) => g.minSelections > 0 && (elegidas[g.id] ?? []).length === 0,
  );

  const extra = producto.modifierGroups.reduce((suma, grupo) => {
    const ids = elegidas[grupo.id] ?? [];
    return (
      suma +
      grupo.options
        .filter((o) => ids.includes(o.id))
        .reduce((s, o) => s + o.priceDeltaMinor, 0)
    );
  }, 0);

  const total = {
    ...producto.price,
    minorUnits: (producto.price.minorUnits + extra) * cantidad,
  };

  function marcar(grupoId: string, opcionId: string, unaSola: boolean): void {
    setElegidas((previo) => {
      const actuales = previo[grupoId] ?? [];
      if (unaSola) return { ...previo, [grupoId]: [opcionId] };
      return {
        ...previo,
        [grupoId]: actuales.includes(opcionId)
          ? actuales.filter((x) => x !== opcionId)
          : [...actuales, opcionId],
      };
    });
  }

  return (
    <form action={accion} className="ficha__form">
      <input type="hidden" name="productId" value={producto.id} />
      <input type="hidden" name="quantity" value={cantidad} />

      {producto.modifierGroups.map((grupo) => {
        const obligatorio = grupo.minSelections > 0;
        const unaSola = grupo.maxSelections === 1;
        const falta = obligatoriosSinElegir.some((g) => g.id === grupo.id);
        return (
          <fieldset
            key={grupo.id}
            className={`grupo${falta && estado.error ? ' grupo--falta' : ''}`}
          >
            <legend className="grupo__titulo">
              <span>{grupo.name}</span>
              <span className={obligatorio ? 'etiqueta-oblig' : 'etiqueta-opc'}>
                {obligatorio ? 'Obligatorio' : 'Opcional'}
              </span>
            </legend>
            {grupo.options
              .filter((o) => o.available)
              .map((opcion) => (
                <label className="opcion" key={opcion.id}>
                  <input
                    type={unaSola ? 'radio' : 'checkbox'}
                    name="modifierOptionIds"
                    value={opcion.id}
                    checked={(elegidas[grupo.id] ?? []).includes(opcion.id)}
                    onChange={() => marcar(grupo.id, opcion.id, unaSola)}
                  />
                  <span className="opcion__nombre">{opcion.name}</span>
                  {opcion.priceDeltaMinor !== 0 ? (
                    <span className="opcion__delta">
                      {formatDelta(opcion.priceDeltaMinor)}
                    </span>
                  ) : null}
                </label>
              ))}
          </fieldset>
        );
      })}

      <div className="cantidad">
        <span className="cantidad__rotulo">Cantidad</span>
        <div className="cantidad__mando">
          <button
            type="button"
            aria-label="Quitar uno"
            onClick={() => setCantidad((c) => Math.max(1, c - 1))}
            disabled={cantidad <= 1}
          >
            −
          </button>
          <output aria-live="polite">{cantidad}</output>
          <button
            type="button"
            aria-label="Añadir uno"
            onClick={() => setCantidad((c) => Math.min(50, c + 1))}
            disabled={cantidad >= 50}
          >
            +
          </button>
        </div>
      </div>

      {estado.error ? (
        <p className="alerta" role="alert">
          {estado.error}
        </p>
      ) : null}

      {/* El botón dice el total: es la última cifra que se ve antes de decidir,
          y verla ahí evita la sorpresa al abrir el carrito. */}
      <button type="submit" className="boton-principal" disabled={pendiente}>
        {pendiente ? 'Añadiendo…' : `Añadir · ${formatMoney(total)}`}
      </button>

      {obligatoriosSinElegir.length > 0 ? (
        <p className="pista" role="status">
          Falta elegir{' '}
          {obligatoriosSinElegir.map((g) => g.name.toLowerCase()).join(' y ')}.
        </p>
      ) : null}
    </form>
  );
}
