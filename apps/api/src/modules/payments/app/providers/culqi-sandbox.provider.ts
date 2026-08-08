import { createHmac, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { safeEqual } from '../../../integrations/index.js';
import {
  WebhookParseError,
  type ChargeCreated,
  type ChargeRequest,
  type PaymentProvider,
  type ProviderPaymentStatus,
  type RefundResult,
  type WebhookEvent,
} from '../../domain/payment-provider.js';

/**
 * Pasarela SANDBOX estilo Culqi (spec 10, ADR-0016).
 *
 * Imita la forma de una pasarela peruana real —firma HMAC hexadecimal en una
 * cabecera propia, identificador de evento propio, vocabulario de estados
 * propio— sin llamar a nadie. DP-03 (qué pasarelas se contratan) sigue abierto,
 * y CLAUDE.md prohíbe integrar servicios reales en el MVP.
 *
 * Existe junto con `MercadoPagoSandboxProvider` por un motivo concreto: **dos
 * implementaciones que se parecen no prueban que el puerto sea un
 * anti-corruption layer.** Estas dos difieren en las tres cosas que de verdad
 * cambian entre pasarelas: dónde va la firma y con qué formato, cómo se llaman
 * los estados, y si el proveedor manda o no un identificador de evento. Si el
 * servicio funciona con las dos sin enterarse, el puerto sirve.
 */

export const CULQI_PROVIDER = 'culqi_sandbox';
const CABECERA_FIRMA = 'x-culqi-signature';

/** Vocabulario de Culqi → el nuestro. */
const ESTADOS: Record<string, ProviderPaymentStatus> = {
  paid: 'captured',
  authorized: 'authorized',
  failed: 'failed',
  expired: 'failed',
  refunded: 'refunded',
};

/**
 * Payload TAL COMO LLEGA de Culqi. No es nuestro modelo: es el formato de
 * cable, y el trabajo del adaptador es precisamente traducirlo.
 */
interface CulqiPayload {
  id?: string;
  object?: string;
  outcome?: string;
  order_number?: string;
  /**
   * Céntimos enteros, que es lo que manda Culqi.
   *
   * La regla anti-`number` monetario está activa por una buena razón (ADR-0006)
   * y aquí se desactiva a conciencia: este campo NO es un importe del sistema,
   * es un byte que vino por la red y que no ha pasado todavía por ningún
   * cálculo. `parseWebhook` lo convierte a cadena decimal en la línea siguiente
   * y a partir de ahí ya es `Money`. Tipar el formato de cable como `Money`
   * sería mentir sobre lo que de verdad llegó.
   */
  // eslint-disable-next-line no-restricted-syntax
  amount?: number;
  currency_code?: string;
  charge_id?: string;
}

@Injectable()
export class CulqiSandboxProvider implements PaymentProvider {
  readonly name = CULQI_PROVIDER;

  /** Cargos creados, para que las pruebas puedan inspeccionar lo enviado. */
  readonly outbound: Array<{ op: string; data: unknown }> = [];

  async createCharge(request: ChargeRequest): Promise<ChargeCreated> {
    const providerRef = `chr_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.outbound.push({ op: 'createCharge', data: request });
    return {
      providerRef,
      // URL del sandbox: el cliente "paga" aquí. No confirma nada — quien
      // confirma es el webhook (RN-PAY-01).
      checkoutUrl: `https://sandbox.culqi.test/checkout/${providerRef}`,
    };
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean {
    const recibida = headers[CABECERA_FIRMA];
    if (!recibida) return false;
    return safeEqual(recibida, this.sign(rawBody, secret));
  }

  /** HMAC-SHA256 hexadecimal sobre el cuerpo crudo. Expuesto para las pruebas. */
  sign(rawBody: string, secret: string): string {
    return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  }

  parseWebhook(rawBody: string): WebhookEvent {
    let cuerpo: CulqiPayload;
    try {
      cuerpo = JSON.parse(rawBody) as CulqiPayload;
    } catch {
      throw new WebhookParseError('El aviso no es JSON válido.');
    }

    if (typeof cuerpo.order_number !== 'string' || !cuerpo.order_number) {
      throw new WebhookParseError(
        'El aviso no trae `order_number`: sin referencia no se sabe qué pago es.',
      );
    }
    const estado = ESTADOS[String(cuerpo.outcome)];
    if (!estado) {
      throw new WebhookParseError(
        `Estado desconocido en el aviso: "${String(cuerpo.outcome)}".`,
      );
    }
    if (typeof cuerpo.amount !== 'number' || !Number.isInteger(cuerpo.amount)) {
      throw new WebhookParseError('El aviso no trae un importe entero válido.');
    }

    return {
      // Culqi SÍ manda identificador de evento propio.
      eventId:
        typeof cuerpo.id === 'string' && cuerpo.id
          ? cuerpo.id
          : `${CULQI_PROVIDER}:${cuerpo.order_number}:${estado}`,
      reference: cuerpo.order_number,
      status: estado,
      // Culqi habla en céntimos (2 decimales); nuestro `Money` es escala 4.
      amount: (cuerpo.amount / 100).toFixed(4),
      currency: cuerpo.currency_code ?? 'PEN',
      providerRef: cuerpo.charge_id,
    };
  }

  async refund(providerRef: string, amount: string): Promise<RefundResult> {
    this.outbound.push({ op: 'refund', data: { providerRef, amount } });
    return {
      providerRef: `ref_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      amount,
    };
  }
}
