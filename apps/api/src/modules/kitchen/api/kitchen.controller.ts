import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import { KitchenService, type TicketView } from '../app/kitchen.service.js';

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
  constructor(private readonly kitchen: KitchenService) {}

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
