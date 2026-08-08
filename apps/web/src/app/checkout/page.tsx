import Link from 'next/link';
import { shop, type Cart } from '../../lib/api';
import { getCartToken } from '../../lib/cart-cookie';
import { formatDecimal } from '../../lib/money';
import { CheckoutForm } from './checkout-form';

/**
 * El checkout de invitado (T5.11).
 *
 * Sin cuenta, sin contraseña, sin verificación por correo: se piden **los datos
 * mínimos para entregar la comida** (RN-STO-04). Cada campo de más es una razón
 * más para cerrar la pestaña, y una obligación más bajo la ley 29733.
 */

export const dynamic = 'force-dynamic';

export default async function CheckoutPage() {
  const token = await getCartToken();
  let carrito: Cart | null = null;
  if (token) {
    try {
      carrito = await shop.getCart(token);
    } catch {
      carrito = null;
    }
  }

  if (!carrito || carrito.lines.length === 0) {
    return (
      <>
        <h1>Finalizar pedido</h1>
        <p className="nota">Tu carrito está vacío.</p>
        <Link href="/">
          <button type="button">Ver la carta</button>
        </Link>
      </>
    );
  }

  const esRecojo = carrito.fulfillment === 'pickup';
  const tieneDireccion = Boolean(carrito.lines.length) && !esRecojo;

  return (
    <>
      <h1>Finalizar pedido</h1>

      {esRecojo && carrito.blockers.every((b) => b.code !== 'NO_ADDRESS') ? (
        <div className="aviso">
          <strong>No llegamos a tu dirección.</strong>
          <p className="nota">
            Pero puedes recoger tu pedido en el local. El envío no se cobra.
          </p>
        </div>
      ) : null}

      <CheckoutForm
        conDireccion={tieneDireccion}
        total={formatDecimal(carrito.total)}
      />

      <div className="totales">
        <div className="totales__fila">
          <span>Subtotal</span>
          <span>{formatDecimal(carrito.subtotal)}</span>
        </div>
        {Number(carrito.deliveryFee) > 0 ? (
          <div className="totales__fila">
            <span>Envío</span>
            <span>{formatDecimal(carrito.deliveryFee)}</span>
          </div>
        ) : null}
        {Number(carrito.discount) > 0 ? (
          <div className="totales__fila">
            <span>Descuento</span>
            <span>−{formatDecimal(carrito.discount)}</span>
          </div>
        ) : null}
        <div className="totales__fila totales__fila--total">
          <span>Total</span>
          <span>{formatDecimal(carrito.total)}</span>
        </div>
      </div>
    </>
  );
}
