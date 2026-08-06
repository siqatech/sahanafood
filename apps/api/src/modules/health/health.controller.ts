import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Health check. `/health` es liveness (¿el proceso responde?). Incluye el
 * trace_id para verificar la cadena de observabilidad de punta a punta.
 */
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  health(@Req() req: Request & { traceId?: string }): {
    status: 'ok';
    traceId: string | undefined;
    uptimeSeconds: number;
    version: string;
  } {
    return {
      status: 'ok',
      traceId: req.traceId,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}
