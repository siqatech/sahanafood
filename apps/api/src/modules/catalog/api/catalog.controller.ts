import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import {
  CatalogService,
  type ResolvedCatalog,
} from '../app/catalog.service.js';

/** Endpoints de catálogo (spec 04). */

const pauseSchema = z.object({
  channels: z.array(z.string().min(1)).min(1, 'Indica al menos un canal.'),
  until: z.string().datetime().optional(),
  reason: z.string().optional(),
});

const resumeSchema = z.object({
  channels: z.array(z.string().min(1)).min(1, 'Indica al menos un canal.'),
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

@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Catálogo resuelto para un canal: lo que consumen tienda, POS y agente IA.
   * El precio ya viene resuelto; ningún cliente lo calcula por su cuenta.
   */
  @Get('resolved')
  @RequirePermission('catalog.read')
  async resolved(
    @Req() req: AuthenticatedRequest,
    @Query('brand') brand?: string,
    @Query('channel') channel?: string,
    @Query('location') location?: string,
  ): Promise<ResolvedCatalog> {
    if (!brand || !channel) {
      throw new ValidationError('Se requieren los parámetros brand y channel.');
    }
    return this.catalog.getResolvedCatalog(req.auth!.tid, {
      brandId: brand,
      channel,
      ...(location !== undefined ? { locationId: location } : {}),
    });
  }

  /** Pausa un producto en uno o varios canales (RN-CAT-03). */
  @Post('products/:id/pause')
  @RequirePermission('catalog.write')
  async pause(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const dto = parse(pauseSchema, body);
    await this.catalog.pauseProduct(req.auth!.tid, id, {
      channels: dto.channels,
      ...(dto.until !== undefined ? { until: new Date(dto.until) } : {}),
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
    return { ok: true };
  }

  /** Reactiva un producto pausado. */
  @Post('products/:id/resume')
  @RequirePermission('catalog.write')
  async resume(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const dto = parse(resumeSchema, body);
    await this.catalog.resumeProduct(req.auth!.tid, id, {
      channels: dto.channels,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
    return { ok: true };
  }
}
