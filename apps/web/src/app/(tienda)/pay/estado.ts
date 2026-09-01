/**
 * Cómo se le cuenta a un comprador el estado de su enlace de pago.
 *
 * El módulo de pagos emitía enlaces con la URL `/pay/{token}` desde T5.05 —con
 * su token público de ADR-0017, su caducidad y su registro en auditoría— y esa
 * página **no existía**. Es el mismo agujero que tuvo el seguimiento antes de
 * T5.16, y de peores consecuencias: al cliente se le mandaba una URL rota para
 * que pagase.
 *
 * Este módulo es puro para poder probar el texto exacto. Aquí no se decide nada
 * del cobro —eso lo dice el servidor— solo cómo se lee.
 */

export interface LecturaDelPago {
  titulo: string;
  detalle: string;
  /** Si tiene sentido ofrecer el botón de pagar. */
  sePuedePagar: boolean;
}

/** Los estados son los de `PAYMENT_STATES` en `@sahana/domain`. */
const LECTURAS: Record<string, LecturaDelPago> = {
  pending: {
    titulo: 'Tu pedido está listo para pagar',
    detalle: 'Te llevamos a la pasarela para completarlo.',
    sePuedePagar: true,
  },
  authorized: {
    titulo: 'Estamos confirmando tu pago',
    // Autorizado no es cobrado, pero el dinero ya está retenido: ofrecer
    // «pagar» aquí es cómo un cliente paga dos veces.
    detalle:
      'Tu banco ya retuvo el importe y lo estamos confirmando. No vuelvas a pagar: si en unos minutos no te llega la confirmación, escríbenos.',
    sePuedePagar: false,
  },
  captured: {
    titulo: 'Este pedido ya está pagado',
    detalle: 'No hace falta que hagas nada más. Gracias.',
    sePuedePagar: false,
  },
  failed: {
    titulo: 'El pago no se completó',
    detalle:
      'Puedes intentarlo otra vez. Si vuelve a fallar, escríbenos y lo resolvemos por otro medio.',
    sePuedePagar: true,
  },
  expired: {
    titulo: 'Este enlace de pago caducó',
    detalle: 'Escríbenos y te mandamos uno nuevo en un momento.',
    sePuedePagar: false,
  },
  refunded: {
    titulo: 'Este pago se devolvió',
    detalle: 'El importe vuelve a tu medio de pago. No pagues por aquí.',
    sePuedePagar: false,
  },
};

export function leerPago(estado: string): LecturaDelPago {
  return (
    LECTURAS[estado] ?? {
      titulo: 'No podemos cobrar por aquí ahora mismo',
      detalle: 'Escríbenos y lo resolvemos contigo.',
      // Un estado que esta página no conoce NO se ofrece como pagable. Pagar
      // dos veces es el peor error posible de esta pantalla, y ante la duda se
      // manda a hablar con una persona.
      sePuedePagar: false,
    }
  );
}

/**
 * Cuándo caduca, dicho como lo diría alguien.
 *
 * Se dice la HORA y no «en 27 minutos»: la página se sirve desde el servidor y
 * una cuenta atrás renderizada allí se queda congelada en la pantalla del
 * cliente, enseñando un tiempo restante que dejó de ser cierto al segundo
 * siguiente.
 */
export function horaDeCaducidad(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
