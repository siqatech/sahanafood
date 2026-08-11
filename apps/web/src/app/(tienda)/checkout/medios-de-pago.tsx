'use client';

import { useEffect, useState } from 'react';

/**
 * Cómo quiere pagar el comprador.
 *
 * Lo que decide qué se ve aquí es el NEGOCIO, no la tienda: `methods` viene del
 * servidor y sale de la pasarela que el dueño conectó. Sin conexión activa este
 * bloque no aparece — se paga al recibir y ya está, que es como paga la mayoría
 * en Perú.
 *
 * Las carteras (Apple Pay, Google Pay) tienen una regla de más, y es la razón
 * de que este componente sea de cliente: **hay que preguntárselo al navegador**.
 * Un iPhone no enseña Google Pay y un Android no enseña Apple Pay; anunciar la
 * que no toca es prometer un botón que el comprador no va a encontrar en la
 * pasarela.
 */

/** Los nombres que ve el comprador. La API manda identificadores. */
const NOMBRES: Record<string, string> = {
  card: 'Tarjeta',
  yape: 'Yape',
  plin: 'Plin',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
};

/**
 * ¿Puede este navegador enseñar esta cartera?
 *
 * Es una comprobación NECESARIA, no suficiente: dice que el navegador tiene la
 * API, no que el negocio tenga la cuenta ni que la tarjeta del comprador entre.
 * La palabra final la tiene la pasarela en su página. Lo que evita es el caso
 * seguro y frecuente —Apple Pay anunciado en Chrome de Android— que hoy
 * ocurriría el 100 % de las veces.
 */
function carteraDisponible(metodo: string): boolean {
  if (typeof window === 'undefined') return false;
  if (metodo === 'apple_pay') {
    const sesion = (
      window as { ApplePaySession?: { canMakePayments(): boolean } }
    ).ApplePaySession;
    // `canMakePayments` es síncrona y no toca la red: mira si el dispositivo
    // tiene la cartera configurada.
    try {
      return sesion?.canMakePayments() === true;
    } catch {
      return false;
    }
  }
  if (metodo === 'google_pay') {
    // Sin cargar el SDK de Google, `PaymentRequest` es la señal honesta que hay:
    // el navegador soporta pagos web. Cargar su script solo para preguntar
    // metería un tercero en la página de checkout de todos nuestros clientes.
    return 'PaymentRequest' in window;
  }
  return true;
}

export function MediosDePago({
  metodos,
  contraEntrega,
}: {
  metodos: string[];
  contraEntrega: boolean;
}) {
  /**
   * Se empieza SIN carteras y se añaden tras montar.
   *
   * En el servidor no hay navegador al que preguntar. Si se pintara la lista
   * completa y luego se quitara, React avisaría de discrepancia de hidratación
   * y —peor— el comprador vería aparecer y desaparecer un medio de pago.
   */
  const [enNavegador, setEnNavegador] = useState(false);
  useEffect(() => setEnNavegador(true), []);

  const visibles = metodos.filter(
    (m) =>
      NOMBRES[m] !== undefined &&
      (enNavegador
        ? carteraDisponible(m)
        : m !== 'apple_pay' && m !== 'google_pay'),
  );

  // Sin pasarela conectada no hay nada que elegir. Se dice, en vez de callarlo:
  // saber cómo se paga antes de dar el teléfono es parte de decidir si se pide.
  if (visibles.length === 0) {
    return (
      <div className="medios">
        <h2>¿Cómo pagas?</h2>
        <p className="nota">
          Pagas al recibir tu pedido, en efectivo o con el datáfono del
          repartidor.
        </p>
        <input type="hidden" name="payment" value="on_delivery" />
      </div>
    );
  }

  return (
    <fieldset className="medios">
      <legend>
        <h2>¿Cómo prefieres pagar?</h2>
      </legend>

      <label className="medio">
        <input
          type="radio"
          name="payment"
          value="online"
          defaultChecked={!contraEntrega}
        />
        <span className="medio__texto">
          <strong>Pagar ahora</strong>
          <span className="nota">
            Te llevamos a la página segura de la pasarela. Aceptan{' '}
            {visibles.map((m) => NOMBRES[m]).join(', ')}.
          </span>
        </span>
      </label>

      {contraEntrega ? (
        <label className="medio">
          <input
            type="radio"
            name="payment"
            value="on_delivery"
            defaultChecked
          />
          <span className="medio__texto">
            <strong>Pagar al recibir</strong>
            <span className="nota">
              En efectivo o con el datáfono del repartidor.
            </span>
          </span>
        </label>
      ) : null}
    </fieldset>
  );
}
