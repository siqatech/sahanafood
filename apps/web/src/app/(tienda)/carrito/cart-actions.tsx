'use client';

import { useActionState } from 'react';
import {
  removeLine,
  applyCoupon,
  setQuantity,
  type ActionState,
} from '../actions';
import type { Cart } from '../../../lib/api';

/**
 * Los dos formularios del carrito: quitar una línea y aplicar un cupón.
 *
 * Un cupón rechazado tiene que decir POR QUÉ. «Cupón inválido» hace abandonar
 * el carrito; «te faltan S/ 12 para usarlo» hace añadir un postre. El motivo
 * llega del servidor —el cálculo es de `@sahana/domain`— y aquí solo se
 * traduce a algo que una persona entienda.
 */

const MOTIVOS: Record<string, string> = {
  COUPON_UNKNOWN: 'Ese código no existe.',
  COUPON_INACTIVE: 'Ese cupón ya no está activo.',
  COUPON_EXPIRED: 'Ese cupón ya caducó.',
  COUPON_NOT_YET_VALID: 'Ese cupón todavía no se puede usar.',
  COUPON_EXHAUSTED: 'Ese cupón ya se agotó.',
  COUPON_BELOW_MINIMUM: 'Tu pedido aún no llega al mínimo de este cupón.',
};

export function CartActions({
  lineId,
  cantidad,
  coupon,
}: {
  lineId?: string;
  cantidad?: number;
  coupon?: Cart['coupon'];
}) {
  if (lineId) return <Cantidad lineId={lineId} cantidad={cantidad ?? 1} />;
  return <CouponForm coupon={coupon ?? null} />;
}

/**
 * Los botones «−», la cantidad y «+».
 *
 * Es la operación más usada de un carrito y no existía: solo se podía quitar la
 * línea entera. Querer dos obligaba a volver a la carta, entrar otra vez en la
 * ficha y elegir de nuevo todas las opciones.
 *
 * En uno, el «−» se convierte en «Quitar» en vez de deshabilitarse. Un botón
 * apagado no dice cómo deshacerse de algo; y esconder «Quitar» en otro sitio
 * obliga a buscarlo. Por debajo son la misma llamada: cantidad cero borra.
 */
function Cantidad({ lineId, cantidad }: { lineId: string; cantidad: number }) {
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    setQuantity,
    {},
  );
  return (
    <form action={accion} className="linea__cantidad">
      <input type="hidden" name="lineId" value={lineId} />
      <button
        type="submit"
        name="quantity"
        value={cantidad - 1}
        className="paso"
        disabled={pendiente}
        aria-label={cantidad === 1 ? 'Quitar del pedido' : 'Quitar uno'}
      >
        {cantidad === 1 ? 'Quitar' : '−'}
      </button>
      <output className="paso__valor">{cantidad}</output>
      <button
        type="submit"
        name="quantity"
        value={cantidad + 1}
        className="paso"
        disabled={pendiente || cantidad >= 50}
        aria-label="Añadir uno"
      >
        +
      </button>
      {estado.error ? (
        <span className="pista" role="alert">
          {estado.error}
        </span>
      ) : null}
    </form>
  );
}

/** Quitar una línea de golpe: lo usa el aviso de producto agotado. */
export function RemoveLine({ lineId }: { lineId: string }) {
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    removeLine,
    {},
  );
  return (
    <form action={accion}>
      <input type="hidden" name="lineId" value={lineId} />
      <button type="submit" className="secundario" disabled={pendiente}>
        Quitar
      </button>
      {estado.error ? <span className="nota">{estado.error}</span> : null}
    </form>
  );
}

function CouponForm({ coupon }: { coupon: Cart['coupon'] }) {
  const [estado, accion, pendiente] = useActionState<ActionState, FormData>(
    applyCoupon,
    {},
  );

  const rechazo =
    coupon && !coupon.applied
      ? (MOTIVOS[coupon.reason ?? ''] ?? 'Ese cupón no se puede usar ahora.')
      : null;

  return (
    <form action={accion} className="cupon">
      <label htmlFor="code" className="cupon__rotulo">
        ¿Tienes un cupón?
      </label>
      <div className="cupon__fila">
        <input
          id="code"
          name="code"
          type="text"
          defaultValue={coupon?.code ?? ''}
          placeholder="BIENVENIDO"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button type="submit" className="cupon__boton" disabled={pendiente}>
          {pendiente ? 'Aplicando…' : 'Aplicar'}
        </button>
      </div>
      {coupon?.applied ? (
        <p className="cupon__ok">Cupón {coupon.code} aplicado.</p>
      ) : null}
      {rechazo ? (
        <p className="alerta" role="alert">
          {rechazo}
        </p>
      ) : null}
      {estado.error ? (
        <p className="alerta" role="alert">
          {estado.error}
        </p>
      ) : null}
    </form>
  );
}
