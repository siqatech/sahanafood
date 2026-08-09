import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  AnalyticsService,
  type BrandChannelProfitability,
  type ReconciliationResult,
  type TodaySummary,
} from '../app/analytics.service.js';

/**
 * Analítica (spec 16, fase 4).
 *
 * Solo lectura. Los números se alimentan por eventos, no por llamadas: un
 * endpoint que recalculara la proyección al consultarla sería exactamente el
 * `GROUP BY` en caliente que la spec prohíbe.
 */
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * «¿Cómo vamos hoy?»: lo primero que ve el dueño al abrir el panel.
   *
   * Sin parámetros a propósito. El día se corta en la zona del local y no en
   * UTC —un pedido de las 23:40 en Lima es del día 7, no del 8—, así que
   * dejar que el cliente mande la fecha solo serviría para que el panel y la
   * conciliación hablaran de días distintos.
   */
  @Get('today')
  @RequirePermission('reports.read')
  today(@Req() req: AuthenticatedRequest): Promise<TodaySummary> {
    return this.analytics.today(req.auth!.tid);
  }

  /**
   * Rentabilidad por marca y canal.
   *
   * Es la pregunta que justifica una dark kitchen: cuatro marcas en la misma
   * cocina y saber cuál gana dinero por cuál canal.
   */
  @Get('profitability')
  @RequirePermission('reports.read')
  profitability(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('brand') brand?: string,
  ): Promise<BrandChannelProfitability[]> {
    const hasta = to ? new Date(to) : new Date();
    const desde = from
      ? new Date(from)
      : new Date(hasta.getTime() - 30 * 24 * 3_600_000);

    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      throw new ValidationError('Fechas inválidas: usa formato ISO 8601.');
    }

    return this.analytics.profitability(req.auth!.tid, {
      from: desde,
      to: hasta,
      ...(brand ? { brandId: brand } : {}),
    });
  }

  /**
   * Conciliación con Billing del día indicado.
   *
   * La spec 16 lo dice sin matices: una divergencia es un **bug crítico**. Un
   * panel que dice S/ 12 000 y una declaración que dice S/ 11 400 no es un
   * problema de redondeo: es que alguien va a decidir con un número inventado.
   */
  @Get('reconciliation')
  @RequirePermission('reports.read')
  reconciliation(
    @Req() req: AuthenticatedRequest,
    @Query('date') date?: string,
  ): Promise<ReconciliationResult> {
    // `?date=2026-01-15` es un DÍA, no un instante, y se pasa tal cual.
    // Convertirlo con `new Date(...)` lo interpreta como medianoche UTC —las
    // 19:00 del día anterior en Lima— y la conciliación acabaría respondiendo
    // por la víspera mientras enseña la fecha pedida. Sin `date`, se concilia
    // «ahora», y ahí sí hay que deducir el día en la zona del local.
    if (date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new ValidationError('Fecha inválida: usa el formato AAAA-MM-DD.');
      }
      return this.analytics.reconcileWithBilling(req.auth!.tid, date);
    }
    return this.analytics.reconcileWithBilling(req.auth!.tid, new Date());
  }
}
