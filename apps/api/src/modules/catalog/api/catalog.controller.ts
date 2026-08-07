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
import {
  CatalogPublicationService,
  type PublishedVersion,
  type PublishedVersionWithSnapshot,
} from '../app/catalog-publication.service.js';

/** Endpoints de catálogo (spec 04). */

const pauseSchema = z.object({
  channels: z.array(z.string().min(1)).min(1, 'Indica al menos un canal.'),
  until: z.string().datetime().optional(),
  reason: z.string().optional(),
});

const resumeSchema = z.object({
  channels: z.array(z.string().min(1)).min(1, 'Indica al menos un canal.'),
});

const publishSchema = z.object({
  brandId: z.string().uuid(),
  channel: z.string().min(1),
  locationId: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
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
  constructor(
    private readonly catalog: CatalogService,
    private readonly publication: CatalogPublicationService,
  ) {}

  /**
   * Congela el catálogo vigente del canal como versión inmutable (RN-CAT-02).
   * Publicar NO bloquea ventas: solo inserta una fila, sin tocar productos ni
   * precios ni tomar cerrojos sobre ellos.
   */
  @Post('publish')
  @RequirePermission('catalog.write')
  publish(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PublishedVersion> {
    const dto = parse(publishSchema, body);
    return this.publication.publish(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /** Historial de versiones de un canal. */
  @Get('versions')
  @RequirePermission('catalog.read')
  versions(
    @Req() req: AuthenticatedRequest,
    @Query('brand') brand?: string,
    @Query('channel') channel?: string,
    @Query('limit') limit?: string,
  ): Promise<PublishedVersion[]> {
    if (!brand || !channel) {
      throw new ValidationError('Se requieren los parámetros brand y channel.');
    }
    return this.publication.listVersions(req.auth!.tid, {
      brandId: brand,
      channel,
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  /**
   * Descarga una versión publicada (la última si no se indica número). Es lo
   * que el POS guarda en disco para poder vender sin red.
   */
  @Get('versions/download')
  @RequirePermission('catalog.read')
  downloadVersion(
    @Req() req: AuthenticatedRequest,
    @Query('brand') brand?: string,
    @Query('channel') channel?: string,
    @Query('version') version?: string,
  ): Promise<PublishedVersionWithSnapshot> {
    if (!brand || !channel) {
      throw new ValidationError('Se requieren los parámetros brand y channel.');
    }
    if (version !== undefined && !/^\d+$/.test(version)) {
      throw new ValidationError('version debe ser un entero positivo.');
    }
    return this.publication.getVersion(req.auth!.tid, {
      brandId: brand,
      channel,
      ...(version !== undefined ? { version: Number(version) } : {}),
    });
  }

  /**
   * Diferencias entre dos versiones. El POS descarga esto al reconectar en vez
   * del catálogo entero.
   */
  @Get('versions/diff')
  @RequirePermission('catalog.read')
  diffVersions(
    @Req() req: AuthenticatedRequest,
    @Query('brand') brand?: string,
    @Query('channel') channel?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    if (!brand || !channel || !from || !to) {
      throw new ValidationError(
        'Se requieren los parámetros brand, channel, from y to.',
      );
    }
    const desde = Number(from);
    const hasta = Number(to);
    if (!Number.isInteger(desde) || !Number.isInteger(hasta)) {
      throw new ValidationError('from y to deben ser números de versión.');
    }
    return this.publication.diff(req.auth!.tid, {
      brandId: brand,
      channel,
      from: desde,
      to: hasta,
    });
  }

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
