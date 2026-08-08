import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  PaymentsService,
  type PaymentIntentView,
  type WebhookOutcome,
} from '../app/payments.service.js';
import {
  SettlementsService,
  type ReconciliationReport,
} from '../app/settlements.service.js';

// Mismo helper local que el resto de controladores del repo. Está duplicado en
// los once: candidato claro a extraer a `common/`, pero no en el commit de un
// módulo nuevo — un refactor que toca diez ficheros ajenos esconde lo que este
// cambio de verdad hace.
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(' '),
      { errors: result.error.issues },
    );
  }
  return result.data;
}

const connectionSchema = z.object({
  provider: z.string().min(1),
  brandId: z.string().uuid().optional(),
  webhookSecret: z.string().min(16),
  apiKey: z.string().min(1).optional(),
});

const intentSchema = z.object({
  orderId: z.string().uuid(),
  provider: z.string().min(1),
  ttlMinutes: z.number().int().positive().max(1440).optional(),
});

const linkSchema = intentSchema;

const refundSchema = z.object({
  reason: z.string().min(5),
  /**
   * Quién aprueba, cuando el importe supera el umbral (RN-PAY-03). Va en el
   * cuerpo y no se deduce del token: el que pulsa el botón es quien PIDE, y
   * quien aprueba es otra persona.
   */
  approvedBy: z.string().uuid().optional(),
});

/**
 * API de pagos online (spec 10, ADR-0016).
 *
 * Nótese lo que NO hay aquí: **ningún endpoint que confirme un pago**. La
 * confirmación entra por `WebhookController`, firmada, y por ningún otro sitio.
 * Un `POST /payments/:id/confirm` con permiso de cajero parecería razonable y
 * sería justamente la vulnerabilidad que RN-PAY-01 previene.
 */
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('connections')
  @RequirePermission('payments.manage')
  async createConnection(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; webhookToken: string; callbackPath: string }> {
    const input = parse(connectionSchema, body);
    return this.payments.createConnection(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('intents')
  @RequirePermission('payments.charge')
  async createIntent(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PaymentIntentView> {
    const input = parse(intentSchema, body);
    return this.payments.createIntent(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Get('intents/:id')
  @RequirePermission('payments.read')
  async getIntent(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<PaymentIntentView> {
    return this.payments.getIntent(req.auth!.tid, id);
  }

  @Post('links')
  @RequirePermission('payments.charge')
  async createLink(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{
    token: string;
    url: string;
    expiresAt: string;
    intentId: string;
  }> {
    const input = parse(linkSchema, body);
    return this.payments.createPaymentLink(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('links/:token/revoke')
  @RequirePermission('payments.charge')
  @HttpCode(204)
  async revokeLink(
    @Req() req: AuthenticatedRequest,
    @Param('token') token: string,
  ): Promise<void> {
    await this.payments.revokePaymentLink(req.auth!.tid, token);
  }

  /**
   * Devolver dinero (RN-PAY-03). Permiso propio y separado de `payments.charge`:
   * cobrar y devolver son operaciones opuestas y no las hace la misma gente.
   */
  @Post('intents/:id/refund')
  @RequirePermission('payments.refund')
  async refund(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ status: 'queued'; requiresApproval: boolean }> {
    const input = parse(refundSchema, body);
    return this.payments.requestRefund(req.auth!.tid, id, {
      reason: input.reason,
      requestedBy: req.auth!.sub,
      ...(input.approvedBy !== undefined
        ? { approvedBy: input.approvedBy }
        : {}),
    });
  }

  @Get('orders/:orderId/intents')
  @RequirePermission('payments.read')
  async listForOrder(
    @Req() req: AuthenticatedRequest,
    @Param('orderId') orderId: string,
  ): Promise<PaymentIntentView[]> {
    return this.payments.listForOrder(req.auth!.tid, orderId);
  }
}

/**
 * Entrada del aviso de la pasarela (RN-PAY-01).
 *
 * SIN `@RequirePermission` a propósito: quien llama es Culqi, no un usuario
 * nuestro. La autenticación es la firma sobre el cuerpo crudo, verificada
 * contra el secreto cifrado de la conexión que el token de la URL identifica.
 *
 * Responde **200 incluso cuando el aviso se ignora**. No es descuido: un aviso
 * repetido, tardío o de una conexión pausada es algo normal y ya está
 * registrado. Devolver 4xx haría que la pasarela reintentara durante días y
 * acabara marcando el endpoint como caído — y entonces sí se perderían avisos
 * que importan.
 */
const tariffSchema = z.object({
  channel: z.string().min(1),
  provider: z.string().min(1).optional(),
  brandId: z.string().uuid().optional(),
  /** Puntos básicos enteros: 350 = 3,5 %. Nunca un decimal (ADR-0013). */
  percentBps: z.number().int().min(0).max(10_000),
  fixedAmount: z.string().optional(),
  minimumAmount: z.string().optional(),
});

const settlementSchema = z.object({
  provider: z.string().min(1),
  externalRef: z.string().min(1),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  grossAmount: z.string(),
  feeAmount: z.string(),
  netAmount: z.string(),
  currency: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        providerRef: z.string().min(1),
        grossAmount: z.string(),
        feeAmount: z.string(),
        netAmount: z.string(),
      }),
    )
    .min(1),
});

/**
 * Conciliación de liquidaciones (T5.07, RN-BIL-04).
 *
 * Permiso `payments.manage`: quien importa un informe de liquidación está
 * declarando cuánto cobró de verdad el canal, y ese número acaba en el margen
 * que el dueño usa para decidir si una marca sigue abierta.
 */
@Controller({ path: 'payments', version: '1' })
export class SettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post('tariffs')
  @RequirePermission('payments.manage')
  async setTariff(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    const input = parse(tariffSchema, body);
    return this.settlements.setTariff(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('settlements')
  @RequirePermission('payments.manage')
  async importSettlement(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; alreadyImported: boolean }> {
    const input = parse(settlementSchema, body);
    return this.settlements.importSettlement(
      req.auth!.tid,
      input,
      req.auth!.sub,
    );
  }

  @Post('settlements/:id/reconcile')
  @RequirePermission('payments.manage')
  async reconcile(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ReconciliationReport> {
    return this.settlements.reconcile(req.auth!.tid, id);
  }
}

/**
 * Apertura de un link de pago. PÚBLICO: quien llama no tiene cuenta (ADR-0017).
 *
 * Devuelve lo mínimo para pagar y nada más. Ni el id del pedido, ni el del
 * cobro, ni el nombre de nadie: quien abre el enlace puede no ser a quien se lo
 * mandaron — se reenvía por WhatsApp, se pega en chats y acaba en capturas.
 */
@Controller({ path: 'payments', version: '1' })
export class PaymentLinkController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('links/:token')
  async open(@Param('token') token: string): Promise<{
    status: string;
    amount: string;
    currency: string;
    checkoutUrl: string | null;
    expiresAt: string;
  }> {
    return this.payments.openPaymentLink(token);
  }
}

@Controller({ path: 'payments', version: '1' })
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('callbacks/:provider/:token')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Param('token') token: string,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<WebhookOutcome> {
    // El cuerpo CRUDO es obligatorio: sin él no se puede validar una firma.
    // Si falta, es un fallo de configuración de la app (el parser `raw` de
    // `configureApp`), y debe verse de inmediato en vez de degradarse a «firma
    // mala», que enviaría a depurar el secreto equivocado.
    const crudo =
      req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : undefined);
    if (!crudo) {
      throw new ValidationError(
        'No se recibió el cuerpo crudo de la petición; no se puede verificar la firma.',
      );
    }

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }

    return this.payments.handleWebhook(
      provider,
      token,
      crudo.toString('utf8'),
      headers,
    );
  }
}
