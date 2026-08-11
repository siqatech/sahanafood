'use client';

import { useEffect, useState } from 'react';

/**
 * La oferta de bienvenida, una sola vez.
 *
 * Es la pieza que convierte una tienda en una tienda que capta: quien llega por
 * primera vez no conoce ningún código, así que un descuento de primera compra
 * que hay que teclear de memoria no lo usa nadie. Aquí se anuncia solo.
 *
 * Decisiones que la hacen soportable en vez de molesta:
 *
 *  · **Aparece una vez y no vuelve.** La marca va en `localStorage` con la
 *    clave de la marca, así que cerrar la ventana la cierra de verdad. Un
 *    anuncio que reaparece en cada visita es el motivo por el que la gente
 *    aprende a cerrar sin leer.
 *  · **Espera un momento antes de salir.** Saltar encima de alguien que aún no
 *    ha visto la carta es pedirle que decida sin información; unos segundos
 *    después ya sabe qué vende el local.
 *  · **No bloquea nada.** Se cierra con la X, con `Escape` y tocando fuera, y
 *    la página de debajo funciona igual si no llega a cargar el JavaScript —el
 *    cupón se puede escribir en el carrito, que es donde vive el campo de
 *    siempre.
 *  · **El texto lo redacta el servidor.** Aquí no se calcula ningún descuento:
 *    un porcentaje compuesto en el navegador es un escaparate que promete lo
 *    que la caja no cumple.
 */
export function Bienvenida({
  marca,
  codigo,
  texto,
}: {
  marca: string;
  codigo: string;
  texto: string;
}) {
  const [visible, setVisible] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const clave = `sahana:bienvenida:${marca}`;

  useEffect(() => {
    // `localStorage` puede fallar en navegación privada de algunos navegadores;
    // que reviente el anuncio no puede tumbar la carta.
    try {
      if (window.localStorage.getItem(clave)) return;
    } catch {
      return;
    }
    const t = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(t);
  }, [clave]);

  useEffect(() => {
    if (!visible) return;
    const alPulsar = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cerrar();
    };
    document.addEventListener('keydown', alPulsar);
    return () => document.removeEventListener('keydown', alPulsar);
  });

  function cerrar(): void {
    try {
      window.localStorage.setItem(clave, '1');
    } catch {
      // Sin almacenamiento vuelve a salir en la siguiente visita. Es el mal
      // menor: la alternativa es no enseñarla nunca.
    }
    setVisible(false);
  }

  async function copiar(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codigo);
      setCopiado(true);
    } catch {
      // Sin permiso de portapapeles el código sigue a la vista para teclearlo.
      setCopiado(false);
    }
  }

  if (!visible) return null;

  return (
    <div
      className="bienvenida"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bienvenida-titulo"
      onClick={cerrar}
    >
      <div className="bienvenida__caja" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="bienvenida__cerrar"
          onClick={cerrar}
          aria-label="Cerrar"
        >
          ×
        </button>

        <p className="bienvenida__gancho">Porque es tu primera vez aquí</p>
        <h2 id="bienvenida-titulo" className="bienvenida__titulo">
          {texto}
        </h2>
        <p className="bienvenida__instruccion">
          Usa este código al terminar tu pedido:
        </p>

        <button type="button" className="bienvenida__codigo" onClick={copiar}>
          <span>{codigo}</span>
          <span className="bienvenida__copiar">
            {copiado ? '¡Copiado!' : 'Copiar'}
          </span>
        </button>

        <button
          type="button"
          className="boton-principal"
          onClick={cerrar}
          autoFocus
        >
          Ver la carta
        </button>
      </div>
    </div>
  );
}
