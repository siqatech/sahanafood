import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { OrderState } from '@sahana/domain';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import { OrderingService, type OrderSummary } from '../app/ordering.service.js';

/** API de pedidos (spec 05 §7). */

const lineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  modifierOptionIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(500).optional(),
});

const submitSchema = z.object({
  brandId: z.string().uuid(),
  locationId: z.string().uuid(),
  channel: z.string().min(1),
  externalRef: z.string().min(1).optional(),
  lines: z.array(lineSchema).min(1, 'El pedido necesita al menos una línea.'),
  customerName: z.string().max(200).optional(),
  customerPhone: z.string().max(40).optional(),
  delivery: z
    .object({
      address: z.string().min(1),
      lat: z.number(),
      lng: z.number(),
    })
    .optional(),
  tipMinor: z.number().int().nonnegative().optional(),
  scheduledAt: z.string().datetime().optional(),
  notes: z.string().max(1000).optional(),
});

const reasonSchema = z.object({
  reason: z.string().min(3, 'Indica el motivo.'),
});

const modifySchema = z.object({
  lines: z.array(lineSchema).min(1, 'El pedido necesita al menos una línea.'),
  reason: z.string().max(500).optional(),
});

const resolveMappingSchema = z.object({
  lines: z
    .array(lineSchema)
    .min(1, 'Indica a qué productos nuestros corresponde el pedido.'),
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

@Controller({ path: 'orders', version: '1' })
export class OrderingController {
  constructor(private readonly ordering: OrderingService) {}

  /** Crea un pedido. Admite Idempotency-Key (ADR-0010). */
  @Post()
  @RequirePermission('orders.create')
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderSummary> {
    // `scheduledAt` llega como cadena ISO y el servicio espera Date: se separa
    // del resto para no arrastrar el tipo unión al hacer el spread.
    const { scheduledAt, ...dto } = parse(submitSchema, body);
    return this.ordering.submit(req.auth!.tid, {
      ...dto,
      ...(scheduledAt !== undefined
        ? { scheduledAt: new Date(scheduledAt) }
        : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Get()
  @RequirePermission('orders.read')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('limit') limit?: string,
  ): Promise<OrderSummary[]> {
    return this.ordering.list(req.auth!.tid, {
      ...(status !== undefined ? { status: status as OrderState } : {}),
      ...(channel !== undefined ? { channel } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  /** Bandeja de excepciones (RN-ORD-10): pedidos que esperan intervención. */
  @Get('exceptions')
  @RequirePermission('orders.read')
  exceptions(@Req() req: AuthenticatedRequest): Promise<OrderSummary[]> {
    return this.ordering.listExceptions(req.auth!.tid);
  }

  @Get(':id')
  @RequirePermission('orders.read')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<OrderSummary> {
    return this.ordering.getSummary(req.auth!.tid, id);
  }

  /** Timeline completo: qué le pasó al pedido y cuándo. */
  @Get(':id/timeline')
  @RequirePermission('orders.read')
  timeline(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<unknown[]> {
    return this.ordering.getTimeline(req.auth!.tid, id);
  }

  /**
   * Modifica el pedido antes de que entre en cocina (RN-ORD-07).
   *
   * `If-Match` lleva el `rowVersion` que el cliente leyó. Es obligatorio a
   * propósito: sin él, dos personas editando el mismo pedido a la vez producen
   * una pérdida silenciosa de líneas, y en un mostrador con prisa eso pasa a
   * diario.
   */
  @Patch(':id')
  @RequirePermission('orders.modify')
  modify(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ): Promise<OrderSummary> {
    const version = Number(ifMatch);
    if (!ifMatch || !Number.isInteger(version) || version < 1) {
      throw new ValidationError(
        'Falta la cabecera If-Match con la versión del pedido (campo rowVersion).',
      );
    }
    const dto = parse(modifySchema, body);
    return this.ordering.modify(req.auth!.tid, id, {
      lines: dto.lines,
      expectedVersion: version,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Resuelve el mapeo de un pedido apartado y lo devuelve al flujo (RN-ORD-10).
   * Es la salida de la bandeja de excepciones que NO es un rechazo.
   */
  @Post(':id/resolve-mapping')
  @RequirePermission('orders.review_exceptions')
  resolveMapping(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OrderSummary> {
    const dto = parse(resolveMappingSchema, body);
    return this.ordering.resolveMapping(req.auth!.tid, id, {
      lines: dto.lines,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Post(':id/accept')
  @RequirePermission('orders.transition')
  accept(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<OrderSummary> {
    return this.ordering.applyTransition(req.auth!.tid, id, 'accept', {
      actorId: req.auth!.sub,
      actorType: 'user',
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Post(':id/reject')
  @RequirePermission('orders.transition')
  reject(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OrderSummary> {
    const dto = parse(reasonSchema, body);
    return this.ordering.applyTransition(req.auth!.tid, id, 'reject', {
      actorId: req.auth!.sub,
      actorType: 'user',
      reason: dto.reason,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Cancela un pedido. Desde `preparing` exige `orders.cancel_in_progress`
   * (RN-ORD-06); el servicio lo comprueba con el permiso que se le pasa.
   */
  @Post(':id/cancel')
  @RequirePermission('orders.cancel')
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OrderSummary> {
    const dto = parse(reasonSchema, body);
    const elevado = req.auth!.permissions.some(
      (p) => p === 'orders.cancel_in_progress' || p === '*',
    );
    return this.ordering.applyTransition(req.auth!.tid, id, 'cancel', {
      actorId: req.auth!.sub,
      actorType: 'user',
      reason: dto.reason,
      hasElevatedPermission: elevado,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }
}
