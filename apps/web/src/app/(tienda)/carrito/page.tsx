import Link from 'next/link';
import { shop, type Cart } from '../../../lib/api';
import { getCartToken } from '../../../lib/cart-cookie';
import { formatDecimal } from '../../../lib/money';
import { CartActions, RemoveLine } from './cart-actions';

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
      <div className="vacio">
        <h1>Tu pedido está vacío</h1>
        <p className="pista">Elige algo de la carta y aparecerá aquí.</p>
        <Link href="/" className="boton-principal">
          Ver la carta
        </Link>
      </div>
    );
  }

  const agotados = carrito.lines.filter((l) => l.unavailable);

  return (
    <>
      <h1>Tu pedido</h1>

      {agotados.length > 0 ? (
        <div className="alerta" role="alert">
          <strong>
            {agotados.length === 1
              ? 'Un producto ya no está disponible.'
              : 'Algunos productos ya no están disponibles.'}
          </strong>
          <p className="pista">
            Quítalos para poder continuar:{' '}
            {agotados.map((l) => l.name).join(', ')}.
          </p>
        </div>
      ) : null}

      <ul className="lineas">
        {carrito.lines.map((linea) => (
          <li
            className={`linea${linea.unavailable ? ' linea--agotada' : ''}`}
            key={linea.id}
          >
            <div className="linea__texto">
              <p className="linea__nombre">{linea.name}</p>
              {linea.unavailable ? (
                <span className="linea__agotado">Ya no está disponible</span>
              ) : (
                <span className="pista">
                  {formatDecimal(linea.unitPrice)} c/u
                </span>
              )}
            </div>
            <div className="linea__derecha">
              <p className="linea__total">
                {linea.unavailable ? '—' : formatDecimal(linea.lineTotal)}
              </p>
              {linea.unavailable ? (
                <RemoveLine lineId={linea.id} />
              ) : (
                <CartActions lineId={linea.id} cantidad={linea.quantity} />
              )}
            </div>
          </li>
        ))}
      </ul>

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

      {agotados.length > 0 ? (
        <p className="pista">
          Quita lo que ya no está disponible para poder continuar.
        </p>
      ) : (
        <Link href="/checkout" className="boton-principal">
          Continuar con la entrega
        </Link>
      )}

      <p className="seguir">
        <Link href="/">← Seguir añadiendo</Link>
      </p>
    </>
  );
}
