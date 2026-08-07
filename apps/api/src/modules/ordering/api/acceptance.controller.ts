import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import { AcceptanceService } from '../app/acceptance.service.js';
import type { AcceptancePolicy } from '../app/acceptance-policy.js';

/** Políticas de aceptación de pedidos (RN-ORD-04). */

const policySchema = z.object({
  brandId: z.string().uuid().optional(),
  channel: z.string().min(1).optional(),
  autoAccept: z.boolean(),
  alertAfterMinutes: z.number().int().positive().max(1440).optional(),
  autoRejectAfterMinutes: z.number().int().positive().max(1440).optional(),
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

@Controller({ path: 'ordering/acceptance-policies', version: '1' })
export class AcceptanceController {
  constructor(private readonly acceptance: AcceptanceService) {}

  @Get()
  @RequirePermission('orders.read')
  list(
    @Req() req: AuthenticatedRequest,
  ): Promise<
    Array<AcceptancePolicy & { brandId: string | null; channel: string | null }>
  > {
    return this.acceptance.listPolicies(req.auth!.tid);
  }

  /**
   * Fija la política para un ámbito. Requiere `orders.transition` y no solo
   * lectura: decidir que los pedidos de un canal entran solos —o que se
   * rechazan a los 10 minutos— es la misma decisión que aceptarlos a mano,
   * tomada por adelantado.
   */
  @Post()
  @RequirePermission('orders.transition')
  set(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<AcceptancePolicy> {
    const dto = parse(policySchema, body);
    return this.acceptance.setPolicy(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
    });
  }
}
