import { createHmac } from 'node:crypto';
import {
  ConnectorParseError,
  type ChannelConnector,
  type NormalizedOrder,
  type NormalizedOrderLine,
  type WebhookHeaders,
  type WebhookIdentity,
} from '../../domain/channel-connector.js';
import { safeEqual } from '../credential-cipher.js';

/**
 * Conector del SIMULADOR de marketplace (spec 13, entregable bloqueante de F4).
 *
 * Existe para poder certificar el orquestador antes de tener acceso a Rappi o
 * PedidosYa. Imita lo que de verdad rompe una integración real —firma HMAC,
 * reintentos con el mismo pedido, SKUs que no existen, payloads truncados— y
 * lo hace de forma reproducible, que es la parte que un sandbox ajeno no da.
 *
 * Implementa la MISMA interfaz que implementarán los conectores reales en F7:
 * si el orquestador pasa contra el simulador, cambiar de conector no toca la
 * ingesta.
 */

export const SIMULATOR_PROVIDER = 'simulator';
export const SIGNATURE_HEADER = 'x-sahana-signature';
export const DELIVERY_HEADER = 'x-sahana-delivery-id';

/** Payload del simulador. Deliberadamente distinto de nuestro modelo interno. */
export interface SimulatorPayload {
  event: string;
  order_id: string;
  placed_at?: string;
  scheduled_for?: string | null;
  customer?: { name?: string; phone?: string };
  dropoff?: { address?: string; latitude?: number; longitude?: number } | null;
  items?: Array<{
    sku?: string;
    qty?: number;
    options?: string[];
    comment?: string;
  }>;
  tip_cents?: number;
  total_cents?: number;
  comment?: string;
}

/** Firma que el simulador (y cualquier proveedor serio) pone en la cabecera. */
export function signSimulatorPayload(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function asRecord(payload: unknown): SimulatorPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new ConnectorParseError('El payload no es un objeto.');
  }
  return payload as SimulatorPayload;
}

export class SimulatorConnector implements ChannelConnector {
  readonly provider = SIMULATOR_PROVIDER;

  /**
   * HMAC-SHA256 sobre el cuerpo CRUDO. Se compara en tiempo constante: una
   * comparación normal filtra, byte a byte, cuánto acertó el atacante.
   */
  verifyWebhook(
    rawBody: string,
    headers: WebhookHeaders,
    secret: string,
  ): boolean {
    const recibida = headers[SIGNATURE_HEADER];
    if (!recibida) return false;
    return safeEqual(recibida, signSimulatorPayload(rawBody, secret));
  }

  /**
   * Identifica el envío sin necesidad de que el pedido sea válido. Es lo que
   * permite aterrizar un payload roto y aun así deduplicar sus reintentos.
   */
  identify(payload: unknown, headers: WebhookHeaders): WebhookIdentity {
    const cuerpo =
      typeof payload === 'object' && payload !== null
        ? (payload as SimulatorPayload)
        : ({} as SimulatorPayload);
    const externalRef =
      typeof cuerpo.order_id === 'string' && cuerpo.order_id.length > 0
        ? cuerpo.order_id
        : undefined;
    return {
      // Si el proveedor no manda id de entrega, se cae a la referencia del
      // pedido: peor dedupe, pero nunca «sin identificar».
      deliveryId:
        headers[DELIVERY_HEADER] ?? externalRef ?? `sin-id-${Date.now()}`,
      eventType:
        typeof cuerpo.event === 'string' ? cuerpo.event : 'order.created',
      externalRef,
    };
  }

  parseOrder(payload: unknown): NormalizedOrder {
    const cuerpo = asRecord(payload);

    if (typeof cuerpo.order_id !== 'string' || cuerpo.order_id.length === 0) {
      throw new ConnectorParseError(
        'El payload no trae order_id: sin referencia externa no hay dedupe posible.',
        'order_id',
      );
    }
    if (!Array.isArray(cuerpo.items) || cuerpo.items.length === 0) {
      throw new ConnectorParseError(
        'El pedido no trae líneas.',
        'items',
      );
    }

    const lines: NormalizedOrderLine[] = cuerpo.items.map((item, i) => {
      if (typeof item?.sku !== 'string' || item.sku.length === 0) {
        throw new ConnectorParseError(
          `La línea ${i} no trae SKU.`,
          `items[${i}].sku`,
        );
      }
      const qty = item.qty ?? 1;
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new ConnectorParseError(
          `La línea ${i} trae una cantidad inválida (${String(qty)}).`,
          `items[${i}].qty`,
        );
      }
      return {
        externalSku: item.sku,
        quantity: qty,
        modifierSkus: Array.isArray(item.options)
          ? item.options.filter((o): o is string => typeof o === 'string')
          : [],
        notes: item.comment,
      };
    });

    const dropoff = cuerpo.dropoff;
    const delivery =
      dropoff &&
      typeof dropoff.latitude === 'number' &&
      typeof dropoff.longitude === 'number'
        ? {
            address: dropoff.address ?? 'Sin dirección',
            lat: dropoff.latitude,
            lng: dropoff.longitude,
          }
        : undefined;

    const scheduledAt =
      typeof cuerpo.scheduled_for === 'string'
        ? new Date(cuerpo.scheduled_for)
        : undefined;
    if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
      throw new ConnectorParseError(
        'scheduled_for no es una fecha válida.',
        'scheduled_for',
      );
    }

    return {
      externalRef: cuerpo.order_id,
      lines,
      customerName: cuerpo.customer?.name,
      customerPhone: cuerpo.customer?.phone,
      delivery,
      // El simulador habla en céntimos (2 decimales); Money trabaja a escala 4.
      tipMinor:
        typeof cuerpo.tip_cents === 'number'
          ? cuerpo.tip_cents * 100
          : undefined,
      channelTotalMinor:
        typeof cuerpo.total_cents === 'number'
          ? cuerpo.total_cents * 100
          : undefined,
      scheduledAt,
      notes: cuerpo.comment,
    };
  }

  // --- Salida. En el simulador solo se registra; en F7 son llamadas HTTP. ---

  readonly outbound: Array<{ op: string; data: unknown }> = [];

  async pushMenu(catalogVersion: string, menu: unknown): Promise<void> {
    this.outbound.push({ op: 'pushMenu', data: { catalogVersion, menu } });
  }

  async setAvailability(
    items: Array<{ externalSku: string; available: boolean }>,
  ): Promise<void> {
    this.outbound.push({ op: 'setAvailability', data: items });
  }

  async updateOrderStatus(externalRef: string, status: string): Promise<void> {
    this.outbound.push({
      op: 'updateOrderStatus',
      data: { externalRef, status },
    });
  }

  async cancelAck(externalRef: string): Promise<void> {
    this.outbound.push({ op: 'cancelAck', data: { externalRef } });
  }
}
