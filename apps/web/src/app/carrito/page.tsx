import Link from 'next/link';
import { shop, type Cart } from '../../lib/api';
import { getCartToken } from '../../lib/cart-cookie';
import { formatDecimal } from '../../lib/money';
import { CartActions } from './cart-actions';

/**
 * El carrito.
 *
 * Se lee del SERVIDOR en cada visita, con precios frescos: un producto que se
 * agotó mientras el cliente decidía aparece marcado y con su nombre, no
 * desaparecido. Que desapareciera en silencio se siente como un fallo de la
 * tienda y hace abandonar la compra.
 */

export const dynamic = 'force-dynamic';

export default async function CartPage() {
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
        <h1>Tu carrito</h1>
        <p className="nota">Todavía no has añadido nada.</p>
        <Link href="/">
          <button type="button">Ver la carta</button>
        </Link>
      </>
    );
  }

  const agotados = carrito.lines.filter((l) => l.unavailable);

  return (
    <>
      <h1>Tu carrito</h1>

      {agotados.length > 0 ? (
        <div className="aviso" role="alert">
          <strong>
            {agotados.length === 1
              ? 'Un producto ya no está disponible.'
              : 'Algunos productos ya no están disponibles.'}
          </strong>
          <p className="nota">
            Quítalos para poder continuar:{' '}
            {agotados.map((l) => l.name).join(', ')}.
          </p>
        </div>
      ) : null}

      {carrito.lines.map((linea) => (
        <div
          className={`linea${linea.unavailable ? ' linea--agotada' : ''}`}
          key={linea.id}
        >
          <div>
            <div className="linea__nombre">
              {linea.quantity} × {linea.name}
            </div>
            {linea.unavailable ? (
              <span className="nota">Agotado</span>
            ) : (
              <span className="nota">{formatDecimal(linea.unitPrice)} c/u</span>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div>
              {linea.unavailable ? '—' : formatDecimal(linea.lineTotal)}
            </div>
            <CartActions lineId={linea.id} />
          </div>
        </div>
      ))}

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
            <span>
              Descuento{carrito.coupon ? ` (${carrito.coupon.code})` : ''}
            </span>
            <span>−{formatDecimal(carrito.discount)}</span>
          </div>
        ) : null}
        <div className="totales__fila totales__fila--total">
          <span>Total</span>
          <span>{formatDecimal(carrito.total)}</span>
        </div>
      </div>

      <CartActions coupon={carrito.coupon} />

      <Link href="/checkout">
        <button type="button" disabled={agotados.length > 0}>
          Continuar
        </button>
      </Link>
    </>
  );
}
