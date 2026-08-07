import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { httpRequestDuration, httpRequestsTotal } from './metrics.js';

/**
 * Alimenta las métricas HTTP. Se registra globalmente.
 *
 * Detalle importante: se etiqueta con el PATRÓN de ruta (`/api/v1/devices/:id`)
 * y no con la URL concreta. Usar la URL real haría que cada id generase su
 * propia serie temporal y Prometheus acabaría con millones de series inútiles.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { route?: { path?: string } }>();
    const res = http.getResponse<Response>();
    const start = process.hrtime.bigint();

    const record = (): void => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path ?? req.path ?? 'desconocida';
      const labels = {
        method: req.method,
        route,
        status: String(res.statusCode),
      };
      httpRequestDuration.observe(labels, seconds);
      httpRequestsTotal.inc(labels);
    };

    // `tap` cubre el camino feliz; el de error se cubre con el segundo callback,
    // porque una petición que falla también consume latencia y debe medirse.
    return next.handle().pipe(
      tap({
        next: record,
        error: record,
      }),
    );
  }
}
