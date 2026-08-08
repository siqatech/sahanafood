/**
 * Puerto hacia la pasarela de pago (spec 10, ADR-0016).
 *
 * Mismo criterio que el puerto del OSE (ADR-0003): la interfaz es
 * deliberadamente estrecha porque es un ANTI-CORRUPTION LAYER. Culqi, Izipay,
 * Niubiz y MercadoPago tienen cada uno su forma de nombrar los estados, su
 * cabecera de firma y su idea de qué es un «evento»; nada de eso puede filtrarse
 * hacia dentro. DP-03 —qué pasarelas se contratan— sigue abierto, y el día que
 * se cierre el cambio tiene que ser un `useClass`.
 *
 * Hay una asimetría importante respecto al puerto del OSE, y es intencionada:
 * **aquí el proveedor no confirma nada.** `createCharge` solo pide a la pasarela
 * que prepare el cobro y devuelve a dónde mandar al cliente. Quien confirma es
 * el webhook, verificado, y por eso `parseWebhook` es el método que de verdad
 * importa (RN-PAY-01).
 */

/** Lo que se le pide cobrar a la pasarela. Ya calculado: aquí no se hacen cuentas. */
export interface ChargeRequest {
  /** Referencia opaca que viaja y vuelve. NUNCA el id interno de la intención. */
  reference: string;
  /** Importe como cadena decimal: no pasa por coma flotante en ningún punto. */
  amount: string;
  currency: string;
  description: string;
  customer?:
    { name?: string | undefined; email?: string | undefined } | undefined;
  /** A dónde vuelve el navegador. NO confirma nada; solo es cortesía visual. */
  returnUrl?: string | undefined;
  expiresAt: Date;
}

export interface ChargeCreated {
  /** Identificador del cargo EN la pasarela. */
  providerRef: string;
  /** A dónde mandar al cliente para que pague. */
  checkoutUrl: string;
}

/**
 * Estado normalizado que trae un aviso. Las pasarelas usan sus propias
 * palabras (`paid`, `approved`, `succeeded`, `done`…); traducirlas es trabajo
 * del adaptador, no del servicio.
 */
export type ProviderPaymentStatus =
  'authorized' | 'captured' | 'failed' | 'refunded';

/** Aviso de la pasarela, ya normalizado. */
export interface WebhookEvent {
  /**
   * Identificador del EVENTO en la pasarela, para deduplicar.
   *
   * Si el proveedor no manda uno propio, el adaptador deriva uno estable del
   * contenido (`provider:reference:status`): lo que se quiere deduplicar es el
   * mismo HECHO, no el mismo paquete de red.
   */
  eventId: string;
  /** La referencia opaca que se mandó en `createCharge`. */
  reference: string;
  status: ProviderPaymentStatus;
  /** Importe que la pasarela dice haber movido, como cadena decimal. */
  amount: string;
  currency: string;
  providerRef?: string | undefined;
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookParseError';
  }
}

export interface RefundResult {
  providerRef: string;
  /** Importe efectivamente devuelto, como cadena decimal. */
  amount: string;
}

export interface PaymentProvider {
  readonly name: string;

  /** Prepara el cobro. NO cobra ni confirma: devuelve a dónde mandar al cliente. */
  createCharge(request: ChargeRequest): Promise<ChargeCreated>;

  /**
   * Verifica la firma del aviso sobre el cuerpo CRUDO.
   *
   * Sobre el crudo y no sobre el objeto reserializado: cualquier diferencia de
   * orden de claves o de espaciado produce otro HMAC, y entonces se estaría
   * verificando una firma de algo que la pasarela nunca mandó.
   *
   * Se compara en tiempo constante. Una comparación normal filtra, byte a byte,
   * cuánto acertó quien lo intenta.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean;

  /** Traduce el aviso al vocabulario del sistema. Lanza si no se entiende. */
  parseWebhook(rawBody: string): WebhookEvent;

  /**
   * Devuelve el dinero.
   *
   * Existe en el puerto desde el principio, aunque la API de reembolsos llegue
   * en T5.06, porque hay un caso que NO se puede posponer: un pago que se
   * confirma después de que el pedido haya vencido hay que devolverlo
   * automáticamente (T5.04). Sin esto, el sistema cobraría por comida que
   * decidió no hacer.
   */
  refund(providerRef: string, amount: string): Promise<RefundResult>;
}
