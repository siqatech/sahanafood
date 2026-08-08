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
