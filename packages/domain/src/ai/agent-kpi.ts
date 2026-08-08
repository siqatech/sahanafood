/**
 * KPI del agente: mensajes por pedido (spec 19 §7, T5.32).
 *
 * El criterio del backlog es **mensajes/pedido ≤ 8, MEDIDO**. La palabra que
 * importa es «medido»: un objetivo que solo está escrito en la spec no cambia
 * nada, y este en concreto es el que separa un agente que vende de uno que da
 * conversación. Ocho mensajes es aproximadamente saludo, qué quiere,
 * aclaración, precio, dirección, confirmación — más que eso y el cliente
 * abandona antes de llegar al pago.
 *
 * Pura y sin I/O: la consulta reúne los números, esta función decide. Separarlo
 * permite discutir el umbral sin tocar SQL, y probar el borde exacto (8 pasa,
 * 8,01 no) sin base de datos.
 */

/** Objetivo de la fase. Se supera hacia ABAJO. */
export const MESSAGES_PER_ORDER_TARGET = 8;

export interface MessagesPerOrderInput {
  /** Mensajes de conversaciones que acabaron en al menos un pedido. */
  messages: number;
  /** Pedidos salidos de esas conversaciones. */
  orders: number;
}

export interface MessagesPerOrderResult {
  messages: number;
  orders: number;
  /** Mensajes por pedido, o `null` si todavía no hay ningún pedido. */
  value: number | null;
  target: number;
  /**
   * `null` cuando no hay pedidos: sin ninguno, el KPI no se cumple ni se
   * incumple. Devolver `true` ahí —que es lo que sale de un `<=` sobre cero—
   * pintaría el panel en verde el día que el agente no vendió nada, que es
   * justo el día en el que hay que mirarlo.
   */
  meetsTarget: boolean | null;
}

export function messagesPerOrder(
  input: MessagesPerOrderInput,
  target: number = MESSAGES_PER_ORDER_TARGET,
): MessagesPerOrderResult {
  if (input.orders <= 0) {
    return {
      messages: input.messages,
      orders: 0,
      value: null,
      target,
      meetsTarget: null,
    };
  }

  // Se redondea a dos decimales para el panel, pero la comparación usa el valor
  // exacto: redondear antes haría que 8,004 se mostrara como 8,00 y se diera
  // por cumplido un objetivo que no lo está.
  const exacto = input.messages / input.orders;
  return {
    messages: input.messages,
    orders: input.orders,
    value: Math.round(exacto * 100) / 100,
    target,
    meetsTarget: exacto <= target,
  };
}

export interface ConversionInput {
  conversations: number;
  converted: number;
}

/**
 * Tasa de conversión a pedido, en puntos básicos.
 *
 * En bps y no en coma flotante por la misma razón que las comisiones: es un
 * porcentaje que se compara, se ordena y se guarda, y un `0.1 + 0.2` en medio
 * de una comparación es un bug que aparece un martes cualquiera.
 */
export function conversionBps(input: ConversionInput): number {
  if (input.conversations <= 0) return 0;
  return Math.round((input.converted / input.conversations) * 10_000);
}
