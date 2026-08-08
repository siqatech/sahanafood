import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
import {
  CatalogAdminService,
  type CategoryView,
  type ModifierGroupView,
  type ModifierOptionView,
  type PriceView,
  type ProductView,
} from '../app/catalog-admin.service.js';

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

/**
 * Escritura de la carta (spec 04 «CRUD completo», salda DT-10).
 *
 * Controlador aparte del de lectura por la misma razón que el servicio: esto lo
 * usa quien configura el negocio, no el camino caliente de cada pedido.
 *
 * Todos los endpoints son **`POST` idempotentes por clave natural**, no `PUT`
 * con id: quien sube su carta desde una hoja de cálculo no conoce los UUID que
 * generó la base, conoce el SKU y el nombre de su plato. Volver a enviar la
 * misma carta actualiza precios y añade lo nuevo sin duplicar nada.
 */
@Controller({ path: 'catalog', version: '1' })
export class CatalogAdminController {
  constructor(private readonly admin: CatalogAdminService) {}

  @Post('categories')
  @RequirePermission('catalog.write')
  category(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CategoryView> {
    const input = parse(
      z.object({
        brandId: z.string().uuid(),
        name: z.string().min(1).max(120),
        sortOrder: z.number().int().min(0).max(9999).optional(),
        active: z.boolean().optional(),
      }),
      body,
    );
    return this.admin.upsertCategory(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  /**
   * Alta o edición de un plato. `If-Match` es **opcional** aquí, al revés que en
   * un pedido: subir la carta entera de golpe es el caso normal y exigir la
   * versión de cada producto lo haría imposible. Cuando viene —el panel editando
   * un plato concreto— se respeta y un desfase devuelve 409.
   */
  @Post('products')
  @RequirePermission('catalog.write')
  product(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ): Promise<ProductView> {
    const input = parse(
      z.object({
        brandId: z.string().uuid(),
        categoryId: z.string().uuid().nullish(),
        sku: z.string().max(60).optional(),
        name: z.string().min(1).max(160),
        description: z.string().max(1000).nullish(),
        imageUrl: z.string().url().max(500).nullish(),
        allergens: z.array(z.string().max(60)).max(30).optional(),
        prepMinutes: z.number().int().positive().max(600).optional(),
        isCombo: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
      body,
    );

    let expectedRowVersion: number | undefined;
    if (ifMatch !== undefined) {
      const version = Number(ifMatch);
      if (!Number.isInteger(version) || version < 1) {
        throw new ValidationError(
          'If-Match debe llevar la versión del producto (campo rowVersion).',
        );
      }
      expectedRowVersion = version;
    }

    return this.admin.upsertProduct(req.auth!.tid, {
      ...input,
      ...(expectedRowVersion !== undefined ? { expectedRowVersion } : {}),
      actorId: req.auth!.sub,
    });
  }

  /** Precio de un producto en un ámbito (RN-CAT-01). Incluye IGV (RN-T05). */
  @Post('prices')
  @RequirePermission('catalog.write')
  price(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PriceView> {
    const input = parse(
      z.object({
        productId: z.string().uuid(),
        // Nulo = precio base / todos los locales. Se distingue de "ausente"
        // para poder pedir explícitamente el ámbito más general.
        channel: z.string().min(1).max(40).nullish(),
        locationId: z.string().uuid().nullish(),
        // Unidades menores enteras: el importe no pasa por coma flotante ni
        // aquí ni en la base.
        priceMinor: z.number().int().min(0),
        active: z.boolean().optional(),
      }),
      body,
    );
    return this.admin.setPrice(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('modifier-groups')
  @RequirePermission('catalog.write')
  modifierGroup(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ModifierGroupView> {
    const input = parse(
      z.object({
        brandId: z.string().uuid(),
        name: z.string().min(1).max(120),
        minSelections: z.number().int().min(0).max(50).optional(),
        maxSelections: z.number().int().min(1).max(50).optional(),
        allowRepeat: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(9999).optional(),
      }),
      body,
    );
    return this.admin.upsertModifierGroup(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('modifier-options')
  @RequirePermission('catalog.write')
  modifierOption(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ModifierOptionView> {
    const input = parse(
      z.object({
        groupId: z.string().uuid(),
        name: z.string().min(1).max(120),
        // Sin mínimo: «sin papas» descuenta y el delta es negativo.
        priceDeltaMinor: z.number().int().optional(),
        available: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(9999).optional(),
      }),
      body,
    );
    return this.admin.upsertModifierOption(req.auth!.tid, {
      ...input,
      actorId: req.auth!.sub,
    });
  }

  @Post('products/:id/modifier-groups')
  @RequirePermission('catalog.write')
  async linkGroup(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(
      z.object({
        groupId: z.string().uuid(),
        sortOrder: z.number().int().min(0).max(9999).optional(),
      }),
      body,
    );
    await this.admin.linkProductModifierGroup(req.auth!.tid, {
      productId: id,
      ...input,
      actorId: req.auth!.sub,
    });
    return { ok: true };
  }

  @Delete('products/:id/modifier-groups/:groupId')
  @RequirePermission('catalog.write')
  async unlinkGroup(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
  ): Promise<{ ok: true }> {
    await this.admin.unlinkProductModifierGroup(req.auth!.tid, {
      productId: id,
      groupId,
      actorId: req.auth!.sub,
    });
    return { ok: true };
  }

  /** Composición de un combo (RN-CAT-04). Reemplaza la lista entera. */
  @Post('products/:id/combo')
  @RequirePermission('catalog.write')
  async combo(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = parse(
      z.object({
        components: z
          .array(
            z.object({
              productId: z.string().uuid(),
              quantity: z.number().int().positive().max(99),
            }),
          )
          .max(50),
      }),
      body,
    );
    await this.admin.setComboComponents(req.auth!.tid, {
      comboId: id,
      components: input.components,
      actorId: req.auth!.sub,
    });
    return { ok: true };
  }
}
