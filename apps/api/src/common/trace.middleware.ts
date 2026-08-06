import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { ulid } from 'ulid';

/**
 * Asigna un trace_id por request (ULID, ordenable por tiempo). Se propaga a los
 * logs y a las respuestas Problem Details, y viaja al outbox/worker para poder
 * seguir una petición de punta a punta (gate de observabilidad T3.14).
 * Respeta un `x-request-id` entrante si el borde ya lo asignó.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(
    req: Request & { traceId?: string },
    res: Response,
    next: NextFunction,
  ): void {
    const incoming = req.header('x-request-id');
    const traceId = incoming && incoming.length <= 64 ? incoming : ulid();
    req.traceId = traceId;
    res.setHeader('x-request-id', traceId);
    next();
  }
}
