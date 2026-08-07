import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import {
  OrganizationService,
  type CoverageResult,
} from '../app/organization.service.js';

/**
 * API de organización (spec 03). El tenant sale del token; ningún endpoint lo
 * acepta por query (RN-T01).
 */
@Controller({ path: '', version: '1' })
export class OrganizationController {
  constructor(private readonly org: OrganizationService) {}

  /**
   * GET /coverage?lat&lng&brand → zona aplicable o 404.
   * Criterio de aceptación de T3.12 (punto en frontera incluido).
   */
  @Get('coverage')
  @RequirePermission('tenant.read')
  async coverage(
    @Req() req: AuthenticatedRequest,
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('brand') brand?: string,
  ): Promise<CoverageResult> {
    if (lat === undefined || lng === undefined) {
      throw new ValidationError('Se requieren los parámetros lat y lng.');
    }
    const latNum = Number(lat);
    const lngNum = Number(lng);
    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      throw new ValidationError('lat y lng deben ser numéricos.');
    }

    const result = await this.org.findCoverage(
      req.auth!.tid,
      [lngNum, latNum],
      brand,
    );
    if (!result) {
      throw new NotFoundError(
        'No hay cobertura de delivery para esa ubicación.',
      );
    }
    return result;
  }

  /** GET /organization → estructura completa (empresas, marcas, locales, cocinas). */
  @Get('organization')
  @RequirePermission('tenant.read')
  structure(@Req() req: AuthenticatedRequest): Promise<{
    companies: unknown[];
    brands: unknown[];
    locations: unknown[];
    kitchens: unknown[];
  }> {
    return this.org.getStructure(req.auth!.tid);
  }

  /** GET /organization/open?location&brand&channel → si el local está abierto. */
  @Get('organization/open')
  @RequirePermission('tenant.read')
  async open(
    @Req() req: AuthenticatedRequest,
    @Query('location') location?: string,
    @Query('brand') brand?: string,
    @Query('channel') channel?: string,
  ): Promise<{ open: boolean; timezone: string; localTime: string }> {
    if (!location) {
      throw new ValidationError('Se requiere el parámetro location.');
    }
    return this.org.isOpen(req.auth!.tid, location, {
      ...(brand !== undefined ? { brandId: brand } : {}),
      ...(channel !== undefined ? { channel } : {}),
    });
  }
}
