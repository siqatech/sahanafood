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
 * Pasarela SANDBOX estilo MercadoPago (spec 10, ADR-0016).
 *
 * La segunda implementación del puerto, y se eligió parecerse lo MENOS posible
 * a la primera dentro de lo verosímil. Dos sandbox gemelos habrían demostrado
 * solo que el código compila dos veces:
 *
 * | | Culqi sandbox | MercadoPago sandbox |
 * |---|---|---|
 * | Firma | `x-culqi-signature`, hex pelado | `x-signature`, formato `ts=…,v1=…` |
 * | Qué se firma | el cuerpo crudo | `ts` + cuerpo crudo, concatenados |
 * | Estados | `paid`, `authorized`, `failed` | `approved`, `in_process`, `rejected` |
 * | Id de evento | propio (`id`) | **NO manda** — hay que derivarlo |
 * | Importe | céntimos enteros | decimal en cadena |
 *
 * Esa última fila es la que más valor tiene. Una pasarela sin identificador de
 * evento obliga a que la deduplicación no dependa del proveedor, y es lo que
 * fuerza la regla de ADR-0016 §3: lo que se deduplica es el **hecho**
 * (`proveedor:referencia:estado`), no el paquete.
 */

export const MERCADOPAGO_PROVIDER = 'mercadopago_sandbox';
const CABECERA_FIRMA = 'x-signature';

/** Vocabulario de MercadoPago → el nuestro. */
const ESTADOS: Record<string, ProviderPaymentStatus> = {
  approved: 'captured',
  in_process: 'authorized',
  authorized: 'authorized',
  rejected: 'failed',
  cancelled: 'failed',
  refunded: 'refunded',
  charged_back: 'refunded',
};

interface MercadoPagoPayload {
  action?: string;
  data?: {
    external_reference?: string;
    status?: string;
    transaction_amount?: string | number;
    currency_id?: string;
    payment_id?: string;
  };
}

@Injectable()
export class MercadoPagoSandboxProvider implements PaymentProvider {
  readonly name = MERCADOPAGO_PROVIDER;

  readonly outbound: Array<{ op: string; data: unknown }> = [];

  async createCharge(request: ChargeRequest): Promise<ChargeCreated> {
    const providerRef = randomUUID();
    this.outbound.push({ op: 'createCharge', data: request });
    return {
      providerRef,
      checkoutUrl: `https://sandbox.mercadopago.test/checkout/v1/redirect?pref_id=${providerRef}`,
    };
  }

  /**
   * Firma con marca de tiempo, formato `ts=<epoch>,v1=<hmac>`.
   *
   * El `ts` entra en el HMAC a propósito: es lo que impide reproducir un aviso
   * antiguo tal cual. No se valida aquí la antigüedad —eso es política del
   * servicio, no del adaptador— pero el formato la deja posible.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean {
    const cabecera = headers[CABECERA_FIRMA];
    if (!cabecera) return false;

    const partes = new Map<string, string>();
    for (const trozo of cabecera.split(',')) {
      const [clave, valor] = trozo.split('=');
      if (clave && valor) partes.set(clave.trim(), valor.trim());
    }

    const ts = partes.get('ts');
    const v1 = partes.get('v1');
    if (!ts || !v1) return false;

    return safeEqual(v1, this.sign(rawBody, secret, ts));
  }

  /** Expuesto para las pruebas: firmar aquí evita duplicar el formato allí. */
  sign(rawBody: string, secret: string, ts: string): string {
    return createHmac('sha256', secret)
      .update(`${ts}.${rawBody}`, 'utf8')
      .digest('hex');
  }

  /** Cabecera completa, tal como la mandaría la pasarela. */
  signatureHeader(rawBody: string, secret: string, ts: string): string {
    return `ts=${ts},v1=${this.sign(rawBody, secret, ts)}`;
  }

  parseWebhook(rawBody: string): WebhookEvent {
    let cuerpo: MercadoPagoPayload;
    try {
      cuerpo = JSON.parse(rawBody) as MercadoPagoPayload;
    } catch {
      throw new WebhookParseError('El aviso no es JSON válido.');
    }

    const datos = cuerpo.data ?? {};
    if (
      typeof datos.external_reference !== 'string' ||
      !datos.external_reference
    ) {
      throw new WebhookParseError(
        'El aviso no trae `external_reference`: sin referencia no se sabe qué pago es.',
      );
    }
    const estado = ESTADOS[String(datos.status)];
    if (!estado) {
      throw new WebhookParseError(
        `Estado desconocido en el aviso: "${String(datos.status)}".`,
      );
    }
    const importe = datos.transaction_amount;
    if (typeof importe !== 'string' && typeof importe !== 'number') {
      throw new WebhookParseError('El aviso no trae importe.');
    }

    return {
      // MercadoPago NO manda identificador de evento: se deriva del hecho.
      // Dos avisos del mismo cambio de estado sobre el mismo pago SON el mismo
      // hecho, aunque lleguen en paquetes distintos.
      eventId: `${MERCADOPAGO_PROVIDER}:${datos.external_reference}:${estado}`,
      reference: datos.external_reference,
      status: estado,
      amount: String(importe),
      currency: datos.currency_id ?? 'PEN',
      providerRef: datos.payment_id,
    };
  }

  async refund(providerRef: string, amount: string): Promise<RefundResult> {
    this.outbound.push({ op: 'refund', data: { providerRef, amount } });
    return { providerRef: randomUUID(), amount };
  }
}
