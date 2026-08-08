import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  DeliveryService,
  type ShipmentView,
  type PublicTrackingView,
  type CourierBalance,
} from '../app/delivery.service.js';

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

const courierSchema = z.object({
  locationId: z.string().uuid(),
  fullName: z.string().min(2).max(120),
  phone: z.string().min(6).max(20).optional(),
  vehicle: z.enum(['moto', 'bici', 'auto', 'pie']).optional(),
  zoneIds: z.array(z.string().uuid()).optional(),
  userId: z.string().uuid().optional(),
});

const shipmentSchema = z.object({
  orderId: z.string().uuid(),
  zoneId: z.string().uuid().optional(),
  /** Céntimos enteros. Nunca un decimal en coma flotante. */
  codAmountMinor: z.number().int().nonnegative().optional(),
  promisedAt: z.coerce.date().optional(),
  externalCourier: z.string().min(2).max(80).optional(),
});

/** Gestión de reparto. Requiere sesión del panel o de la app del repartidor. */
@Controller({ path: 'delivery', version: '1' })
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  // ------------------------------------------------------------ Repartidores

  @Post('couriers')
  @RequirePermission('delivery.manage_couriers')
  async createCourier(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; firstName: string }> {
    const input = parse(courierSchema, body);
    return this.delivery.createCourier(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Get('couriers')
  @RequirePermission('delivery.manage_couriers')
  async listCouriers(
    @Req() req: AuthenticatedRequest,
    @Query('locationId') locationId?: string,
  ): Promise<unknown> {
    return this.delivery.listCouriers(req.auth!.tid, locationId);
  }

  @Post('couriers/:id/status')
  @RequirePermission('delivery.manage_couriers')
  async setStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(
      z.object({ status: z.enum(['available', 'busy', 'off']) }),
      body,
    );
    await this.delivery.setCourierStatus(req.auth!.tid, id, input.status);
    return { ok: true };
  }

  // ------------------------------------------------------------------ Envíos

  @Post('shipments')
  @RequirePermission('delivery.assign')
  async createShipment(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ShipmentView> {
    const input = parse(shipmentSchema, body);
    return this.delivery.createShipment(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Get('shipments')
  @RequirePermission('delivery.assign')
  async listShipments(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
  ): Promise<ShipmentView[]> {
    return this.delivery.listShipments(req.auth!.tid, { status });
  }

  @Get('shipments/:id')
  @RequirePermission('delivery.assign')
  async getShipment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ShipmentView> {
    return this.delivery.getShipment(req.auth!.tid, id);
  }

  /**
   * A quién conviene asignarle este envío (RN-DLV-01).
   *
   * Devuelve el ranking entero con el motivo de cada uno, no solo el ganador:
   * en F5 quien decide es una persona, y una recomendación sin explicación no
   * se sigue, se ignora.
   */
  @Get('shipments/:id/suggestions')
  @RequirePermission('delivery.assign')
  async suggestions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<unknown> {
    return this.delivery.suggestCouriers(req.auth!.tid, id);
  }

  @Post('shipments/:id/assign')
  @RequirePermission('delivery.assign')
  async assign(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ShipmentView> {
    const input = parse(z.object({ courierId: z.string().uuid() }), body);
    return this.delivery.assign(
      req.auth!.tid,
      id,
      input.courierId,
      req.auth!.sub,
    );
  }

  @Post('shipments/:id/pickup')
  @RequirePermission('delivery.operate')
  async pickup(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ShipmentView> {
    return this.delivery.pickUp(req.auth!.tid, id, req.auth!.sub);
  }

  @Post('shipments/:id/deliver')
  @RequirePermission('delivery.operate')
  async deliver(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ShipmentView> {
    const input = parse(
      z.object({
        evidence: z.record(z.unknown()).optional(),
        codCollected: z.boolean().optional(),
      }),
      body ?? {},
    );
    return this.delivery.deliver(req.auth!.tid, id, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('shipments/:id/fail')
  @RequirePermission('delivery.operate')
  async fail(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ShipmentView> {
    const input = parse(z.object({ reason: z.string().min(3).max(280) }), body);
    return this.delivery.fail(req.auth!.tid, id, input.reason, req.auth!.sub);
  }

  @Post('shipments/:id/retry')
  @RequirePermission('delivery.assign')
  async retry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ShipmentView> {
    return this.delivery.retry(req.auth!.tid, id, req.auth!.sub);
  }

  @Post('shipments/:id/return')
  @RequirePermission('delivery.assign')
  async returnToStore(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ShipmentView> {
    return this.delivery.returnToStore(req.auth!.tid, id, req.auth!.sub);
  }

  @Post('shipments/:id/tracking-link')
  @RequirePermission('delivery.assign')
  async trackingLink(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ token: string }> {
    return this.delivery.issueTrackingLink(req.auth!.tid, id);
  }

  // ------------------------------------------------------------ Liquidación

  @Get('couriers/balances')
  @RequirePermission('delivery.settle')
  async balances(@Req() req: AuthenticatedRequest): Promise<CourierBalance[]> {
    return this.delivery.courierBalances(req.auth!.tid);
  }

  @Post('couriers/:id/settle')
  @RequirePermission('delivery.settle')
  async settle(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ shipments: number; amount: string }> {
    const input = parse(z.object({ sessionId: z.string().uuid() }), body);
    return this.delivery.settleCourier(req.auth!.tid, {
      courierId: id,
      sessionId: input.sessionId,
      actorId: req.auth!.sub,
    });
  }
}

/**
 * Seguimiento público (T5.16). SIN autenticación, por diseño.
 *
 * Va en su propio controlador y no como una ruta más del de arriba para que la
 * diferencia se vea en el código: aquí no hay `@RequirePermission`, y eso tiene
 * que ser una decisión visible, no un decorador que alguien olvidó poner.
 */
@Controller({ path: 'tracking', version: '1' })
export class TrackingController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get(':token')
  async track(@Param('token') token: string): Promise<PublicTrackingView> {
    return this.delivery.publicTracking(token);
  }
}
