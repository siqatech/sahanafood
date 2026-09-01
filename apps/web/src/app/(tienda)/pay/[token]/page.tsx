import Link from 'next/link';
import { shop, ApiError, type EnlaceDePago } from '../../../../lib/api';
import { leerPago, horaDeCaducidad } from '../estado';

/**
 * «Págame esto» (T5.05).
 *
 * El módulo de pagos emitía enlaces desde T5.05 —token público de ADR-0017,
 * caducidad, registro en auditoría, endpoint público que devuelve lo mínimo—
 * y devolvía la URL `/pay/{token}`. **Esa página no existía.** Al cliente se le
 * mandaba una URL rota para que pagase: el mismo agujero que tuvo el
 * seguimiento hasta T5.16, con la diferencia de que aquí se pierde la venta.
 *
 * Va en el grupo `(tienda)` para heredar la cabecera y los colores de la marca:
 * quien abre esto va a meter una tarjeta, y una página blanca sin marca —donde
 * se pide dinero— es indistinguible de una estafa.
 */

export const dynamic = 'force-dynamic';

export default async function PagoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  let enlace: EnlaceDePago;
  try {
    enlace = await shop.enlaceDePago(token);
  } catch (error) {
    // Un token caducado y uno inventado se contestan IGUAL, como en
    // seguimiento: distinguirlos convertiría esta página en una forma de
    // averiguar qué cobros existieron.
    const noEncontrado = error instanceof ApiError && error.status === 404;
    return (
      <>
        <h1>Este enlace de pago ya no sirve</h1>
        <p className="nota">
          {noEncontrado
            ? 'Los enlaces de pago caducan. Escríbenos y te mandamos uno nuevo en un momento.'
            : 'No hemos podido consultar el cobro. Vuelve a intentarlo en un momento.'}
        </p>
        <Link href="/">
          <button type="button">Ver la carta</button>
        </Link>
      </>
    );
  }

  const lectura = leerPago(enlace.status);

  return (
    <>
      <h1>{lectura.titulo}</h1>

      {/* El importe SIEMPRE, incluso cuando ya no se puede pagar: es el dato
          por el que se abre este enlace, y esconderlo en la pantalla de «ya
          está pagado» deja al comprador sin saber de cuánto hablamos. */}
      <p className="importe-pago">
        <strong>
          {enlace.currency === 'PEN' ? 'S/' : enlace.currency} {enlace.amount}
        </strong>
      </p>

      <p>{lectura.detalle}</p>

      {lectura.sePuedePagar && enlace.checkoutUrl ? (
        <>
          {/* Enlace y no botón con JavaScript: si el script no carga —un móvil
              con mala cobertura es el escenario normal aquí— el enlace sigue
              llevando a la pasarela. */}
          <a href={enlace.checkoutUrl} rel="noopener noreferrer">
            <button type="button">Pagar ahora</button>
          </a>
          <p className="nota">
            El enlace vale hasta las{' '}
            <strong>{horaDeCaducidad(enlace.expiresAt)}</strong>. Pasada esa
            hora, escríbenos y te mandamos otro.
          </p>
        </>
      ) : null}

      {/* Si el estado dice que se puede pagar pero la pasarela no dio a dónde
          ir, se dice en vez de enseñar un botón que no lleva a ninguna parte. */}
      {lectura.sePuedePagar && !enlace.checkoutUrl ? (
        <p className="nota">
          La pasarela no nos ha dado la página de pago. Escríbenos y lo
          resolvemos por otro medio.
        </p>
      ) : null}

      <Link href="/">
        <button type="button" className="secundario">
          Volver a la carta
        </button>
      </Link>
    </>
  );
}
