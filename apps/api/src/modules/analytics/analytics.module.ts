import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AnalyticsService } from './app/analytics.service.js';
import { AnalyticsEventHandlers } from './app/analytics-event-handlers.js';
import { AnalyticsController } from './api/analytics.controller.js';

/**
 * Analítica básica (spec 16, fase 4).
 *
 * Lee de PROYECCIONES alimentadas por eventos y nunca de las tablas
 * transaccionales en caliente: un `GROUP BY` sobre `ord_orders` en hora punta
 * compite por las mismas filas que están cerrando pedidos.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsEventHandlers],
  exports: [AnalyticsService, AnalyticsEventHandlers],
})
export class AnalyticsModule {}
