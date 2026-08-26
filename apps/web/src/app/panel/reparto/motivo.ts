/**
 * El motivo de una entrega fallida (RN-DLV-03).
 *
 * Va aparte de la pantalla porque es la única parte con reglas: el servidor
 * exige entre 3 y 280 caracteres, y un `400` genérico devuelto a quien está
 * despachando con la cocina llena no dice qué escribir.
 *
 * El motivo NO es papeleo. Es lo que decide después si el pedido se reintenta
 * o se devuelve, lo que el cliente oye cuando llama, y lo único que permite
 * saber al cabo de un mes si se pierden entregas por direcciones malas o por
 * clientes que no contestan. Un «fallido» sin motivo es un pedido roto sin
 * nada que hacer con él.
 */

/** Lo que de verdad pasa en la calle, para no escribirlo cada vez. */
export const MOTIVOS_FRECUENTES = [
  'El cliente no estaba',
  'No contesta el teléfono',
  'La dirección no existe o está mal',
  'El cliente rechazó el pedido',
  'No tenía con qué pagar',
  'Avería del vehículo',
  'Zona insegura a esta hora',
] as const;

export const MOTIVO_MINIMO = 3;
export const MOTIVO_MAXIMO = 280;

export type MotivoRevisado = { motivo: string } | { error: string };

export function revisarMotivo(texto: unknown): MotivoRevisado {
  const limpio = String(texto ?? '')
    .trim()
    // Un motivo escrito a la carrera trae saltos de línea y dobles espacios;
    // se guarda en una sola línea porque después se lee en una tabla.
    .replace(/\s+/g, ' ');

  if (limpio.length === 0) {
    return { error: 'Escribe qué pasó. Sin motivo no se puede hacer nada.' };
  }
  if (limpio.length < MOTIVO_MINIMO) {
    return { error: 'El motivo es demasiado corto para que sirva de algo.' };
  }
  if (limpio.length > MOTIVO_MAXIMO) {
    return {
      error: `El motivo no puede pasar de ${MOTIVO_MAXIMO} caracteres.`,
    };
  }
  return { motivo: limpio };
}
