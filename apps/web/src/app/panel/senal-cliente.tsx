import { senalDeCliente, rotuloDeSenal } from '@sahana/domain';

/**
 * «Primera compra» / «Cliente frecuente» junto al pedido (docs/25).
 *
 * La regla —a partir de cuántos pedidos alguien es de los de siempre— vive en
 * `@sahana/domain`, no aquí: el POS y el KDS van a enseñar lo mismo, y tres
 * pantallas decidiendo por su cuenta es cómo el mismo cliente sale VIP en una y
 * anónimo en la de al lado.
 *
 * Lleva **texto y no solo color** (docs/25 §6): un punto verde no se lee, y
 * quien no distingue el verde del ámbar se queda sin el dato entero.
 */
export function SenalCliente({ pedidos }: { pedidos: number | null }) {
  const senal = senalDeCliente(pedidos);
  const rotulo = rotuloDeSenal(senal);
  if (!senal || !rotulo) return null;

  return (
    <span className={`etiqueta etiqueta--${senal}`}>
      {rotulo}
      {/* El número solo en «frecuente»: en la primera compra es «1» y decirlo
          sobra. Aquí sí informa —«12 pedidos» no es lo mismo que «5»— y es lo
          que el operador usa para decidir cuánto se esmera. */}
      {senal === 'frecuente' && pedidos !== null ? ` · ${pedidos} pedidos` : ''}
    </span>
  );
}
