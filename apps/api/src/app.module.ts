import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { TraceMiddleware } from './common/trace.middleware.js';
import { HealthModule } from './modules/health/index.js';
import { IdentityModule } from './modules/identity/index.js';
import { TenancyModule } from './modules/tenancy/index.js';
import { AuditModule } from './modules/audit/index.js';
import { OrganizationModule } from './modules/organization/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { OrderingModule } from './modules/ordering/index.js';
import { IntegrationsModule } from './modules/integrations/index.js';
import { KitchenModule } from './modules/kitchen/index.js';
import { InventoryModule } from './modules/inventory/index.js';
import { BillingModule } from './modules/billing/index.js';
import { PaymentsModule } from './modules/payments/index.js';
import { CommonModule } from './common/common.module.js';
import { MessagingModule } from './modules/messaging/index.js';
import { AnalyticsModule } from './modules/analytics/index.js';
import { CashModule } from './modules/cash/index.js';
import { StorefrontModule } from './modules/storefront/index.js';
import { DeliveryModule } from './modules/delivery/index.js';
import { ObservabilityModule } from './observability/observability.module.js';

/**
 * Módulo raíz del monolito modular. Los módulos de negocio (tenancy, identity,
 * organization, audit...) se irán añadiendo aquí, cada uno exponiendo su API
 * pública por su `index.ts` (fronteras verificadas por dependency-cruiser).
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Correlaciona cada log con el trace_id del request.
        customProps: (req) => ({
          traceId: (req as { traceId?: string }).traceId,
        }),
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        // En desarrollo, salida legible; en producción, JSON estructurado.
        ...(process.env.NODE_ENV === 'development'
          ? {
              transport: {
                target: 'pino-pretty',
                options: { singleLine: true },
              },
            }
          : {}),
      },
    }),
    DatabaseModule,
    HealthModule,
    IdentityModule,
    TenancyModule,
    AuditModule,
    OrganizationModule,
    CatalogModule,
    OrderingModule,
    IntegrationsModule,
    KitchenModule,
    InventoryModule,
    CommonModule,
    BillingModule,
    PaymentsModule,
    MessagingModule,
    AnalyticsModule,
    CashModule,
    StorefrontModule,
    DeliveryModule,
    ObservabilityModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // El trace_id se asigna antes que cualquier otra cosa.
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
