import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  decidePaymentTransition,
  verifyPaidAmount,
  amountConfirms,
  isOpen,
  type PaymentState,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { CONFIG, type AppConfig } from '../../../config/config.js';
import {
  withTenant,
  withSystem,
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
import {
  PublicTokensService,
  PublicTokenError,
} from '../../../common/public-tokens.service.js';
import { SettlementsService } from './settlements.service.js';

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

/**
 * Estados de pedido que ya no admiten un pago (T5.04).
 *
 * Si el dinero llega con el pedido aquí, es que el sistema ya decidió no hacer
 * esa comida: hay que devolverlo. `delivered` y `picked_up` NO están en la
 * lista a propósito — un pago que confirma tarde sobre un pedido ya entregado
 * es simplemente un pago que confirma tarde, y devolverlo sería regalar la
 * comida.
 */
const NO_ACEPTAN_PAGO: ReadonlySet<string> = new Set(['rejected', 'cancelled']);

/**
 * Intentos de devolución antes de rendirse y pedir ayuda humana.
 *
 * Rendirse es parte del diseño: una pasarela que rechaza la devolución no va a
 * empezar a aceptarla al intento noventa, y el bucle infinito solo consigue que
 * nadie mire el problema.
 */
export const MAX_REFUND_ATTEMPTS = 5;

/**
 * Umbral por defecto sobre el que un reembolso manual exige doble aprobación
 * (RN-PAY-03), en unidades menores a escala 4. S/ 100.
 *
 * Configurable por tenant en F6; el valor por defecto está aquí y no en la base
 * porque un umbral ausente NO puede significar «sin control»: significa el
 * valor conservador.
 */
export const DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR = 1_000_000;

/** Cuánto vive un link de pago si nadie dice otra cosa. */
const DEFAULT_LINK_TTL_MINUTES = 60 * 24;

export class RefundRequiresApprovalError extends ForbiddenError {
  constructor(threshold: string, amount: string) {
    super(
      `Un reembolso de ${amount} supera el umbral de ${threshold} y necesita la aprobación de un supervisor.`,
      { requiredPermission: 'payments.refund', threshold, amount },
    );
  }
}

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
    private readonly publicTokens: PublicTokensService,
    private readonly settlements: SettlementsService,
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

  // ------------------------------------------------------- Links de pago

  /**
   * Genera un link de pago para un pedido (T5.05).
   *
   * Lo usa el agente desde la bandeja —«te paso el link»— y el panel. La URL
   * lleva un token público (ADR-0017), **nunca el id del pedido ni el de la
   * intención**: ese enlace se reenvía por WhatsApp, se pega en chats y acaba
   * en capturas de pantalla, y un identificador interno ahí es un identificador
   * publicado para siempre.
   *
   * El token y la intención se crean en la MISMA transacción: un link que
   * apunta a un cobro que no existe es un 404 para el cliente que ya recibió el
   * mensaje.
   */
  async createPaymentLink(
    tenantId: string,
    input: {
      orderId: string;
      provider: string;
      ttlMinutes?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{
    token: string;
    url: string;
    expiresAt: string;
    intentId: string;
  }> {
    const ttl = input.ttlMinutes ?? DEFAULT_LINK_TTL_MINUTES;
    const intencion = await this.createIntent(tenantId, {
      orderId: input.orderId,
      provider: input.provider,
      ttlMinutes: ttl,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    });

    const expiresAt = new Date(intencion.expiresAt);
    const token = await withTenant(this.pool, tenantId, async (ctx) => {
      const t = await this.publicTokens.issue(ctx, {
        purpose: 'payment_link',
        resourceType: 'payment_intent',
        resourceId: intencion.id,
        expiresAt,
        ...(input.actorId !== undefined ? { createdBy: input.actorId } : {}),
      });
      await recordAudit(ctx, {
        actorType: 'user',
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        action: 'payment.link_created',
        resourceType: 'payment_intent',
        resourceId: intencion.id,
        // El token NO entra en auditoría: quien lea la auditoría podría cobrar
        // en nombre de otro. Basta con saber que se generó y para qué pedido.
        data: { orderId: input.orderId, expiresAt: expiresAt.toISOString() },
      });
      return t;
    });

    return {
      token,
      url: `/pay/${token}`,
      expiresAt: expiresAt.toISOString(),
      intentId: intencion.id,
    };
  }

  /**
   * Abre un link de pago. Endpoint PÚBLICO: quien llama no tiene cuenta.
   *
   * Devuelve lo mínimo para pagar —cuánto, en qué moneda, a dónde ir— y NADA
   * más. Ni el id del pedido, ni el del cobro, ni el nombre del cliente: el que
   * abre el enlace puede no ser a quien se lo mandaron.
   */
  async openPaymentLink(token: string): Promise<{
    status: PaymentState;
    amount: string;
    currency: string;
    checkoutUrl: string | null;
    expiresAt: string;
  }> {
    const resuelto = await this.publicTokens.resolve(token, 'payment_link');

    const vista = await withTenant(
      this.pool,
      resuelto.tenantId,
      async (ctx) => {
        const { rows } = await ctx.client.query<{
          status: PaymentState;
          amount: string;
          currency: string;
          provider_ref: string | null;
          expires_at: Date;
          connection_id: string;
        }>(
          `SELECT status, amount, currency, provider_ref, expires_at, connection_id
             FROM pay_intents WHERE id = $1`,
          [resuelto.resourceId],
        );
        return rows[0];
      },
    );
    // El token existe pero el cobro no: solo puede pasar si alguien borró la
    // intención. Mismo error opaco que el resto.
    if (!vista) throw new PublicTokenError();

    // Se registra la apertura, pero NO se bloquea la siguiente (ADR-0017): un
    // link que muere al abrirse pierde la venta del cliente al que le sonó el
    // teléfono.
    await this.publicTokens.markUsed(resuelto.tenantId, token);

    const providerName = await this.providerNameOf(
      resuelto.tenantId,
      vista.connection_id,
    );
    const provider = providerName ? this.providers.get(providerName) : null;

    return {
      status: vista.status,
      amount: vista.amount,
      currency: vista.currency,
      // Solo se ofrece dónde pagar si el cobro sigue abierto. Un enlace de un
      // pago ya hecho enseña «pagado», no un botón que cobraría otra vez.
      checkoutUrl:
        isOpen(vista.status) && provider && vista.provider_ref
          ? `https://checkout.${provider.name}.test/${vista.provider_ref}`
          : null,
      expiresAt: vista.expires_at.toISOString(),
    };
  }

  /** Corta un enlace que se mandó a quien no era. */
  async revokePaymentLink(tenantId: string, token: string): Promise<void> {
    await this.publicTokens.revoke(tenantId, token);
  }

  // ------------------------------------------------- Reembolsos manuales

  /**
   * Devuelve dinero a petición de una persona (T5.06, RN-PAY-03).
   *
   * Distinto de la devolución automática de T5.04, que la pide el sistema
   * porque el cobro no debió confirmarse. Aquí decide alguien, y por eso hay
   * control: **sobre el umbral hacen falta dos personas**, quien lo pide y
   * quien lo aprueba.
   *
   * No es burocracia. Es lo que impide que una sola cuenta comprometida vacíe
   * la caja del tenant en devoluciones a cuentas ajenas — el mismo motivo por
   * el que un descuento sobre umbral pide PIN de supervisor (RN-POS-03).
   */
  async requestRefund(
    tenantId: string,
    intentId: string,
    input: {
      reason: string;
      requestedBy: string;
      approvedBy?: string | undefined;
      thresholdMinor?: number | undefined;
    },
  ): Promise<{ status: 'queued'; requiresApproval: boolean }> {
    if (input.reason.trim().length < 5) {
      throw new ValidationError(
        'Un reembolso necesita un motivo: es lo que verá quien lo audite.',
      );
    }

    const umbralMinor =
      input.thresholdMinor ?? DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR;

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        status: PaymentState;
        amount: string;
        currency: string;
        paid_amount: string | null;
        refund_required: boolean;
      }>(
        `SELECT id, status, amount, currency, paid_amount, refund_required
           FROM pay_intents WHERE id = $1 FOR UPDATE`,
        [intentId],
      );
      const intencion = rows[0];
      if (!intencion) throw new NotFoundError('Cobro no encontrado.');

      if (intencion.status !== 'captured') {
        throw new ValidationError(
          `Solo se puede devolver un cobro capturado; este está en "${intencion.status}".`,
        );
      }
      if (intencion.refund_required) {
        // Ya estaba en cola. Pedirlo otra vez no crea una segunda devolución.
        return { status: 'queued' as const, requiresApproval: false };
      }

      const importe = Money.parse(
        intencion.paid_amount ?? intencion.amount,
        intencion.currency as 'PEN',
      );
      const umbral = Money.fromMinor(umbralMinor, intencion.currency as 'PEN');
      const sobreUmbral = importe.minorUnits > umbral.minorUnits;

      if (sobreUmbral) {
        if (!input.approvedBy) {
          throw new RefundRequiresApprovalError(
            umbral.toDecimalString(),
            importe.toDecimalString(),
          );
        }
        if (input.approvedBy === input.requestedBy) {
          // DOS personas, no una con dos sombreros. Sin esto, el control es
          // teatro: la misma cuenta comprometida se aprueba a sí misma.
          throw new ForbiddenError(
            'Quien aprueba un reembolso no puede ser quien lo pide: hacen falta dos personas.',
          );
        }
      }

      await ctx.client.query(
        `UPDATE pay_intents
            SET refund_required = true, refund_reason = $2,
                refund_requested_by = $3, refund_approved_by = $4,
                refund_threshold_applied = $5, updated_at = now()
          WHERE id = $1`,
        [
          intentId,
          input.reason,
          input.requestedBy,
          input.approvedBy ?? null,
          umbral.toDecimalString(),
        ],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: input.requestedBy,
        action: 'payment.refund_requested',
        resourceType: 'payment_intent',
        resourceId: intentId,
        reason: input.reason,
        data: {
          amount: importe.toDecimalString(),
          threshold: umbral.toDecimalString(),
          overThreshold: sobreUmbral,
          approvedBy: input.approvedBy ?? null,
        },
      });

      // El dinero lo devuelve el barrido, igual que en T5.04: es una llamada de
      // red a un tercero y no puede colgar la petición de quien pulsó el botón.
      return { status: 'queued' as const, requiresApproval: sobreUmbral };
    });
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

        // ¿Este cobro se puede honrar? Solo importa al capturar, y hay que
        // saberlo AQUÍ dentro para poder marcar la devolución en la misma
        // transacción que la captura (T5.04).
        const noHonorable =
          decision.to === 'captured'
            ? await this.motivoParaDevolver(ctx, intencion)
            : null;

        await ctx.client.query(
          `UPDATE pay_intents
              SET status = $2, paid_amount = $3, provider_ref = COALESCE($4, provider_ref),
                  captured_at = CASE WHEN $2 = 'captured' THEN now() ELSE captured_at END,
                  mismatch_reason = NULL,
                  refund_required = $5, refund_reason = $6,
                  updated_at = now()
            WHERE id = $1`,
          [
            intencion.id,
            decision.to,
            evento.amount,
            evento.providerRef ?? null,
            noHonorable !== null,
            noHonorable,
          ],
        );

        if (decision.to === 'captured') {
          // La comisión se estima AQUÍ y no al aceptar el pedido, porque hasta
          // que el cobro no se captura no se sabe cuánto se cobró de verdad: un
          // pago parcial o un importe distinto cambiarían la base. Sin tarifa
          // configurada se deja NULL, que es distinto de cero (RN-BIL-04).
          try {
            await this.settlements.estimateForIntent(ctx, intencion.id);
          } catch (error) {
            // Estimar mal no puede tumbar un cobro que ya ocurrió: el dinero
            // está, y la comisión se puede recalcular al conciliar.
            this.logger.warn(
              `No se pudo estimar la comisión del cobro ${intencion.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (noHonorable !== null) {
          // El dinero está cobrado y hay que devolverlo. Se registra como
          // alarma: es plata de un cliente retenida por un pedido que no se va
          // a preparar, y nadie debería enterarse por la conciliación.
          this.logger.error(
            `Cobro que no debió confirmarse (${intencion.id}): ${noHonorable}. Marcado para devolución.`,
          );
          await recordAudit(ctx, {
            actorType: 'system',
            action: 'payment.refund_required',
            resourceType: 'payment_intent',
            resourceId: intencion.id,
            reason: noHonorable,
            data: { orderId: intencion.order_id, amount: intencion.amount },
          });
        }

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
            decision.to === 'captured' && noHonorable === null
              ? { orderId: intencion.order_id }
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
      await this.confirmarPedido(conexion.tenantId, confirmar.orderId);
    }

    return resultado.outcome;
  }

  /**
   * ¿Hay motivo para devolver este cobro? (T5.04)
   *
   * Dos motivos, y los dos son el mismo hecho visto desde sitios distintos: el
   * dinero llegó cuando el sistema ya había decidido no hacer esa comida.
   *
   *  · La intención venció. El cliente pagó en el último segundo, o la pasarela
   *    tardó en avisar.
   *  · El pedido ya no admite aceptación —lo rechazó el barrido por vencimiento
   *    (RN-ORD-04) o lo canceló alguien—.
   *
   * Se comprueba DENTRO de la transacción de la captura a propósito: la
   * decisión y la marca tienen que ser atómicas con el cambio de estado.
   */
  private async motivoParaDevolver(
    ctx: TenantContext,
    intencion: FilaIntencion,
  ): Promise<string | null> {
    if (intencion.expires_at.getTime() < Date.now()) {
      return 'El pago se confirmó después de que venciera la intención de cobro.';
    }

    const { rows } = await ctx.client.query<{ status: string }>(
      'SELECT status FROM ord_orders WHERE id = $1',
      [intencion.order_id],
    );
    const estado = rows[0]?.status;
    if (estado === undefined) {
      return 'El pago se confirmó pero el pedido ya no existe.';
    }
    if (NO_ACEPTAN_PAGO.has(estado)) {
      return `El pago se confirmó con el pedido ya en "${estado}".`;
    }
    return null;
  }

  /**
   * Devuelve el dinero de los cobros marcados.
   *
   * Barrido y no llamada en línea: devolver es una llamada de red a un tercero,
   * y el proceso puede morirse entre capturar y devolver. Con la marca escrita
   * junto a la captura, ese hueco solo retrasa la devolución; sin ella, la
   * dejaría sin hacer y sin nadie que lo supiera.
   *
   * Cruza tenants —lo llama el worker— y por eso resuelve cada intención en su
   * propio contexto.
   */
  async processRefunds(limit = 20): Promise<{
    refunded: number;
    failed: number;
    exhausted: number;
  }> {
    // `pay_intents` NO tiene escape de sistema, y es deliberado: es una tabla
    // con importes (ADR-0016 §1). Así que el barrido hace lo mismo que el de
    // aceptación: enumera tenants bajo `app.system` —que sí abre el catálogo de
    // tenants— y luego entra en el contexto de cada uno.
    //
    // Es más lento que una consulta global. Es también la única forma de que
    // este barrido no sea un agujero por el que se vean los cobros de todos.
    const tenants = await this.tenantsActivos();
    const pendientes: Array<{
      id: string;
      tenant_id: string;
      provider_ref: string | null;
      paid_amount: string | null;
      amount: string;
      refund_attempts: number;
      connection_id: string;
    }> = [];

    for (const tenantId of tenants) {
      if (pendientes.length >= limit) break;
      const filas = await withTenant(
        this.pool,
        tenantId,
        async ({ client }) => {
          const { rows } = await client.query<{
            id: string;
            tenant_id: string;
            provider_ref: string | null;
            paid_amount: string | null;
            amount: string;
            refund_attempts: number;
            connection_id: string;
          }>(
            `SELECT id, tenant_id, provider_ref, paid_amount, amount,
                  refund_attempts, connection_id
             FROM pay_intents
            WHERE refund_required AND status = 'captured'
              AND refund_attempts < $2
            ORDER BY captured_at
            LIMIT $1`,
            [limit - pendientes.length, MAX_REFUND_ATTEMPTS],
          );
          return rows;
        },
      );
      pendientes.push(...filas);
    }

    const resultado = { refunded: 0, failed: 0, exhausted: 0 };

    for (const fila of pendientes) {
      const providerName = await this.providerNameOf(
        fila.tenant_id,
        fila.connection_id,
      );
      const provider = providerName ? this.providers.get(providerName) : null;

      if (!provider || !fila.provider_ref) {
        // Sin referencia de la pasarela no se puede devolver por API. Es una
        // devolución a mano, y decirlo es más útil que reintentar en bucle.
        await this.anotarFalloDeDevolucion(
          fila.tenant_id,
          fila.id,
          'Sin referencia de la pasarela: la devolución tiene que hacerse a mano.',
          MAX_REFUND_ATTEMPTS,
        );
        resultado.exhausted++;
        continue;
      }

      try {
        const devuelto = await provider.refund(
          fila.provider_ref,
          fila.paid_amount ?? fila.amount,
        );

        await withTenant(this.pool, fila.tenant_id, async (ctx) => {
          await ctx.client.query(
            `UPDATE pay_intents
                SET status = 'refunded', refunded_at = now(),
                    refund_required = false, refund_provider_ref = $2,
                    refund_last_error = NULL, updated_at = now()
              WHERE id = $1`,
            [fila.id, devuelto.providerRef],
          );
          await enqueueEvent(ctx, {
            aggregateType: 'payment',
            aggregateId: fila.id,
            eventType: 'payment.refunded',
            payload: {
              intentId: fila.id,
              amount: devuelto.amount,
              automatic: true,
            },
          });
          await recordAudit(ctx, {
            actorType: 'system',
            action: 'payment.refunded',
            resourceType: 'payment_intent',
            resourceId: fila.id,
            data: { amount: devuelto.amount, automatic: true },
          });
        });
        resultado.refunded++;
      } catch (error) {
        const mensaje = error instanceof Error ? error.message : String(error);
        const intentos = fila.refund_attempts + 1;
        await this.anotarFalloDeDevolucion(
          fila.tenant_id,
          fila.id,
          mensaje,
          intentos,
        );
        if (intentos >= MAX_REFUND_ATTEMPTS) resultado.exhausted++;
        else resultado.failed++;
      }
    }

    return resultado;
  }

  /**
   * Marca como vencidas las intenciones que nadie pagó.
   *
   * Sin esto, una intención abierta lo sigue estando para siempre y el panel
   * enseña cobros «esperando pago» de hace semanas. Cruza tenants: lo llama el
   * worker.
   */
  async expireStaleIntents(limit = 200): Promise<number> {
    // Mismo motivo que en `processRefunds`: tenant a tenant, porque la tabla no
    // tiene —ni debe tener— escape de sistema.
    let vencidas = 0;
    for (const tenantId of await this.tenantsActivos()) {
      if (vencidas >= limit) break;
      vencidas += await withTenant(this.pool, tenantId, async ({ client }) => {
        const { rowCount } = await client.query(
          `UPDATE pay_intents
              SET status = 'expired', updated_at = now()
            WHERE id IN (
              SELECT id FROM pay_intents
               WHERE status IN ('pending','authorized') AND expires_at < now()
               ORDER BY expires_at
               LIMIT $1
            )`,
          [limit - vencidas],
        );
        return rowCount ?? 0;
      });
    }
    return vencidas;
  }

  /**
   * Tenants activos. El catálogo de tenants SÍ es visible bajo `app.system`
   * —es infraestructura de plataforma, no dato de negocio— y es el único punto
   * donde este servicio usa ese escape.
   */
  private async tenantsActivos(): Promise<string[]> {
    return withSystem(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM ten_tenants WHERE status = 'active'",
      );
      return rows.map((r) => r.id);
    });
  }

  private async anotarFalloDeDevolucion(
    tenantId: string,
    intentId: string,
    mensaje: string,
    intentos: number,
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async ({ client }) => {
      await client.query(
        `UPDATE pay_intents
            SET refund_attempts = $3, refund_last_error = $2, updated_at = now()
          WHERE id = $1`,
        [intentId, mensaje, intentos],
      );
    });
    const agotado = intentos >= MAX_REFUND_ATTEMPTS;
    this.logger[agotado ? 'error' : 'warn'](
      `Devolución ${agotado ? 'AGOTADA' : 'fallida'} para el cobro ${intentId} (intento ${intentos}/${MAX_REFUND_ATTEMPTS}): ${mensaje}`,
    );
  }

  private async providerNameOf(
    tenantId: string,
    connectionId: string,
  ): Promise<string | null> {
    return withTenant(this.pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ provider: string }>(
        'SELECT provider FROM pay_connections WHERE id = $1',
        [connectionId],
      );
      return rows[0]?.provider ?? null;
    });
  }

  /** Confirma el pedido tras un pago capturado que SÍ se puede honrar. */
  private async confirmarPedido(
    tenantId: string,
    orderId: string,
  ): Promise<void> {
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
