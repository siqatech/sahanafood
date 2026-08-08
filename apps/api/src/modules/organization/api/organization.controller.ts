import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Ring, Schedule } from '@sahana/domain';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import {
  OrganizationService,
  type CoverageResult,
} from '../app/organization.service.js';
import {
  OrganizationAdminService,
  type BrandView,
  type CompanyView,
  type LocationView,
  type ZoneView,
} from '../app/organization-admin.service.js';

/** Validación de cuerpo con Problem Details, igual que el resto de módulos. */
function parseOrg<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => i.message).join(' '),
      { errors: result.error.issues },
    );
  }
  return result.data;
}

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

/**
 * Escritura de la estructura del negocio (spec 03, DT-10).
 *
 * Controlador aparte del de lectura porque su permiso es otro y su público es
 * otro: `/coverage` lo consulta la tienda en cada carrito; esto lo usa el dueño
 * al configurar. Rutas bajo `/org` para no colgarlas de la raíz.
 */
@Controller({ path: 'org', version: '1' })
export class OrganizationAdminController {
  constructor(private readonly admin: OrganizationAdminService) {}

  @Post('companies')
  @RequirePermission('org.write')
  async company(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CompanyView> {
    const input = parseOrg(
      z.object({
        legalName: z.string().min(1).max(200),
        // Sin longitud mínima aquí a propósito: quien valida el RUC es el
        // servicio, y su mensaje dice «son 11 dígitos». Un «String must
        // contain at least 8 characters» no le sirve a nadie.
        taxId: z.string().min(1).max(20),
        address: z.string().max(300).optional(),
      }),
      body,
    );
    return this.admin.upsertCompany(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('brands')
  @RequirePermission('org.write')
  async brand(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<BrandView> {
    const input = parseOrg(
      z.object({
        companyId: z.string().uuid(),
        name: z.string().min(1).max(120),
        slug: z.string().max(80).optional(),
        active: z.boolean().optional(),
      }),
      body,
    );
    return this.admin.upsertBrand(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('locations')
  @RequirePermission('org.write')
  async location(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<LocationView> {
    const input = parseOrg(
      z.object({
        companyId: z.string().uuid(),
        name: z.string().min(1).max(120),
        address: z.string().min(1).max(300),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
        timezone: z.string().max(60).optional(),
        active: z.boolean().optional(),
      }),
      body,
    );
    return this.admin.upsertLocation(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('kitchens')
  @RequirePermission('org.write')
  async kitchen(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; name: string }> {
    const input = parseOrg(
      z.object({
        locationId: z.string().uuid(),
        name: z.string().min(1).max(120),
      }),
      body,
    );
    return this.admin.upsertKitchen(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('brand-kitchens')
  @RequirePermission('org.write')
  async link(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parseOrg(
      z.object({
        brandId: z.string().uuid(),
        kitchenId: z.string().uuid(),
      }),
      body,
    );
    await this.admin.linkBrandKitchen(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
    return { ok: true };
  }

  @Post('stations')
  @RequirePermission('org.write')
  async station(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string; name: string }> {
    const input = parseOrg(
      z.object({
        kitchenId: z.string().uuid(),
        name: z.string().min(1).max(120),
        sortOrder: z.number().int().min(0).max(999).optional(),
      }),
      body,
    );
    return this.admin.upsertStation(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('zones')
  @RequirePermission('org.write')
  async zone(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ZoneView> {
    const input = parseOrg(
      z.object({
        locationId: z.string().uuid(),
        brandId: z.string().uuid().nullish(),
        name: z.string().min(1).max(120),
        // El polígono llega como [[lng,lat], …]. El rectángulo envolvente NO
        // se acepta: lo calcula el servidor, siempre (ver el servicio).
        polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
        deliveryFeeMinor: z.number().int().min(0).optional(),
        minOrderMinor: z.number().int().min(0).optional(),
        baseMinutes: z.number().int().positive().max(600).optional(),
        active: z.boolean().optional(),
      }),
      body,
    );
    return this.admin.upsertZone(req.auth!.tid, {
      ...input,
      polygon: input.polygon as unknown as Ring,
      actorId: req.auth!.sub,
    });
  }

  @Post('schedules')
  @RequirePermission('org.write')
  async schedule(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ id: string }> {
    // La forma es la del dominio, no una propia: `{opensAt, closesAt}` y una
    // franja por día. Traducir aquí a otra forma obligaría a mantener dos
    // vocabularios de horario y a que alguien acertase la conversión.
    const rango = z.object({
      opensAt: z.string().regex(/^\d{2}:\d{2}$/),
      closesAt: z.string().regex(/^\d{2}:\d{2}$/),
    });
    const input = parseOrg(
      z.object({
        locationId: z.string().uuid(),
        brandId: z.string().uuid().nullish(),
        channel: z.string().max(30).nullish(),
        weekly: z.array(
          rango.extend({ weekday: z.number().int().min(0).max(6) }),
        ),
        exceptions: z
          .array(
            z.object({
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              ranges: z.array(rango),
            }),
          )
          .optional(),
      }),
      body,
    );
    return this.admin.upsertSchedule(req.auth!.tid, {
      locationId: input.locationId,
      brandId: input.brandId,
      channel: input.channel,
      schedule: {
        weekly: input.weekly as Schedule['weekly'],
        ...(input.exceptions ? { exceptions: input.exceptions } : {}),
      },
      actorId: req.auth!.sub,
    });
  }
}
