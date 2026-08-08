import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  boundingBox,
  GeoError,
  ScheduleError,
  isOpenAt,
  toLocalMoment,
  type Ring,
  type Schedule,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Alta y edición de la estructura del negocio (spec 03, salda parte de DT-10).
 *
 * Existe porque **faltaba entera**. La spec 03 pide «CRUD empresas / marcas /
 * locales / cocinas / estaciones / almacenes / zonas / horarios» y solo se
 * había construido la mitad de LECTURA: cobertura, estructura y horarios. Las
 * únicas escrituras del sistema eran las semillas demo, con SQL directo y
 * siempre la misma pollería ficticia. Un cliente nuevo no podía crear ni su
 * marca.
 *
 * Va en un servicio aparte de `OrganizationService` a propósito: aquel lo
 * consultan Ordering, Catalog, Delivery y la tienda en cada pedido, y es
 * código caliente. Esto se usa al configurar el negocio y al cambiarlo, que
 * son minutos al mes.
 *
 * **Todo lo de aquí es idempotente por clave natural.** No es comodidad: una
 * configuración se aplica varias veces —se corrige un precio, se añade un
 * local, se vuelve a lanzar el alta de un cliente— y una segunda pasada que
 * duplica marcas deja un negocio con dos cartas y ningún modo de saber cuál
 * cobra. La clave natural es la que el dueño reconoce: el RUC de su empresa,
 * el `slug` de su marca, el nombre de su local.
 */

export interface CompanyView {
  id: string;
  legalName: string;
  taxId: string;
  address: string | null;
}

export interface BrandView {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  active: boolean;
}

export interface LocationView {
  id: string;
  companyId: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  timezone: string;
  active: boolean;
}

export interface ZoneView {
  id: string;
  locationId: string;
  brandId: string | null;
  name: string;
  /** Importes como cadena decimal: no pasan por coma flotante en ningún punto. */
  deliveryFee: string;
  minOrder: string;
  baseMinutes: number;
  active: boolean;
}

@Injectable()
export class OrganizationAdminService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ------------------------------------------------------------- Empresa

  /**
   * La empresa que factura. Clave natural: el **RUC**.
   *
   * Un tenant puede tener varias (un grupo con dos razones sociales), y el RUC
   * es lo que las distingue de verdad — dos empresas pueden llamarse casi
   * igual y emitir comprobantes distintos.
   */
  async upsertCompany(
    tenantId: string,
    input: {
      legalName: string;
      taxId: string;
      address?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<CompanyView> {
    const taxId = input.taxId.replace(/\D/g, '');
    if (taxId.length !== 11) {
      // Longitud del catálogo de SUNAT. Se valida aquí y no solo en el
      // comprobante porque un RUC mal escrito se descubre, si no, el día que
      // el OSE rechaza la primera boleta — con el cliente ya delante.
      throw new ValidationError(
        `"${input.taxId}" no es un RUC válido: son 11 dígitos.`,
      );
    }
    if (!input.legalName.trim()) {
      throw new ValidationError('La razón social no puede ir vacía.');
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        legal_name: string;
        tax_id: string;
        address: string | null;
      }>(
        `INSERT INTO org_companies (tenant_id, legal_name, tax_id, address)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, tax_id) DO UPDATE
           SET legal_name = EXCLUDED.legal_name,
               address = COALESCE(EXCLUDED.address, org_companies.address),
               updated_at = now()
         RETURNING id, legal_name, tax_id, address`,
        [tenantId, input.legalName.trim(), taxId, input.address ?? null],
      );
      const fila = rows[0]!;
      await this.auditar(
        ctx,
        input.actorId,
        'org.company_upserted',
        'company',
        fila.id,
        {
          taxId,
        },
      );
      return {
        id: fila.id,
        legalName: fila.legal_name,
        taxId: fila.tax_id,
        address: fila.address,
      };
    });
  }

  // --------------------------------------------------------------- Marca

  /** Marca comercial. Clave natural: el `slug`, que además es único por tenant. */
  async upsertBrand(
    tenantId: string,
    input: {
      companyId: string;
      name: string;
      slug?: string | undefined;
      active?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<BrandView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('La marca necesita un nombre.');
    const slug = (input.slug ?? nombre)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) {
      throw new ValidationError(
        `No se puede derivar un identificador de "${input.name}"; indica uno con "slug".`,
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeEmpresa(ctx, input.companyId);
      const { rows } = await ctx.client.query<{
        id: string;
        company_id: string;
        name: string;
        slug: string;
        active: boolean;
      }>(
        `INSERT INTO org_brands (tenant_id, company_id, name, slug, active)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, slug) DO UPDATE
           SET name = EXCLUDED.name,
               company_id = EXCLUDED.company_id,
               active = EXCLUDED.active,
               updated_at = now()
         RETURNING id, company_id, name, slug, active`,
        [tenantId, input.companyId, nombre, slug, input.active ?? true],
      );
      const fila = rows[0]!;
      await this.auditar(
        ctx,
        input.actorId,
        'org.brand_upserted',
        'brand',
        fila.id,
        {
          slug,
        },
      );
      return {
        id: fila.id,
        companyId: fila.company_id,
        name: fila.name,
        slug: fila.slug,
        active: fila.active,
      };
    });
  }

  // --------------------------------------------------------------- Local

  /** Local físico. Clave natural: el nombre dentro de la empresa. */
  async upsertLocation(
    tenantId: string,
    input: {
      companyId: string;
      name: string;
      address: string;
      lat?: number | undefined;
      lng?: number | undefined;
      timezone?: string | undefined;
      active?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<LocationView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('El local necesita un nombre.');
    if (!input.address.trim()) {
      throw new ValidationError('El local necesita una dirección.');
    }
    // Las coordenadas van juntas o no van: una sola deja un local que la
    // cobertura no puede situar y que nadie sabe que está a medio configurar.
    if ((input.lat === undefined) !== (input.lng === undefined)) {
      throw new ValidationError(
        'Indica latitud y longitud, o ninguna de las dos.',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeEmpresa(ctx, input.companyId);
      const { rows: existente } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM org_locations WHERE company_id = $1 AND lower(name) = lower($2)',
        [input.companyId, nombre],
      );

      const fila = existente[0]
        ? (
            await ctx.client.query<FilaLocal>(
              `UPDATE org_locations
                  SET address = $2, lat = COALESCE($3, lat), lng = COALESCE($4, lng),
                      timezone = $5, active = $6, updated_at = now()
                WHERE id = $1
                RETURNING id, company_id, name, address, lat, lng, timezone, active`,
              [
                existente[0].id,
                input.address.trim(),
                input.lat ?? null,
                input.lng ?? null,
                input.timezone ?? 'America/Lima',
                input.active ?? true,
              ],
            )
          ).rows[0]!
        : (
            await ctx.client.query<FilaLocal>(
              `INSERT INTO org_locations
                 (tenant_id, company_id, name, address, lat, lng, timezone, active)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               RETURNING id, company_id, name, address, lat, lng, timezone, active`,
              [
                tenantId,
                input.companyId,
                nombre,
                input.address.trim(),
                input.lat ?? null,
                input.lng ?? null,
                input.timezone ?? 'America/Lima',
                input.active ?? true,
              ],
            )
          ).rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'org.location_upserted',
        'location',
        fila.id,
        {
          name: nombre,
        },
      );
      return {
        id: fila.id,
        companyId: fila.company_id,
        name: fila.name,
        address: fila.address,
        lat: fila.lat,
        lng: fila.lng,
        timezone: fila.timezone,
        active: fila.active,
      };
    });
  }

  // ------------------------------------------------------------- Cocina

  /** Cocina de un local. Clave natural: el nombre dentro del local. */
  async upsertKitchen(
    tenantId: string,
    input: {
      locationId: string;
      name: string;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; name: string }> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('La cocina necesita un nombre.');

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeLocal(ctx, input.locationId);
      const { rows: existente } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM org_kitchens WHERE location_id = $1 AND lower(name) = lower($2)',
        [input.locationId, nombre],
      );
      if (existente[0]) return { id: existente[0].id, name: nombre };

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO org_kitchens (tenant_id, location_id, name)
         VALUES ($1,$2,$3) RETURNING id`,
        [tenantId, input.locationId, nombre],
      );
      await this.auditar(
        ctx,
        input.actorId,
        'org.kitchen_created',
        'kitchen',
        rows[0]!.id,
        {
          name: nombre,
        },
      );
      return { id: rows[0]!.id, name: nombre };
    });
  }

  /**
   * Une una marca con una cocina (M:N).
   *
   * Es la relación que define una dark kitchen: varias marcas produciéndose en
   * la misma cocina, y una marca que puede producirse en varias. Sin esta
   * unión un pedido no encuentra dónde cocinarse y `submit` lo rechaza.
   */
  async linkBrandKitchen(
    tenantId: string,
    input: { brandId: string; kitchenId: string; actorId?: string | undefined },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        `INSERT INTO org_brand_kitchens (tenant_id, brand_id, kitchen_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, brand_id, kitchen_id) DO UPDATE SET active = true`,
        [tenantId, input.brandId, input.kitchenId],
      );
      if (!rowCount) throw new NotFoundError('Marca o cocina no encontrada.');
      await this.auditar(
        ctx,
        input.actorId,
        'org.brand_kitchen_linked',
        'kitchen',
        input.kitchenId,
        { brandId: input.brandId },
      );
    });
  }

  /** Estación de una cocina. Clave natural: el nombre dentro de la cocina. */
  async upsertStation(
    tenantId: string,
    input: {
      kitchenId: string;
      name: string;
      sortOrder?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string; name: string }> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('La estación necesita un nombre.');

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO org_stations (tenant_id, kitchen_id, name, sort_order)
         SELECT $1,$2,$3,$4
          WHERE EXISTS (SELECT 1 FROM org_kitchens WHERE id = $2)
            AND NOT EXISTS (
              SELECT 1 FROM org_stations
               WHERE kitchen_id = $2 AND lower(name) = lower($3)
            )
         RETURNING id`,
        [tenantId, input.kitchenId, nombre, input.sortOrder ?? 0],
      );
      if (rows[0]) {
        await this.auditar(
          ctx,
          input.actorId,
          'org.station_created',
          'station',
          rows[0].id,
          {
            name: nombre,
          },
        );
        return { id: rows[0].id, name: nombre };
      }

      const { rows: yaEsta } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM org_stations WHERE kitchen_id = $1 AND lower(name) = lower($2)',
        [input.kitchenId, nombre],
      );
      if (!yaEsta[0]) throw new NotFoundError('Cocina no encontrada.');
      return { id: yaEsta[0].id, name: nombre };
    });
  }

  // ---------------------------------------------------------------- Zona

  /**
   * Zona de reparto. Clave natural: el nombre dentro del local.
   *
   * **El rectángulo envolvente lo calcula el servidor**, siempre, con la misma
   * función del dominio que usa la consulta de cobertura. No se acepta del
   * cliente ni aunque lo mande: un `bbox` que no encierre al polígono hace que
   * la cobertura mienta —direcciones dentro de la zona que se rechazan, o al
   * revés— y el error sería invisible hasta que un cliente reclame.
   */
  async upsertZone(
    tenantId: string,
    input: {
      locationId: string;
      brandId?: string | null | undefined;
      name: string;
      polygon: Ring;
      deliveryFeeMinor?: number | undefined;
      minOrderMinor?: number | undefined;
      baseMinutes?: number | undefined;
      active?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ZoneView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('La zona necesita un nombre.');

    let caja;
    try {
      caja = boundingBox(input.polygon);
    } catch (error) {
      if (error instanceof GeoError) {
        throw new ValidationError(`El polígono no es válido: ${error.message}`);
      }
      throw error;
    }

    const minutos = input.baseMinutes ?? 30;
    if (!Number.isInteger(minutos) || minutos <= 0) {
      throw new ValidationError(
        'Los minutos base tienen que ser un entero positivo.',
      );
    }

    // Dinero como `Money` y nunca como número: la tarifa de envío y el mínimo
    // de pedido son importes que el cliente paga.
    const tarifa = Money.fromMinor(input.deliveryFeeMinor ?? 0);
    const minimo = Money.fromMinor(input.minOrderMinor ?? 0);

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeLocal(ctx, input.locationId);
      const { rows: existente } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM org_zones WHERE location_id = $1 AND lower(name) = lower($2)',
        [input.locationId, nombre],
      );

      const valores = [
        input.brandId ?? null,
        JSON.stringify(input.polygon),
        caja.minLng,
        caja.minLat,
        caja.maxLng,
        caja.maxLat,
        tarifa.toDecimalString(),
        minimo.toDecimalString(),
        minutos,
        input.active ?? true,
      ];

      const fila = existente[0]
        ? (
            await ctx.client.query<FilaZona>(
              `UPDATE org_zones
                  SET brand_id = $2, polygon = $3::jsonb, min_lng = $4, min_lat = $5,
                      max_lng = $6, max_lat = $7, delivery_fee = $8, min_order = $9,
                      base_minutes = $10, active = $11, updated_at = now()
                WHERE id = $1
                RETURNING id, location_id, brand_id, name, delivery_fee, min_order,
                          base_minutes, active`,
              [existente[0].id, ...valores],
            )
          ).rows[0]!
        : (
            await ctx.client.query<FilaZona>(
              `INSERT INTO org_zones
                 (tenant_id, location_id, name, brand_id, polygon, min_lng, min_lat,
                  max_lng, max_lat, delivery_fee, min_order, base_minutes, active)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)
               RETURNING id, location_id, brand_id, name, delivery_fee, min_order,
                         base_minutes, active`,
              [tenantId, input.locationId, nombre, ...valores],
            )
          ).rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'org.zone_upserted',
        'zone',
        fila.id,
        {
          name: nombre,
          deliveryFee: tarifa.toDecimalString(),
        },
      );

      return {
        id: fila.id,
        locationId: fila.location_id,
        brandId: fila.brand_id,
        name: fila.name,
        deliveryFee: fila.delivery_fee,
        minOrder: fila.min_order,
        baseMinutes: fila.base_minutes,
        active: fila.active,
      };
    });
  }

  // ------------------------------------------------------------- Horario

  /**
   * Horario de atención. Clave natural: (local, marca, canal).
   *
   * Se valida con la MISMA función del dominio que decide si el local está
   * abierto. Guardar un horario que el evaluador no sabe leer produce un local
   * cerrado a mediodía sin que nada falle: la consulta devuelve «no abierto» y
   * nadie sabe por qué.
   */
  async upsertSchedule(
    tenantId: string,
    input: {
      locationId: string;
      brandId?: string | null | undefined;
      channel?: string | null | undefined;
      schedule: Schedule;
      actorId?: string | undefined;
    },
  ): Promise<{ id: string }> {
    try {
      // Una evaluación de prueba: si el horario es inválido, el dominio lanza
      // aquí y no el martes a las dos de la tarde.
      isOpenAt(input.schedule, toLocalMoment(new Date(), 'America/Lima'));
    } catch (error) {
      if (error instanceof ScheduleError) {
        throw new ValidationError(`El horario no es válido: ${error.message}`);
      }
      throw error;
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeLocal(ctx, input.locationId);
      const { rows: existente } = await ctx.client.query<{ id: string }>(
        `SELECT id FROM org_schedules
          WHERE location_id = $1
            AND brand_id IS NOT DISTINCT FROM $2
            AND channel IS NOT DISTINCT FROM $3`,
        [input.locationId, input.brandId ?? null, input.channel ?? null],
      );

      const weekly = JSON.stringify(input.schedule.weekly ?? []);
      const exceptions = JSON.stringify(input.schedule.exceptions ?? []);

      const id = existente[0]
        ? (
            await ctx.client.query<{ id: string }>(
              `UPDATE org_schedules
                  SET weekly = $2::jsonb, exceptions = $3::jsonb, updated_at = now()
                WHERE id = $1 RETURNING id`,
              [existente[0].id, weekly, exceptions],
            )
          ).rows[0]!.id
        : (
            await ctx.client.query<{ id: string }>(
              `INSERT INTO org_schedules
                 (tenant_id, location_id, brand_id, channel, weekly, exceptions)
               VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
              [
                tenantId,
                input.locationId,
                input.brandId ?? null,
                input.channel ?? null,
                weekly,
                exceptions,
              ],
            )
          ).rows[0]!.id;

      await this.auditar(
        ctx,
        input.actorId,
        'org.schedule_upserted',
        'schedule',
        id,
        {
          locationId: input.locationId,
        },
      );
      return { id };
    });
  }

  // ----------------------------------------------------------------- Apoyo

  private async exigeEmpresa(
    ctx: TenantContext,
    companyId: string,
  ): Promise<void> {
    const { rows } = await ctx.client.query(
      'SELECT 1 FROM org_companies WHERE id = $1',
      [companyId],
    );
    if (!rows[0]) throw new NotFoundError('Empresa no encontrada.');
  }

  private async exigeLocal(
    ctx: TenantContext,
    locationId: string,
  ): Promise<void> {
    const { rows } = await ctx.client.query(
      'SELECT 1 FROM org_locations WHERE id = $1',
      [locationId],
    );
    if (!rows[0]) throw new NotFoundError('Local no encontrado.');
  }

  private async auditar(
    ctx: TenantContext,
    actorId: string | undefined,
    action: string,
    resourceType: string,
    resourceId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(ctx, {
      actorType: 'user',
      ...(actorId !== undefined ? { actorId } : {}),
      action,
      resourceType,
      resourceId,
      data,
    });
  }
}

interface FilaLocal {
  id: string;
  company_id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  timezone: string;
  active: boolean;
}

interface FilaZona {
  id: string;
  location_id: string;
  brand_id: string | null;
  name: string;
  delivery_fee: string;
  min_order: string;
  base_minutes: number;
  active: boolean;
}
