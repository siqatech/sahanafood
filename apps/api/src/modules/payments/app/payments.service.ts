import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  decidePaymentTransition,
  verifyPaidAmount,
  amountConfirms,
  type PaymentState,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { CONFIG, type AppConfig } from '../../../config/config.js';
import {
  withTenant,
  withPaymentLookup,
  type TenantContext,
} from '../../../database/rls.js';
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { CredentialCipher } from '../../integrations/index.js';
import { OrderingService } from '../../ordering/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import { currentTraceId } from '../../../observability/tracing.js';
import {
  WebhookParseError,
  type PaymentProvider,
  type WebhookEvent,
} from '../domain/payment-provider.js';
import { PAYMENT_PROVIDERS } from '../payments.tokens.js';

/**
 * Pagos online (spec 10 parte F5, ADR-0016).
 *
 * Este servicio existe para sostener UNA frase, RN-PAY-01: **un pedido online
 * se confirma SOLO con webhook de pago verificado, nunca con el redirect del
 * navegador.** Todo lo demás —intenciones, referencias opacas, deduplicación—
 * es la infraestructura que hace que esa frase se pueda cumplir.
 *
 * Por eso no hay ningún método que confirme un pedido desde el redirect. No es
 * que esté desaconsejado: no existe. El redirect solo sabe llevar al cliente a
 * una página que dice «gracias»; si además confirmara, bastaría con pegar la
 * URL en la barra de direcciones para comer gratis.
 */

/** Campo cifrado donde vive el secreto con el que se verifica la firma. */
export const WEBHOOK_SECRET_FIELD = 'webhook_secret';

export interface PaymentIntentView {
  id: string;
  orderId: string;
  reference: string;
  status: PaymentState;
  amount: string;
  currency: string;
  checkoutUrl: string | null;
  expiresAt: string;
}

/** Lo que el webhook deja claro para el que llama. */
export type WebhookOutcome =
  | { kind: 'applied'; status: PaymentState; intentId: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'mismatch'; reason: string };

export class WebhookSignatureError extends ForbiddenError {
  constructor() {
    // Sin detalle: un mensaje que distinga «token inexistente» de «firma mala»
    // convierte el endpoint en un oráculo para enumerar tokens.
    super('Aviso de pago no verificable.');
  }
}

export class PaymentConnectionError extends NotFoundError {
  constructor() {
    super('Aviso de pago no verificable.');
  }
}

interface ConexionResuelta {
  id: string;
  tenantId: string;
  provider: string;
  status: string;
  webhookSecret: string;
}

interface FilaIntencion {
  id: string;
  tenant_id: string;
  order_id: string;
  connection_id: string;
  reference: string;
  status: PaymentState;
  amount: string;
  currency: string;
  expires_at: Date;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly cipher: CredentialCipher;
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) config: AppConfig,
    @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[],
    private readonly ordering: OrderingService,
  ) {
    this.cipher = new CredentialCipher(config.credentialsMasterKey);
    for (const p of providers) this.providers.set(p.name, p);
  }

  // ------------------------------------------------------------- Conexiones

  async createConnection(
    tenantId: string,
    input: {
      provider: string;
      brandId?: string | undefined;
      webhookSecret: string;
      apiKey?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; webhookToken: string; callbackPath: string }> {
    if (!this.providers.has(input.provider)) {
      throw new ValidationError(
        `Pasarela desconocida: "${input.provider}".`,
        // Se listan las disponibles: el error útil dice qué SÍ se puede poner.
        { available: [...this.providers.keys()] },
      );
    }
    if (input.webhookSecret.length < 16) {
      throw new ValidationError(
        'El secreto del webhook debe tener al menos 16 caracteres.',
      );
    }

    // 32 bytes en base64url: el token va en una URL que se configura en el
    // panel de la pasarela y acaba en logs de proxies. Tiene que no adivinarse.
    const webhookToken = randomBytes(32).toString('base64url');
    const credenciales: Record<string, string> = {
      [WEBHOOK_SECRET_FIELD]: input.webhookSecret,
    };
    if (input.apiKey !== undefined) credenciales['api_key'] = input.apiKey;

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO pay_connections
           (tenant_id, provider, brand_id, webhook_token, credentials)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          tenantId,
          input.provider,
          input.brandId ?? null,
          webhookToken,
          this.cipher.encryptAll(tenantId, credenciales),
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'payment.connection_created',
        resourceType: 'payment_connection',
        resourceId: rows[0]!.id,
        // El secreto NO entra en auditoría: la auditoría se exporta y se lee, y
        // ahí es donde acaban filtrándose las credenciales.
        data: { provider: input.provider },
      });

      return {
        id: rows[0]!.id,
        webhookToken,
        callbackPath: `/api/v1/payments/callbacks/${input.provider}/${webhookToken}`,
      };
    });
  }

  // ------------------------------------------------------------ Intenciones

  /**
   * Crea la intención y pide a la pasarela que prepare el cobro.
   *
   * La intención se escribe ANTES de llamar a la pasarela. Si se hiciera al
   * revés y la llamada saliera bien pero el INSERT fallara, existiría un cobro
   * preparado del que el sistema no sabe nada — y su webhook llegaría sin
   * ninguna intención a la que aplicarse.
   */
  async createIntent(
    tenantId: string,
    input: {
      orderId: string;
      provider: string;
      ttlMinutes?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<PaymentIntentView> {
    const provider = this.providerFor(input.provider);
    const ttl = input.ttlMinutes ?? 30;

    const preparado = await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: pedidos } = await ctx.client.query<{
        id: string;
        status: string;
        total: string;
        currency: string;
        brand_id: string;
      }>(
        'SELECT id, status, total, currency, brand_id FROM ord_orders WHERE id = $1',
        [input.orderId],
      );
      const pedido = pedidos[0];
      // Mensaje sin el id: repetirlo confirmaría la existencia de un pedido de
      // otro tenant a quien lo pregunte.
      if (!pedido) throw new NotFoundError('Pedido no encontrado.');

      const { rows: conexiones } = await ctx.client.query<{ id: string }>(
        `SELECT id FROM pay_connections
          WHERE provider = $1 AND status = 'active'
            AND (brand_id IS NULL OR brand_id = $2)
          ORDER BY brand_id NULLS LAST
          LIMIT 1`,
        [input.provider, pedido.brand_id],
      );
      const conexion = conexiones[0];
      if (!conexion) {
        throw new ValidationError(
          `No hay una conexión activa de "${input.provider}" para esta marca.`,
        );
      }

      // Referencia opaca. NO es el id de la intención: un identificador que se
      // publica acaba en logs de terceros, en la barra del navegador y en
      // capturas de pantalla que la gente manda por WhatsApp.
      const reference = `pi_${randomBytes(18).toString('base64url')}`;
      const expiresAt = new Date(Date.now() + ttl * 60_000);

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO pay_intents
           (tenant_id, connection_id, order_id, reference, amount, currency, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          tenantId,
          conexion.id,
          pedido.id,
          reference,
          pedido.total,
          pedido.currency,
          expiresAt,
        ],
      );

      return {
        intentId: rows[0]!.id,
        reference,
        amount: pedido.total,
        currency: pedido.currency,
        expiresAt,
      };
    });

    const cargo = await provider.createCharge({
      reference: preparado.reference,
      amount: preparado.amount,
      currency: preparado.currency,
      description: `Pedido ${input.orderId}`,
      expiresAt: preparado.expiresAt,
    });

    await withTenant(this.pool, tenantId, async (ctx) => {
      await ctx.client.query(
        'UPDATE pay_intents SET provider_ref = $2, updated_at = now() WHERE id = $1',
        [preparado.intentId, cargo.providerRef],
      );
    });

    return {
      id: preparado.intentId,
      orderId: input.orderId,
      reference: preparado.reference,
      status: 'pending',
      amount: preparado.amount,
      currency: preparado.currency,
      checkoutUrl: cargo.checkoutUrl,
      expiresAt: preparado.expiresAt.toISOString(),
    };
  }

  // --------------------------------------------------------------- Webhook

  /**
   * Punto de entrada del aviso de la pasarela. La ÚNICA vía de confirmación.
   *
   * El orden de los pasos no es casual:
   *  1. Resolver la conexión por el token de la URL (escape acotado, ADR-0016).
   *  2. **Verificar la firma.** Antes de esto no se toca nada.
   *  3. Interpretar el aviso con el adaptador de esa pasarela.
   *  4. Aplicar el efecto y registrar el evento EN LA MISMA TRANSACCIÓN.
   *
   * El paso 4 junto es lo que hace idempotente el webhook: la clave única
   * `(tenant, provider, event_id)` no puede violarse a medias.
   */
  async handleWebhook(
    providerName: string,
    webhookToken: string,
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookOutcome> {
    const provider = this.providerFor(providerName);
    const conexion = await this.resolveConnection(webhookToken);

    if (conexion.provider !== providerName) {
      // El token es de otra pasarela. Mismo error opaco: distinguirlo diría a
      // quien prueba que el token existe.
      throw new WebhookSignatureError();
    }
    if (!provider.verifyWebhook(rawBody, headers, conexion.webhookSecret)) {
      this.logger.warn(
        `Firma inválida en aviso de ${providerName} (conexión ${conexion.id}).`,
      );
      throw new WebhookSignatureError();
    }
    if (conexion.status !== 'active') {
      // Pausada: se ignora en silencio con 200. Devolver error haría que la
      // pasarela reintentara durante días contra una conexión apagada a
      // propósito.
      return { kind: 'ignored', reason: 'La conexión está pausada.' };
    }

    let evento: WebhookEvent;
    try {
      evento = provider.parseWebhook(rawBody);
    } catch (error) {
      if (error instanceof WebhookParseError) {
        throw new ValidationError(error.message);
      }
      throw error;
    }

    return this.applyWebhook(conexion, evento, rawBody);
  }

  /**
   * Aplica el aviso ya verificado.
   *
   * Todo en una transacción con `FOR UPDATE` sobre la intención: dos avisos
   * simultáneos de la misma pasarela —cosa normal cuando reintenta mientras
   * manda el siguiente— se serializan en vez de pisarse.
   */
  private async applyWebhook(
    conexion: ConexionResuelta,
    evento: WebhookEvent,
    rawBody: string,
  ): Promise<WebhookOutcome> {
    const traceId = currentTraceId();

    const resultado = await withTenant(
      this.pool,
      conexion.tenantId,
      async (ctx) => {
        const { rows } = await ctx.client.query<FilaIntencion>(
          `SELECT id, tenant_id, order_id, connection_id, reference, status, amount, currency, expires_at
             FROM pay_intents WHERE reference = $1 FOR UPDATE`,
          [evento.reference],
        );
        const intencion = rows[0];

        const registrar = async (
          outcome: 'applied' | 'ignored' | 'rejected' | 'mismatch',
          detail: string,
          intentId: string | null,
        ): Promise<boolean> => {
          // ON CONFLICT DO NOTHING sobre la clave de dedupe: si esta fila ya
          // existe, este aviso ya se procesó y `rowCount` es 0. Es la
          // idempotencia, y vive en la BD para que no dependa de que nadie se
          // olvide de comprobarla.
          const r = await ctx.client.query(
            `INSERT INTO pay_webhook_events
               (tenant_id, connection_id, provider, event_id, intent_id,
                payload, outcome, detail, trace_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (tenant_id, provider, event_id) DO NOTHING`,
            [
              conexion.tenantId,
              conexion.id,
              conexion.provider,
              evento.eventId,
              intentId,
              JSON.parse(rawBody) as unknown,
              outcome,
              detail,
              traceId ?? null,
            ],
          );
          return (r.rowCount ?? 0) > 0;
        };

        if (!intencion) {
          await registrar(
            'rejected',
            'No existe una intención con esa referencia.',
            null,
          );
          return {
            outcome: { kind: 'ignored', reason: 'Referencia desconocida.' },
          } as const;
        }

        const decision = decidePaymentTransition(
          intencion.status,
          this.aEstado(evento.status),
        );
        if (decision.kind !== 'apply') {
          await registrar(
            decision.kind === 'ignore' ? 'ignored' : 'rejected',
            decision.reason,
            intencion.id,
          );
          return {
            outcome: { kind: 'ignored', reason: decision.reason },
          } as const;
        }

        // El importe se verifica, no se acepta (ADR-0016 §5).
        const esperado = Money.parse(
          intencion.amount,
          intencion.currency as 'PEN',
        );
        const recibido = Money.parse(evento.amount, evento.currency as 'PEN');
        const veredicto = verifyPaidAmount(esperado, recibido);

        if (!amountConfirms(veredicto)) {
          const motivo = this.describirDiscrepancia(veredicto);
          const nuevo = await registrar('mismatch', motivo, intencion.id);
          if (nuevo) {
            await ctx.client.query(
              `UPDATE pay_intents
                  SET paid_amount = $2, mismatch_reason = $3, updated_at = now()
                WHERE id = $1`,
              [intencion.id, evento.amount, motivo],
            );
            this.logger.error(
              `Importe distinto al esperado en el pago ${intencion.id}: ${motivo}`,
            );
          }
          return { outcome: { kind: 'mismatch', reason: motivo } } as const;
        }

        const nuevo = await registrar(
          'applied',
          `→ ${decision.to}`,
          intencion.id,
        );
        if (!nuevo) {
          // Duplicado exacto: ya se aplicó en su momento. Se responde
          // «ignorado» y NO se vuelve a tocar la intención.
          return {
            outcome: { kind: 'ignored', reason: 'Aviso ya procesado.' },
          } as const;
        }

        await ctx.client.query(
          `UPDATE pay_intents
              SET status = $2, paid_amount = $3, provider_ref = COALESCE($4, provider_ref),
                  captured_at = CASE WHEN $2 = 'captured' THEN now() ELSE captured_at END,
                  mismatch_reason = NULL, updated_at = now()
            WHERE id = $1`,
          [
            intencion.id,
            decision.to,
            evento.amount,
            evento.providerRef ?? null,
          ],
        );

        // El evento sale por el OUTBOX, en esta misma transacción (ADR-0007).
        // Publicar a Redis desde aquí dejaría un aviso sin pago o al revés.
        await enqueueEvent(ctx, {
          aggregateType: 'payment',
          aggregateId: intencion.id,
          eventType: `payment.${decision.to}`,
          payload: {
            intentId: intencion.id,
            orderId: intencion.order_id,
            amount: intencion.amount,
            currency: intencion.currency,
            provider: conexion.provider,
          },
        });

        return {
          outcome: {
            kind: 'applied',
            status: decision.to,
            intentId: intencion.id,
          },
          confirmar:
            decision.to === 'captured'
              ? {
                  orderId: intencion.order_id,
                  vencida: intencion.expires_at.getTime() < Date.now(),
                }
              : null,
        } as const;
      },
    );

    // La confirmación del PEDIDO va fuera de la transacción del pago a
    // propósito: `applyTransition` abre la suya con su propio `FOR UPDATE`
    // sobre el pedido, y anidarlas invitaría a un abrazo mortal entre dos
    // webhooks de pedidos que se referencian.
    const confirmar = 'confirmar' in resultado ? resultado.confirmar : null;
    if (confirmar) {
      await this.confirmarPedido(
        conexion.tenantId,
        confirmar.orderId,
        confirmar.vencida,
      );
    }

    return resultado.outcome;
  }

  /**
   * Confirma el pedido tras un pago capturado.
   *
   * El caso raro está contemplado a propósito: un pago que se confirma DESPUÉS
   * de que la intención venciera. Pasa —la pasarela reintenta, el cliente paga
   * en el último segundo, la red tarda— y el pedido puede haberse rechazado ya.
   * Cobrar por comida que se decidió no hacer es peor que perder la venta, así
   * que se marca para devolución automática (T5.04) en vez de forzar la
   * aceptación.
   */
  private async confirmarPedido(
    tenantId: string,
    orderId: string,
    vencida: boolean,
  ): Promise<void> {
    if (vencida) {
      this.logger.warn(
        `Pago capturado tras el vencimiento de su intención (pedido ${orderId}): queda para devolución.`,
      );
      return;
    }
    try {
      await this.ordering.applyTransition(tenantId, orderId, 'accept', {
        actorType: 'system',
        reason: 'Pago confirmado por la pasarela',
      });
    } catch (error) {
      // Un pedido que ya estaba aceptado —porque el aviso llegó dos veces por
      // caminos distintos— no es un fallo del pago. El dinero está cobrado y
      // registrado; que la transición no aplique se anota y se sigue.
      this.logger.warn(
        `El pago se registró pero el pedido ${orderId} no transicionó: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ----------------------------------------------------------------- Apoyo

  /**
   * Resuelve la conexión por el token público de la URL.
   *
   * ÚNICO punto que usa el escape `app.payment_lookup`, y no autoriza nada:
   * devuelve el secreto para que el llamador verifique la firma.
   */
  private async resolveConnection(
    webhookToken: string,
  ): Promise<ConexionResuelta> {
    const fila = await withPaymentLookup(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        provider: string;
        status: string;
        credentials: Record<string, unknown>;
      }>(
        `SELECT id, tenant_id, provider, status, credentials
           FROM pay_connections WHERE webhook_token = $1 LIMIT 1`,
        [webhookToken],
      );
      return rows[0];
    });
    if (!fila) throw new PaymentConnectionError();

    return {
      id: fila.id,
      tenantId: fila.tenant_id,
      provider: fila.provider,
      status: fila.status,
      webhookSecret: this.cipher.decryptField(
        fila.tenant_id,
        fila.credentials,
        WEBHOOK_SECRET_FIELD,
      ),
    };
  }

  private providerFor(name: string): PaymentProvider {
    const p = this.providers.get(name);
    if (!p) throw new NotFoundError('Pasarela no configurada.');
    return p;
  }

  /** El vocabulario del proveedor ya viene normalizado por su adaptador. */
  private aEstado(status: WebhookEvent['status']): PaymentState {
    return status;
  }

  private describirDiscrepancia(
    veredicto: ReturnType<typeof verifyPaidAmount>,
  ): string {
    switch (veredicto.kind) {
      case 'short':
        return `Llegaron ${veredicto.received} de ${veredicto.expected}: faltan ${veredicto.missing}.`;
      case 'over':
        return `Llegaron ${veredicto.received} de ${veredicto.expected}: sobran ${veredicto.excess}.`;
      case 'currency':
        return `Moneda distinta: se esperaba ${veredicto.expected} y llegó ${veredicto.received}.`;
      default:
        return 'Sin discrepancia.';
    }
  }

  // ------------------------------------------------------------- Consultas

  async getIntent(
    tenantId: string,
    intentId: string,
  ): Promise<PaymentIntentView> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<FilaIntencion>(
        `SELECT id, tenant_id, order_id, connection_id, reference, status, amount, currency, expires_at
           FROM pay_intents WHERE id = $1`,
        [intentId],
      );
      const fila = rows[0];
      if (!fila) throw new NotFoundError('Intención de pago no encontrada.');
      return this.aVista(fila);
    });
  }

  async listForOrder(
    tenantId: string,
    orderId: string,
    ctx?: TenantContext,
  ): Promise<PaymentIntentView[]> {
    const consultar = async (
      c: TenantContext,
    ): Promise<PaymentIntentView[]> => {
      const { rows } = await c.client.query<FilaIntencion>(
        `SELECT id, tenant_id, order_id, connection_id, reference, status, amount, currency, expires_at
           FROM pay_intents WHERE order_id = $1 ORDER BY created_at`,
        [orderId],
      );
      return rows.map((f) => this.aVista(f));
    };
    return ctx
      ? consultar(ctx)
      : withTenant(this.pool, tenantId, (c) => consultar(c));
  }

  private aVista(fila: FilaIntencion): PaymentIntentView {
    return {
      id: fila.id,
      orderId: fila.order_id,
      reference: fila.reference,
      status: fila.status,
      amount: fila.amount,
      currency: fila.currency,
      checkoutUrl: null,
      expiresAt: fila.expires_at.toISOString(),
    };
  }
}
