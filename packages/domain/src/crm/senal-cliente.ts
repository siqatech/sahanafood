/**
 * ¿Es la primera vez que compra, o es de los de siempre? (docs/25).
 *
 * La spec lo pide como uno de los «detalles que compran al operador»: *«Cliente
 * frecuente» y «primera compra» como badge en el pedido — el operador puede
 * tratar distinto sin buscar nada*. Esa última parte es la que importa: el dato
 * ya estaba en el CRM, pero para verlo había que salir del pedido, abrir
 * Clientes y buscar el teléfono. Nadie lo hace con la cocina llena.
 *
 * Está en el dominio y no en la pantalla porque la misma señal tiene que salir
 * igual en el panel, en el POS y en el KDS. Tres sitios calculando «frecuente»
 * con tres umbrales distintos es cómo el mismo cliente es VIP en una pantalla y
 * anónimo en la de al lado.
 */

/**
 * A partir de cuántos pedidos alguien es «de los de siempre».
 *
 * **La spec no fija el número** (queda anotado como pregunta abierta en
 * docs/22). Cinco es un punto de partida defendible para un negocio de comida:
 * con dos o tres se es un cliente que repitió, con cinco ya es costumbre. Se
 * cambia aquí y en un solo sitio, que es justo el motivo de que sea una
 * constante con nombre y no un `>= 5` suelto dentro de un `if`.
 */
export const PEDIDOS_PARA_FRECUENTE = 5;

export type SenalDeCliente = 'primera' | 'frecuente' | null;

/**
 * @param pedidosDelCliente Cuántos pedidos tiene ese cliente CONTANDO ESTE.
 *   `null` cuando no hay teléfono —mostrador, casi siempre— y entonces no hay
 *   nada que decir: no es que sea nuevo, es que no se sabe quién es.
 */
export function senalDeCliente(
  pedidosDelCliente: number | null | undefined,
): SenalDeCliente {
  if (pedidosDelCliente === null || pedidosDelCliente === undefined) {
    return null;
  }
  // Cero no debería llegar —este pedido ya cuenta— pero si llega, callarse es
  // mejor que anunciar «primera compra» sobre un dato que no cuadra.
  if (pedidosDelCliente <= 0) return null;
  if (pedidosDelCliente === 1) return 'primera';
  if (pedidosDelCliente >= PEDIDOS_PARA_FRECUENTE) return 'frecuente';
  return null;
}

/**
 * El texto del badge. Corto a propósito: va dentro de una tarjeta de pedido,
 * al lado del número y del canal, y ahí no caben frases.
 */
export function rotuloDeSenal(senal: SenalDeCliente): string | null {
  if (senal === 'primera') return 'Primera compra';
  if (senal === 'frecuente') return 'Cliente frecuente';
  return null;
}
