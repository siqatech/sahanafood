/**
 * Anti-corruption layer entre los marketplaces y el dominio (spec 13).
 *
 * Cada proveedor tiene su propio formato, su propia forma de firmar y su propia
 * idea de qué es un pedido. `ChannelConnector` es la frontera: dentro de esta
 * interfaz vive todo lo que es específico de Rappi o PedidosYa; fuera, el resto
 * del sistema solo conoce `NormalizedOrder`.
 *
 * El simulador de la F4 implementa ESTA MISMA interfaz que implementarán los
 * conectores reales en F7. Esa es la razón de que exista el simulador: si el
 * orquestador solo sabe hablar con la interfaz, certificar contra Rappi es
 * escribir un conector, no rehacer la ingesta.
 */

/** Línea de pedido tal como la manda el canal: SKUs externos, sin resolver. */
export interface NormalizedOrderLine {
  externalSku: string;
  quantity: number;
  /** SKUs externos de los modificadores elegidos. */
  modifierSkus: string[];
  notes?: string | undefined;
}

/**
 * Pedido normalizado. Sigue hablando en SKUs EXTERNOS a propósito: traducir a
 * ids internos exige leer el mapeo del tenant, y eso ya es trabajo del worker,
 * no del parser. Separarlo permite que un fallo de mapeo sea un estado del
 * pedido (needs_review) y no una excepción del parseo.
 */
export interface NormalizedOrder {
  /** Identificador del pedido en el canal. Base del dedupe (RN-ORD-03). */
  externalRef: string;
  lines: NormalizedOrderLine[];
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  delivery?:
    | {
        address: string;
        lat: number;
        lng: number;
      }
    | undefined;
  tipMinor?: number | undefined;
  scheduledAt?: Date | undefined;
  notes?: string | undefined;
  /** Total que dice el canal, para contrastar con el nuestro (RN-T09). */
  channelTotalMinor?: number | undefined;
}

/** Cabeceras del webhook, normalizadas a minúsculas. */
export type WebhookHeaders = Record<string, string | undefined>;

export interface WebhookIdentity {
  /** Identificador del INTENTO de entrega; dos reintentos traen ids distintos. */
  deliveryId: string;
  eventType: string;
  externalRef: string | undefined;
}

/**
 * Error de parseo. Lo lanza `parseOrder` cuando el payload no es interpretable.
 * NO significa «descartar»: el llamador lo convierte en `needs_review`
 * (RN-INT-02) porque un payload roto sigue siendo un cliente esperando comida.
 */
export class ConnectorParseError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ConnectorParseError';
  }
}

export interface ChannelConnector {
  readonly provider: string;

  /**
   * Verifica la firma del webhook contra el cuerpo CRUDO. Recibe el string sin
   * parsear porque cualquier round-trip por `JSON.parse`/`stringify` cambia
   * bytes (orden de claves, espacios) y rompería un HMAC válido.
   */
  verifyWebhook(
    rawBody: string,
    headers: WebhookHeaders,
    secret: string,
  ): boolean;

  /** Extrae los identificadores sin necesidad de entender el pedido entero. */
  identify(payload: unknown, headers: WebhookHeaders): WebhookIdentity;

  /** Traduce el payload del proveedor a nuestro contrato. */
  parseOrder(payload: unknown): NormalizedOrder;

  /** Publica el menú vigente en el canal (salida). */
  pushMenu(catalogVersion: string, menu: unknown): Promise<void>;

  /** Propaga disponibilidad de items (RN-INT-05). */
  setAvailability(
    items: Array<{ externalSku: string; available: boolean }>,
  ): Promise<void>;

  /** Informa al canal del nuevo estado del pedido. */
  updateOrderStatus(externalRef: string, status: string): Promise<void>;

  /** Confirma al canal que se procesó su cancelación. */
  cancelAck(externalRef: string): Promise<void>;
}
