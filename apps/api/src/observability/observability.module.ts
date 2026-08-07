import {
  Controller,
  Get,
  Inject,
  Module,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { withSystem } from '../database/rls.js';
import {
  METRICS_CONTENT_TYPE,
  outboxOldestPendingSeconds,
  outboxPending,
  renderMetrics,
} from './metrics.js';
import { MetricsInterceptor } from './metrics.interceptor.js';

/**
 * Exposición de métricas (T3.14).
 *
 * `/metrics` NO lleva `@RequirePermission`: Prometheus raspa sin credenciales de
 * usuario. La protección correcta es de red —el endpoint no se publica en el
 * ingress público, solo es alcanzable desde la red interna— y así queda
 * documentado para el despliegue. Las métricas no contienen datos de tenant.
 */
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async metrics(@Res() res: Response): Promise<void> {
    // Los gauges del outbox se refrescan en el momento del raspado: son estado
    // actual, no acumulados, y consultarlos aquí evita un temporizador propio.
    await this.refreshOutboxGauges();
    res.setHeader('content-type', METRICS_CONTENT_TYPE);
    res.send(await renderMetrics());
  }

  private async refreshOutboxGauges(): Promise<void> {
    try {
      await withSystem(this.pool, async ({ client }) => {
        const { rows } = await client.query<{
          pending: string;
          oldest_seconds: string | null;
        }>(
          `SELECT count(*)::text AS pending,
                  EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS oldest_seconds
             FROM outbox WHERE published_at IS NULL`,
        );
        outboxPending.set(Number(rows[0]?.pending ?? 0));
        outboxOldestPendingSeconds.set(Number(rows[0]?.oldest_seconds ?? 0));
      });
    } catch {
      // Si la BD no responde, se sirven el resto de métricas igualmente: un
      // fallo del raspado no debe dejar ciega toda la observabilidad.
    }
  }
}

@Module({
  controllers: [MetricsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
})
export class ObservabilityModule {}
