import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  Money,
  isOpenAt,
  selectCoverageZone,
  toLocalMoment,
  type CoverageZone,
  type Position,
  type Ring,
  type Schedule,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';

/**
 * Módulo Organization (spec 03).
 *
 * La regla estructural que sostiene el producto multimarca: **marca ⟷ cocina es
 * M:N** (RN-ORG-01). Una cocina produce para varias marcas y una marca se
 * produce en varias cocinas; nunca se anida la marca dentro del local.
 *
 * Cobertura y horarios se resuelven con `@sahana/domain`, el MISMO código que
 * corre en la tienda y en el POS offline: si el servidor y la tienda
 * discrepasen sobre si una dirección tiene cobertura, el cliente se pierde.
 */

export interface CoverageResult {
  zoneId: string;
  zoneName: string;
  locationId: string;
  brandId: string | null;
  /** Montos como enteros de unidades menores + moneda (nunca decimal suelto). */
  deliveryFee: ReturnType<Money['toJSON']>;
  minOrder: ReturnType<Money['toJSON']>;
  baseMinutes: number;
}

/** Zona tal como se guarda, ya resuelta a tipos de dominio. */
interface ZoneRow {
  id: string;
  name: string;
  brandId: string | null;
  locationId: string;
  polygon: unknown;
  deliveryFee: string;
  minOrder: string;
  baseMinutes: number;
  active: boolean;
}

/** Valida y normaliza el polígono guardado en jsonb. */
function toRing(raw: unknown, zoneId: string): Ring {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new ValidationError(
      `La zona ${zoneId} tiene un polígono inválido (se requieren 3+ vértices).`,
    );
  }
  return raw.map((p) => {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      typeof p[0] !== 'number' ||
      typeof p[1] !== 'number'
    ) {
      throw new ValidationError(
        `La zona ${zoneId} tiene un vértice inválido; se espera [lng, lat].`,
      );
    }
    return [p[0], p[1]] as const;
  });
}

@Injectable()
export class OrganizationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Zona de cobertura aplicable a un punto (RN-ORG-02).
   * Devuelve `undefined` si no hay cobertura → la API responde 404.
   *
   * Pre-filtra por bounding box en SQL (índice) y decide en el dominio, que es
   * quien define que la frontera cuenta como dentro y que ante solapamiento
   * gana la tarifa menor.
   */
  async findCoverage(
    tenantId: string,
    point: Position,
    brandId?: string,
  ): Promise<CoverageResult | undefined> {
    const [lng, lat] = point;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new ValidationError('Coordenadas inválidas.');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new ValidationError(
        'Coordenadas fuera de rango: lat ∈ [-90,90], lng ∈ [-180,180].',
      );
    }

    const rows = await withTenant(this.pool, tenantId, async (ctx) => {
      // Una zona sin marca (brand_id NULL) aplica a todas las marcas.
      const brandFilter: SQL | undefined = brandId
        ? or(eq(schema.zones.brandId, brandId), isNull(schema.zones.brandId))
        : undefined;

      const conditions = [eq(schema.zones.active, true)];
      if (brandFilter) conditions.push(brandFilter);

      return ctx.db
        .select({
          id: schema.zones.id,
          name: schema.zones.name,
          brandId: schema.zones.brandId,
          locationId: schema.zones.locationId,
          polygon: schema.zones.polygon,
          deliveryFee: schema.zones.deliveryFee,
          minOrder: schema.zones.minOrder,
          baseMinutes: schema.zones.baseMinutes,
          active: schema.zones.active,
        })
        .from(schema.zones)
        .where(and(...conditions));
    });

    const candidates: CoverageZone<string>[] = (rows as ZoneRow[]).map((z) => ({
      id: z.id,
      polygon: toRing(z.polygon, z.id),
      // NUMERIC(14,4) llega como string: se convierte con Money, nunca con Number.
      deliveryFeeMinor: Money.parse(z.deliveryFee).minorUnits,
      minOrderMinor: Money.parse(z.minOrder).minorUnits,
      baseMinutes: z.baseMinutes,
      active: z.active,
    }));

    const winner = selectCoverageZone(point, candidates);
    if (!winner) return undefined;

    const row = (rows as ZoneRow[]).find((z) => z.id === winner.id)!;
    return {
      zoneId: row.id,
      zoneName: row.name,
      locationId: row.locationId,
      brandId: row.brandId,
      deliveryFee: Money.fromMinor(winner.deliveryFeeMinor).toJSON(),
      minOrder: Money.fromMinor(winner.minOrderMinor).toJSON(),
      baseMinutes: winner.baseMinutes,
    };
  }

  /**
   * ¿Está abierto un local (opcionalmente para una marca y canal) ahora mismo?
   * La hora se evalúa en la zona horaria del LOCAL, no en la del servidor.
   */
  async isOpen(
    tenantId: string,
    locationId: string,
    options: { brandId?: string; channel?: string; at?: Date } = {},
  ): Promise<{ open: boolean; timezone: string; localTime: string }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const [location] = await ctx.db
        .select({ timezone: schema.locations.timezone })
        .from(schema.locations)
        .where(eq(schema.locations.id, locationId))
        .limit(1);

      if (!location) throw new NotFoundError('Local no encontrado.');

      const rows = await ctx.db
        .select({
          brandId: schema.schedules.brandId,
          channel: schema.schedules.channel,
          weekly: schema.schedules.weekly,
          exceptions: schema.schedules.exceptions,
        })
        .from(schema.schedules)
        .where(eq(schema.schedules.locationId, locationId));

      // Se elige el horario más específico disponible: (marca, canal) gana a
      // (marca) y a (canal), y estos al general.
      const score = (r: {
        brandId: string | null;
        channel: string | null;
      }): number =>
        (r.brandId === options.brandId && options.brandId ? 2 : 0) +
        (r.channel === options.channel && options.channel ? 1 : 0);

      const applicable = rows
        .filter(
          (r) =>
            (r.brandId === null || r.brandId === options.brandId) &&
            (r.channel === null || r.channel === options.channel),
        )
        .sort((a, b) => score(b) - score(a));

      const moment = toLocalMoment(options.at ?? new Date(), location.timezone);
      const chosen = applicable[0];
      const open = chosen
        ? isOpenAt(
            {
              weekly: chosen.weekly,
              exceptions: chosen.exceptions,
            } as Schedule,
            moment,
          )
        : false;

      return {
        open,
        timezone: location.timezone,
        localTime: `${moment.date} ${moment.time}`,
      };
    });
  }

  /** Cocinas que producen una marca (RN-ORG-01). Vacío = no puede recibir pedidos. */
  async kitchensForBrand(
    tenantId: string,
    brandId: string,
  ): Promise<Array<{ id: string; name: string; locationId: string }>> {
    return withTenant(this.pool, tenantId, async (ctx) =>
      ctx.db
        .select({
          id: schema.kitchens.id,
          name: schema.kitchens.name,
          locationId: schema.kitchens.locationId,
        })
        .from(schema.brandKitchens)
        .innerJoin(
          schema.kitchens,
          and(
            eq(schema.kitchens.id, schema.brandKitchens.kitchenId),
            eq(schema.kitchens.tenantId, schema.brandKitchens.tenantId),
          ),
        )
        .where(
          and(
            eq(schema.brandKitchens.brandId, brandId),
            eq(schema.brandKitchens.active, true),
            eq(schema.kitchens.active, true),
          ),
        ),
    );
  }

  /** Marcas que produce una cocina (el otro lado del M:N). */
  async brandsForKitchen(
    tenantId: string,
    kitchenId: string,
  ): Promise<Array<{ id: string; name: string; slug: string }>> {
    return withTenant(this.pool, tenantId, async (ctx) =>
      ctx.db
        .select({
          id: schema.brands.id,
          name: schema.brands.name,
          slug: schema.brands.slug,
        })
        .from(schema.brandKitchens)
        .innerJoin(
          schema.brands,
          and(
            eq(schema.brands.id, schema.brandKitchens.brandId),
            eq(schema.brands.tenantId, schema.brandKitchens.tenantId),
          ),
        )
        .where(
          and(
            eq(schema.brandKitchens.kitchenId, kitchenId),
            eq(schema.brandKitchens.active, true),
            eq(schema.brands.active, true),
          ),
        ),
    );
  }

  /** Estructura organizativa del tenant, para el panel. */
  async getStructure(tenantId: string): Promise<{
    companies: unknown[];
    brands: unknown[];
    locations: unknown[];
    kitchens: unknown[];
    stations: unknown[];
    brandKitchens: unknown[];
  }> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      // SECUENCIAL a propósito: todas comparten la misma conexión dentro de la
      // transacción, y `pg` no admite consultas concurrentes sobre un cliente
      // (Promise.all aquí provoca un aviso de deprecación y, en el peor caso,
      // respuestas cruzadas). Paralelizar exigiría varias conexiones y perder
      // la transacción única, que es lo que garantiza una vista coherente.
      const companies = await ctx.db.select().from(schema.companies);
      const brandList = await ctx.db.select().from(schema.brands);
      const locationList = await ctx.db.select().from(schema.locations);
      const kitchenList = await ctx.db.select().from(schema.kitchens);
      // Estaciones y enlaces marca↔cocina faltaban, y sin ellos la estructura
      // no se puede ni mirar ni completar: RN-ORG-01 dice que una marca sin
      // cocina asignada NO PUEDE recibir pedidos, y desde el panel no había
      // forma de saber si lo estaba —ni de arreglarlo—.
      const stationList = await ctx.db.select().from(schema.stations);
      const links = await ctx.db.select().from(schema.brandKitchens);
      return {
        companies,
        brands: brandList,
        locations: locationList,
        kitchens: kitchenList,
        stations: stationList,
        brandKitchens: links,
      };
    });
  }
}
