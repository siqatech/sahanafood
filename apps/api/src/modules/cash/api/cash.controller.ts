import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  CashService,
  type CashSessionView,
  type CashSummary,
} from '../app/cash.service.js';

/** Caja (spec 06 §API). */

const openSchema = z.object({
  locationId: z.string().uuid(),
  deviceId: z.string().uuid().optional(),
  openingFloatMinor: z.number().int().nonnegative().optional(),
  notes: z.string().max(500).optional(),
});

const movementSchema = z.object({
  kind: z.enum(['sale', 'refund', 'cash_in', 'cash_out', 'tip']),
  amountMinor: z.number().int().positive(),
  method: z.enum(['cash', 'card', 'wallet', 'transfer', 'other']).optional(),
  orderId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
});

const closeSchema = z.object({
  declaredCashMinor: z.number().int().nonnegative(),
  differenceReason: z.string().max(500).optional(),
  supervisorId: z.string().uuid().optional(),
  supervisorPin: z.string().min(4).max(12).optional(),
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

@Controller({ path: 'cash-sessions', version: '1' })
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Get()
  @RequirePermission('cash.read')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('location') location?: string,
  ): Promise<CashSessionView[]> {
    return this.cash.listSessions(req.auth!.tid, {
      ...(location !== undefined ? { locationId: location } : {}),
    });
  }

  @Post()
  @RequirePermission('cash.open')
  open(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CashSessionView> {
    const dto = parse(openSchema, body);
    return this.cash.open(req.auth!.tid, {
      ...dto,
      openedBy: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Get(':id')
  @RequirePermission('cash.read')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CashSessionView> {
    return this.cash.getSession(req.auth!.tid, id);
  }

  /** Arqueo en vivo: lo que debería haber en la gaveta ahora mismo. */
  @Get(':id/summary')
  @RequirePermission('cash.read')
  summary(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CashSummary> {
    return this.cash.summary(req.auth!.tid, id);
  }

  @Post(':id/movements')
  @RequirePermission('cash.read')
  movement(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ id: string; amount: unknown }> {
    const dto = parse(movementSchema, body);
    return this.cash.addMovement(req.auth!.tid, id, {
      ...dto,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Cierre con arqueo (RN-POS-02). Si hay diferencia exige motivo y PIN de
   * supervisor: un cierre descuadrado sin firmar es la forma más limpia de que
   * el dinero desaparezca sin que quede nadie señalado.
   */
  @Post(':id/close')
  @RequirePermission('cash.close')
  close(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CashSessionView> {
    const dto = parse(closeSchema, body);
    return this.cash.closeSession(req.auth!.tid, id, {
      ...dto,
      closedBy: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }
}
