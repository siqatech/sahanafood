'use client';

import { useActionState } from 'react';
import { removeLine, applyCoupon, type ActionState } from '../actions';
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
  coupon,
}: {
  lineId?: string;
  coupon?: Cart['coupon'];
}) {
  if (lineId) return <RemoveLine lineId={lineId} />;
  return <CouponForm coupon={coupon ?? null} />;
}

function RemoveLine({ lineId }: { lineId: string }) {
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
    <form action={accion} style={{ marginTop: 'var(--espacio)' }}>
      <div className="campo">
        <label htmlFor="code">¿Tienes un cupón?</label>
        <input
          id="code"
          name="code"
          type="text"
          defaultValue={coupon?.code ?? ''}
          placeholder="BIENVENIDO"
          autoComplete="off"
        />
      </div>
      {coupon?.applied ? (
        <p className="nota">Cupón {coupon.code} aplicado.</p>
      ) : null}
      {rechazo ? (
        <p className="aviso" role="alert">
          {rechazo}
        </p>
      ) : null}
      {estado.error ? (
        <p className="aviso" role="alert">
          {estado.error}
        </p>
      ) : null}
      <button type="submit" className="secundario" disabled={pendiente}>
        Aplicar cupón
      </button>
    </form>
  );
}
