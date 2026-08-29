import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  KitchenService,
  type PackingOrderView,
  type TicketView,
} from '../app/kitchen.service.js';
import {
  SaturationService,
  type CapacityConfig,
  type SaturationResult,
} from '../app/saturation.service.js';

/** Formas de respuesta derivadas del servicio, para no duplicarlas aquí. */
type KitchenLoad = Awaited<ReturnType<KitchenService['load']>>;
type StartResult = Awaited<ReturnType<KitchenService['startTicket']>>;
type ReadyResult = Awaited<ReturnType<KitchenService['readyTicket']>>;
type PackResult = Awaited<ReturnType<KitchenService['packOrder']>>;

/**
 * KDS (spec 07 §API).
 *
 * La spec pide además suscripción por WebSocket. En F4 el KDS consume por
 * sondeo corto sobre estos mismos endpoints: la cola está indexada, la consulta
 * es barata, y el SLO de 5 s se cumple sin abrir un canal en tiempo real que
 * habría que reconectar, autenticar y probar. El WS llega con la PWA
 * (T4.20–T4.22), donde además hace falta para el modo sin red.
 */

const packSchema = z.object({
  checkedLineIds: z
    .array(z.string().uuid())
    .min(1, 'Marca las líneas verificadas.'),
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

@Controller({ path: 'kitchen', version: '1' })
export class KitchenController {
  constructor(
    private readonly kitchen: KitchenService,
    private readonly saturation: SaturationService,
  ) {}

  /**
   * Cola de la estación. CERO toques para verla (criterio de aceptación): el
   * KDS la pide y la pinta, sin filtros ni menús por medio.
   */
  @Get('queue')
  @RequirePermission('kitchen.read')
  queue(
    @Req() req: AuthenticatedRequest,
    @Query('station') station?: string,
    @Query('kitchen') kitchen?: string,
  ): Promise<TicketView[]> {
    if (!station && !kitchen) {
      throw new ValidationError(
        'Indica la estación o la cocina cuya cola quieres ver.',
      );
    }
    return this.kitchen.queue(req.auth!.tid, {
      ...(station !== undefined ? { stationId: station } : {}),
      ...(kitchen !== undefined ? { kitchenId: kitchen } : {}),
    });
  }

  /** Carga actual: base de la saturación de F5 y del panel del encargado. */
  @Get('load')
  @RequirePermission('kitchen.read')
  load(
    @Req() req: AuthenticatedRequest,
    @Query('kitchen') kitchen?: string,
  ): Promise<KitchenLoad> {
    if (!kitchen) {
      throw new ValidationError('Se requiere el parámetro kitchen.');
    }
    return this.kitchen.load(req.auth!.tid, kitchen);
  }

  // ------------------------------------------------ Capacidad (RN-KIT-04)

  /** Política de capacidad de una cocina y su nivel de saturación vigente. */
  @Get('capacity')
  @RequirePermission('kitchen.read')
  capacity(
    @Req() req: AuthenticatedRequest,
    @Query('kitchen') kitchen?: string,
  ): Promise<CapacityConfig> {
    if (!kitchen) {
      throw new ValidationError('Se requiere el parámetro kitchen.');
    }
    return this.saturation.getCapacity(req.auth!.tid, kitchen);
  }

  /**
   * Fija los umbrales. Es configuración de negocio, no de operación: quien la
   * toca decide cuántas ventas se dejan de aceptar en hora punta.
   */
  @Put('capacity/:kitchenId')
  @RequirePermission('kitchen.manage_capacity')
  setCapacity(
    @Req() req: AuthenticatedRequest,
    @Param('kitchenId') kitchenId: string,
    @Body() body: unknown,
  ): Promise<CapacityConfig> {
    const schema = z.object({
      maxConcurrentItems: z.number().int().positive().max(10_000),
      extendMinutes: z.number().int().positive().max(240),
      pauseThresholdItems: z
        .number()
        .int()
        .positive()
        .max(10_000)
        .nullable()
        .optional(),
      channelPauseOrder: z.array(z.string().min(1).max(40)).optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => i.message).join(' '),
        { errors: parsed.error.issues },
      );
    }
    return this.saturation.setCapacity(req.auth!.tid, kitchenId, {
      ...parsed.data,
      actorId: req.auth!.sub,
    });
  }

  /** Orden de pausa SUGERIDO por comisión. Sugerencia, no imposición. */
  @Get('capacity/suggested-order')
  @RequirePermission('kitchen.read')
  suggestedOrder(@Req() req: AuthenticatedRequest): Promise<string[]> {
    return this.saturation.suggestChannelOrder(req.auth!.tid);
  }

  /**
   * Evalúa la saturación ahora mismo y aplica lo que toque.
   *
   * Existe además del barrido periódico para que el encargado pueda forzar la
   * comprobación cuando ve la cocina desbordada sin esperar al siguiente ciclo.
   */
  @Post('capacity/:kitchenId/evaluate')
  @RequirePermission('kitchen.transition')
  evaluate(
    @Req() req: AuthenticatedRequest,
    @Param('kitchenId') kitchenId: string,
  ): Promise<SaturationResult> {
    return this.saturation.evaluate(req.auth!.tid, kitchenId);
  }

  /** Historial de saturación: para discutir el umbral con datos, no a ojo. */
  @Get('capacity/:kitchenId/history')
  @RequirePermission('kitchen.read')
  history(
    @Req() req: AuthenticatedRequest,
    @Param('kitchenId') kitchenId: string,
  ): Promise<unknown> {
    return this.saturation.history(req.auth!.tid, kitchenId);
  }

  @Get('tickets/:id')
  @RequirePermission('kitchen.read')
  ticket(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<TicketView> {
    return this.kitchen.getTicket(req.auth!.tid, id);
  }

  /** UN toque para avanzar (criterio de aceptación de la spec 07). */
  @Post('tickets/:id/start')
  @RequirePermission('kitchen.transition')
  start(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<StartResult> {
    return this.kitchen.startTicket(req.auth!.tid, id, {
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  @Post('tickets/:id/ready')
  @RequirePermission('kitchen.transition')
  ready(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ReadyResult> {
    return this.kitchen.readyTicket(req.auth!.tid, id, {
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Deshacer el último toque (ux/02, DT-11).
   *
   * Mismo permiso que avanzar: quien puede mover un ticket puede corregir su
   * propio toque. Las barreras que importan —ventana de tiempo y que el pedido
   * siga en cocina— viven en el servicio, no aquí.
   */
  @Post('tickets/:id/undo')
  @RequirePermission('kitchen.transition')
  undo(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ ticket: TicketView; orderResumed: boolean }> {
    return this.kitchen.undoTicket(req.auth!.tid, id, {
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Lo que espera empaque en esta cocina (ux/02 §Empaque).
   *
   * Se pide por cocina y devuelve PEDIDOS con todas sus líneas, no tickets:
   * empacar es del pedido. Un pedido repartido entre parrilla y frío se empaca
   * una vez, mirando la bolsa completa.
   */
  @Get('packing')
  @RequirePermission('kitchen.read')
  packing(
    @Req() req: AuthenticatedRequest,
    @Query('kitchen') kitchen?: string,
  ): Promise<PackingOrderView[]> {
    if (!kitchen) {
      throw new ValidationError('Se requiere el parámetro kitchen.');
    }
    return this.kitchen.packingQueue(req.auth!.tid, { kitchenId: kitchen });
  }

  /**
   * Empaque con verificación (RN-KIT-03). Devuelve la marca para la etiqueta:
   * en un local multimarca, etiquetar con la marca equivocada es un error que
   * el cliente ve.
   */
  @Post('orders/:id/pack')
  @RequirePermission('kitchen.transition')
  pack(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PackResult> {
    const dto = parse(packSchema, body);
    return this.kitchen.packOrder(req.auth!.tid, id, {
      checkedLineIds: dto.checkedLineIds,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }
}
