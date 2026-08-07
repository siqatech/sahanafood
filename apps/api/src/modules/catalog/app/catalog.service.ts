import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  Money,
  isPaused,
  resolvePrice,
  type ProductPause,
  type ScopedPrice,
} from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';
import { NotFoundError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';

/**
 * Módulo Catalog (spec 04).
 *
 * `getResolvedCatalog` es el corazón: entrega lo que la tienda, el POS y el
 * agente de IA consumen, con **el precio ya resuelto para el canal** y las
 * pausas aplicadas. Ningún cliente resuelve precios por su cuenta — así el
 * precio que ve el cliente es el mismo que cobra la caja y el que va al
 * comprobante.
 *
 * La resolución en sí vive en `@sahana/domain` para que el POS offline la
 * ejecute idéntica sobre el catálogo versionado que descargó.
 */

export interface ResolvedModifierOption {
  id: string;
  name: string;
  priceDeltaMinor: number;
  available: boolean;
}

export interface ResolvedModifierGroup {
  id: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  allowRepeat: boolean;
  options: ResolvedModifierOption[];
}

export interface ResolvedProduct {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  imageUrl: string | null;
  allergens: unknown;
  prepMinutes: number;
  isCombo: boolean;
  /** Precio ya resuelto para el canal consultado. */
  price: ReturnType<Money['toJSON']>;
  modifierGroups: ResolvedModifierGroup[];
}

export interface ResolvedCatalog {
  brandId: string;
  channel: string;
  locationId: string | null;
  /** Momento de resolución: el cliente sabe a qué instante corresponde. */
  resolvedAt: string;
  categories: Array<{ id: string; name: string; sortOrder: number }>;
  products: ResolvedProduct[];
}

@Injectable()
export class CatalogService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Catálogo resuelto para (marca, canal, local) — RN-CAT-01/03.
   *
   * Un producto se omite si no tiene precio para el canal o si está pausado.
   * Omitirlo es deliberado: es preferible que falte a que la tienda lo muestre
   * y el pedido se caiga después, con el cliente ya esperando.
   */
  async getResolvedCatalog(
    tenantId: string,
    query: { brandId: string; channel: string; locationId?: string; at?: Date },
  ): Promise<ResolvedCatalog> {
    const at = query.at ?? new Date();

    return withTenant(this.pool, tenantId, async (ctx) => {
      const productRows = await ctx.db
        .select()
        .from(schema.products)
        .where(
          and(
            eq(schema.products.brandId, query.brandId),
            eq(schema.products.active, true),
          ),
        );

      if (productRows.length === 0) {
        return {
          brandId: query.brandId,
          channel: query.channel,
          locationId: query.locationId ?? null,
          resolvedAt: at.toISOString(),
          categories: [],
          products: [],
        };
      }

      const productIds = productRows.map((p) => p.id);

      const [priceRows, pauseRows, categoryRows, groupLinks] = [
        await ctx.db
          .select()
          .from(schema.prices)
          .where(inArray(schema.prices.productId, productIds)),
        await ctx.db
          .select()
          .from(schema.productPauses)
          .where(inArray(schema.productPauses.productId, productIds)),
        await ctx.db
          .select()
          .from(schema.categories)
          .where(
            and(
              eq(schema.categories.brandId, query.brandId),
              eq(schema.categories.active, true),
            ),
          ),
        await ctx.db
          .select()
          .from(schema.productModifierGroups)
          .where(inArray(schema.productModifierGroups.productId, productIds)),
      ];

      // Grupos de modificadores con sus opciones, en dos consultas y no N+1.
      const groupIds = [...new Set(groupLinks.map((l) => l.groupId))];
      const groupRows = groupIds.length
        ? await ctx.db
            .select()
            .from(schema.modifierGroups)
            .where(inArray(schema.modifierGroups.id, groupIds))
        : [];
      const optionRows = groupIds.length
        ? await ctx.db
            .select()
            .from(schema.modifierOptions)
            .where(inArray(schema.modifierOptions.groupId, groupIds))
        : [];

      const optionsByGroup = new Map<string, ResolvedModifierOption[]>();
      for (const o of optionRows) {
        const list = optionsByGroup.get(o.groupId) ?? [];
        list.push({
          id: o.id,
          name: o.name,
          // NUMERIC llega como string: se convierte con Money, nunca con Number.
          priceDeltaMinor: Money.parse(o.priceDelta).minorUnits,
          available: o.available,
        });
        optionsByGroup.set(o.groupId, list);
      }

      const groupsById = new Map(
        groupRows.map((g) => [
          g.id,
          {
            id: g.id,
            name: g.name,
            minSelections: g.minSelections,
            maxSelections: g.maxSelections,
            allowRepeat: g.allowRepeat,
            options: optionsByGroup.get(g.id) ?? [],
          } satisfies ResolvedModifierGroup,
        ]),
      );

      const groupsByProduct = new Map<string, ResolvedModifierGroup[]>();
      for (const link of groupLinks.sort((a, b) => a.sortOrder - b.sortOrder)) {
        const group = groupsById.get(link.groupId);
        if (!group) continue;
        const list = groupsByProduct.get(link.productId) ?? [];
        list.push(group);
        groupsByProduct.set(link.productId, list);
      }

      const pricesByProduct = new Map<string, ScopedPrice[]>();
      for (const p of priceRows) {
        const list = pricesByProduct.get(p.productId) ?? [];
        list.push({
          priceMinor: Money.parse(p.price).minorUnits,
          channel: p.channel,
          locationId: p.locationId,
          active: p.active,
        });
        pricesByProduct.set(p.productId, list);
      }

      const pausesByProduct = new Map<string, ProductPause[]>();
      for (const p of pauseRows) {
        const list = pausesByProduct.get(p.productId) ?? [];
        list.push({ channel: p.channel, until: p.until });
        pausesByProduct.set(p.productId, list);
      }

      const products: ResolvedProduct[] = [];
      for (const product of productRows) {
        const resolved = resolvePrice(pricesByProduct.get(product.id) ?? [], {
          channel: query.channel,
          locationId: query.locationId,
        });
        // Sin precio para el canal → invisible en ese canal (RN-CAT-01).
        if (!resolved) continue;

        // Pausado → fuera del catálogo resuelto (RN-CAT-03).
        if (
          isPaused(pausesByProduct.get(product.id) ?? [], query.channel, at)
        ) {
          continue;
        }

        products.push({
          id: product.id,
          name: product.name,
          description: product.description,
          categoryId: product.categoryId,
          imageUrl: product.imageUrl,
          allergens: product.allergens,
          prepMinutes: product.prepMinutes,
          isCombo: product.isCombo,
          price: Money.fromMinor(resolved.priceMinor).toJSON(),
          modifierGroups: groupsByProduct.get(product.id) ?? [],
        });
      }

      return {
        brandId: query.brandId,
        channel: query.channel,
        locationId: query.locationId ?? null,
        resolvedAt: at.toISOString(),
        categories: categoryRows
          .map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder }))
          .sort((a, b) => a.sortOrder - b.sortOrder),
        products,
      };
    });
  }

  /**
   * Pausa o reactiva un producto en un canal (RN-CAT-03).
   *
   * Emite `catalog.availability_changed` por el outbox EN LA MISMA transacción,
   * de modo que la propagación a los canales no depende de que la petición HTTP
   * termine bien. El SLO es < 60 s.
   */
  async pauseProduct(
    tenantId: string,
    productId: string,
    input: {
      channels: string[];
      until?: Date;
      reason?: string;
      actorId: string;
      traceId?: string;
    },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      await this.assertProductExists(ctx, productId);

      for (const channel of input.channels) {
        await ctx.client.query(
          `INSERT INTO cat_product_pauses
             (tenant_id, product_id, channel, until, reason, paused_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, product_id, channel) DO UPDATE
             SET until = EXCLUDED.until,
                 reason = EXCLUDED.reason,
                 paused_by = EXCLUDED.paused_by,
                 paused_at = now()`,
          [
            tenantId,
            productId,
            channel,
            input.until ?? null,
            input.reason ?? null,
            input.actorId,
          ],
        );
      }

      await enqueueEvent(ctx, {
        aggregateType: 'product',
        aggregateId: productId,
        eventType: 'catalog.availability_changed',
        payload: {
          productId,
          channels: input.channels,
          paused: true,
          until: input.until?.toISOString() ?? null,
        },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: input.actorId,
        action: 'catalog.product_paused',
        resourceType: 'product',
        resourceId: productId,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        data: { channels: input.channels },
      });
    });
  }

  /** Reactiva un producto pausado. */
  async resumeProduct(
    tenantId: string,
    productId: string,
    input: { channels: string[]; actorId: string; traceId?: string },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      await this.assertProductExists(ctx, productId);

      await ctx.client.query(
        `DELETE FROM cat_product_pauses
          WHERE product_id = $1 AND channel = ANY($2::text[])`,
        [productId, input.channels],
      );

      await enqueueEvent(ctx, {
        aggregateType: 'product',
        aggregateId: productId,
        eventType: 'catalog.availability_changed',
        payload: { productId, channels: input.channels, paused: false },
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
      });

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: input.actorId,
        action: 'catalog.product_resumed',
        resourceType: 'product',
        resourceId: productId,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        data: { channels: input.channels },
      });
    });
  }

  /** Precio aplicable a un producto en un canal. `undefined` = no vendible ahí. */
  async resolveProductPrice(
    tenantId: string,
    productId: string,
    query: { channel: string; locationId?: string },
  ): Promise<Money | undefined> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(schema.prices)
        .where(eq(schema.prices.productId, productId));

      const resolved = resolvePrice(
        rows.map((p) => ({
          priceMinor: Money.parse(p.price).minorUnits,
          channel: p.channel,
          locationId: p.locationId,
          active: p.active,
        })),
        query,
      );
      return resolved ? Money.fromMinor(resolved.priceMinor) : undefined;
    });
  }

  private async assertProductExists(
    ctx: TenantContext,
    productId: string,
  ): Promise<void> {
    const rows = await ctx.db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(eq(schema.products.id, productId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundError('Producto no encontrado.');
    }
  }
}
