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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // El trace_id se asigna antes que cualquier otra cosa.
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
