/** API pública del módulo Analytics (spec 16 parcial). */
export { AnalyticsModule } from './analytics.module.js';
export {
  AnalyticsService,
  type BrandChannelProfitability,
  type ReconciliationResult,
  type TodaySummary,
  type TodaySlice,
} from './app/analytics.service.js';
export {
  AnalyticsEventHandlers,
  ANALYTICS_CONSUMER,
} from './app/analytics-event-handlers.js';
