import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  MessagingService,
  type OrderMessageStats,
} from '../app/messaging.service.js';

/**
 * Mensajería (spec 12 §API).
 *
 * El webhook de Meta llega a `integrations` en F5, cuando DP-04 esté cerrado y
 * se sepa su forma exacta. Aquí queda lo que el panel necesita ya: registrar
 * consentimiento —requisito legal, no una función más— y ver el KPI de
 * mensajes por pedido, que es lo que decide si el canal es rentable.
 */

const consentimientoSchema = z.object({
  phone: z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      'El teléfono debe estar en formato E.164 (+51987654321).',
    ),
  action: z.enum(['granted', 'revoked']),
  source: z.string().min(1, 'Indica dónde se dio el consentimiento.'),
  // Obligatorio por RN-T10: hay que poder demostrar QUÉ aceptó esa persona.
  consentText: z
    .string()
    .min(10, 'Guarda el texto exacto que aceptó la persona (RN-T10).'),
});

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

@Controller({ path: 'messaging', version: '1' })
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Post('consents')
  @RequirePermission('messaging.manage')
  consent(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ contactId: string; optedOut: boolean }> {
    const dto = parse(consentimientoSchema, body);
    return this.messaging.recordConsent(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /** Mensajes de un pedido, con su estado de presupuesto (RN-WA-01). */
  @Get('orders/:id/stats')
  @RequirePermission('messaging.read')
  orderStats(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<OrderMessageStats> {
    return this.messaging.statsForOrder(req.auth!.tid, id);
  }

  /**
   * Media de mensajes por pedido: el número del panel de costos.
   *
   * A partir del cambio de precios de Meta cada mensaje de servicio se cobra,
   * así que esta media es lo que dice si el canal gana o pierde dinero.
   */
  @Get('kpi')
  @RequirePermission('messaging.read')
  kpi(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ orders: number; messages: number; average: number }> {
    const hasta = to ? new Date(to) : new Date();
    const desde = from
      ? new Date(from)
      : new Date(hasta.getTime() - 30 * 24 * 3_600_000);

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      throw new ValidationError('Fechas inválidas: usa formato ISO 8601.');
    }
    if (desde >= hasta) {
      throw new ValidationError(
        'El inicio del periodo debe ser anterior al fin.',
      );
    }

    return this.messaging.messagesPerOrder(req.auth!.tid, desde, hasta);
  }
}
