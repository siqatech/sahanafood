import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';

/**
 * Alta y edición de la carta (spec 04 «CRUD completo», salda DT-10).
 *
 * Existe porque **faltaba entera**, igual que la escritura de organización: de
 * la spec 04 solo se había construido la LECTURA —resolución de precio, pausa,
 * publicación versionada— y la única forma de crear un producto era la semilla
 * demo. Un dueño no podía subir su carta.
 *
 * Y es la mitad que de verdad se usa: la estructura del negocio se define una
 * vez y casi no cambia; la carta cambia cada semana. Un precio mal escrito un
 * viernes se corrige aplicando otra vez la misma configuración, y por eso
 * **todo aquí es idempotente por clave natural**: el SKU o el nombre del plato
 * dentro de la marca, el nombre de la categoría, el ámbito del precio. Una
 * segunda pasada que duplicara productos dejaría la carta con dos «Pollo a la
 * brasa» a precios distintos y ningún modo de saber cuál cobra la caja.
 *
 * ### Coherencia de marca
 *
 * Las claves foráneas de `0008_catalog.sql` son por `(tenant_id, id)`: impiden
 * cruzar tenants pero **no** cruzar marcas. Nada en la base evita poner a un
 * producto de la marca B una categoría de la marca A, o un grupo de
 * modificadores de otra marca. El síntoma sería silencioso —la categoría no
 * aparece en el catálogo resuelto de esa marca, el modificador sí— así que se
 * comprueba aquí, que es donde se puede dar un mensaje que se entienda.
 */

/**
 * El producto cambió entre que se leyó y se intentó guardar. 409 y no 422: lo
 * enviado es correcto, solo llega tarde. Sin esto, dos supervisores corrigiendo
 * el precio del mismo plato a la vez se pisan en silencio y gana el último en
 * pulsar guardar (docs/07 §6).
 */
export class CatalogVersionConflictError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/catalog-version-conflict';
  readonly title = 'El producto cambió mientras lo editabas';
  readonly code = 'CATALOG_VERSION_CONFLICT';
}

export interface CategoryView {
  id: string;
  brandId: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface ProductView {
  id: string;
  brandId: string;
  categoryId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  prepMinutes: number;
  isCombo: boolean;
  active: boolean;
  /** Para `If-Match`: quien edite después tiene que traer esta versión. */
  rowVersion: number;
}

export interface ModifierGroupView {
  id: string;
  brandId: string;
  name: string;
  minSelections: number;
  maxSelections: number;
  allowRepeat: boolean;
  sortOrder: number;
}

export interface ModifierOptionView {
  id: string;
  groupId: string;
  name: string;
  /** Importe como cadena decimal: no pasa por coma flotante en ningún punto. */
  priceDelta: string;
  available: boolean;
  sortOrder: number;
}

/**
 * Un producto visto por quien administra la carta: con TODOS sus precios por
 * ámbito y sus pausas, incluidos los que la tienda oculta.
 */
export interface AdminProductView {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  sku: string | null;
  name: string;
  active: boolean;
  isCombo: boolean;
  prepMinutes: number;
  /** La foto, si la tiene. El panel necesita saber cuáles faltan. */
  imageUrl: string | null;
  rowVersion: number;
  prices: Array<{
    channel: string | null;
    locationId: string | null;
    price: string;
    active: boolean;
  }>;
  pauses: Array<{ channel: string; until: string | null }>;
}

export interface PriceView {
  id: string;
  productId: string;
  brandId: string;
  channel: string | null;
  locationId: string | null;
  price: string;
  active: boolean;
}

@Injectable()
export class CatalogAdminService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ------------------------------------------------------------ Categoría

  /** Categoría de la carta. Clave natural: el nombre dentro de la marca. */
  async upsertCategory(
    tenantId: string,
    input: {
      brandId: string;
      name: string;
      sortOrder?: number | undefined;
      active?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<CategoryView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('La categoría necesita un nombre.');

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeMarca(ctx, input.brandId);
      const { rows: existente } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM cat_categories WHERE brand_id = $1 AND lower(name) = lower($2)',
        [input.brandId, nombre],
      );

      const fila = existente[0]
        ? (
            await ctx.client.query<FilaCategoria>(
              `UPDATE cat_categories
                  SET name = $2, sort_order = $3, active = $4, updated_at = now()
                WHERE id = $1
                RETURNING id, brand_id, name, sort_order, active`,
              [
                existente[0].id,
                nombre,
                input.sortOrder ?? 0,
                input.active ?? true,
              ],
            )
          ).rows[0]!
        : (
            await ctx.client.query<FilaCategoria>(
              `INSERT INTO cat_categories (tenant_id, brand_id, name, sort_order, active)
               VALUES ($1,$2,$3,$4,$5)
               RETURNING id, brand_id, name, sort_order, active`,
              [
                tenantId,
                input.brandId,
                nombre,
                input.sortOrder ?? 0,
                input.active ?? true,
              ],
            )
          ).rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.category_upserted',
        'category',
        fila.id,
        { name: nombre },
      );
      return {
        id: fila.id,
        brandId: fila.brand_id,
        name: fila.name,
        sortOrder: fila.sort_order,
        active: fila.active,
      };
    });
  }

  // ------------------------------------------------------------- Producto

  /**
   * Plato de la carta. Clave natural: el **SKU** dentro de la marca si lo hay,
   * y el nombre si no.
   *
   * El SKU manda porque es lo que el dueño usa para renombrar sin duplicar:
   * «Pollo a la brasa» pasa a «Pollo a la brasa entero» y sigue siendo el mismo
   * producto, con su historial de ventas. Sin SKU, un renombrado crea uno nuevo
   * y el anterior se queda en la carta — de ahí que el nombre solo se use como
   * clave cuando no hay nada mejor.
   *
   * **No crea precio.** Un producto sin precio para el canal no se ve en ese
   * canal (RN-CAT-01), que es exactamente lo que debe pasar mientras el dueño
   * está montando la carta a medias.
   */
  async upsertProduct(
    tenantId: string,
    input: {
      brandId: string;
      categoryId?: string | null | undefined;
      sku?: string | undefined;
      name: string;
      description?: string | null | undefined;
      imageUrl?: string | null | undefined;
      allergens?: string[] | undefined;
      prepMinutes?: number | undefined;
      isCombo?: boolean | undefined;
      active?: boolean | undefined;
      /** Concurrencia optimista: si viene y no coincide, 409 (docs/07 §6). */
      expectedRowVersion?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ProductView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('El producto necesita un nombre.');
    const sku = input.sku?.trim() || undefined;

    const minutos = input.prepMinutes ?? 10;
    if (!Number.isInteger(minutos) || minutos <= 0) {
      throw new ValidationError(
        'Los minutos de preparación tienen que ser un entero positivo.',
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeMarca(ctx, input.brandId);

      if (input.categoryId) {
        const { rows } = await ctx.client.query<{ brand_id: string }>(
          'SELECT brand_id FROM cat_categories WHERE id = $1',
          [input.categoryId],
        );
        if (!rows[0]) throw new NotFoundError('Categoría no encontrada.');
        if (rows[0].brand_id !== input.brandId) {
          throw new ValidationError(
            'La categoría es de otra marca: no se puede usar en este producto.',
          );
        }
      }

      // `FOR UPDATE`: entre leer la versión y escribirla no puede colarse otra
      // edición, que es justo lo que el control optimista tiene que detectar.
      const { rows: existente } = sku
        ? await ctx.client.query<{ id: string; row_version: number }>(
            'SELECT id, row_version FROM cat_products WHERE brand_id = $1 AND sku = $2 FOR UPDATE',
            [input.brandId, sku],
          )
        : await ctx.client.query<{ id: string; row_version: number }>(
            'SELECT id, row_version FROM cat_products WHERE brand_id = $1 AND lower(name) = lower($2) FOR UPDATE',
            [input.brandId, nombre],
          );

      if (
        existente[0] &&
        input.expectedRowVersion !== undefined &&
        existente[0].row_version !== input.expectedRowVersion
      ) {
        throw new CatalogVersionConflictError(
          `El producto va por la versión ${existente[0].row_version} y enviaste la ${input.expectedRowVersion}. Vuelve a cargarlo antes de guardar.`,
          {
            currentVersion: existente[0].row_version,
            sentVersion: input.expectedRowVersion,
          },
        );
      }

      const alergenos = JSON.stringify(input.allergens ?? []);

      const fila = existente[0]
        ? (
            await ctx.client.query<FilaProducto>(
              `UPDATE cat_products
                  SET brand_id = $2, category_id = $3, sku = $4, name = $5,
                      description = $6, image_url = $7, allergens = $8::jsonb,
                      prep_minutes = $9, is_combo = $10, active = $11,
                      row_version = row_version + 1, updated_at = now()
                WHERE id = $1
                RETURNING id, brand_id, category_id, sku, name, description,
                          prep_minutes, is_combo, active, row_version`,
              [
                existente[0].id,
                input.brandId,
                input.categoryId ?? null,
                sku ?? null,
                nombre,
                input.description ?? null,
                input.imageUrl ?? null,
                alergenos,
                minutos,
                input.isCombo ?? false,
                input.active ?? true,
              ],
            )
          ).rows[0]!
        : (
            await ctx.client.query<FilaProducto>(
              `INSERT INTO cat_products
                 (tenant_id, brand_id, category_id, sku, name, description,
                  image_url, allergens, prep_minutes, is_combo, active)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
               RETURNING id, brand_id, category_id, sku, name, description,
                         prep_minutes, is_combo, active, row_version`,
              [
                tenantId,
                input.brandId,
                input.categoryId ?? null,
                sku ?? null,
                nombre,
                input.description ?? null,
                input.imageUrl ?? null,
                alergenos,
                minutos,
                input.isCombo ?? false,
                input.active ?? true,
              ],
            )
          ).rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.product_upserted',
        'product',
        fila.id,
        { name: nombre, ...(sku !== undefined ? { sku } : {}) },
      );

      return {
        id: fila.id,
        brandId: fila.brand_id,
        categoryId: fila.category_id,
        sku: fila.sku,
        name: fila.name,
        description: fila.description,
        prepMinutes: fila.prep_minutes,
        isCombo: fila.is_combo,
        active: fila.active,
        rowVersion: fila.row_version,
      };
    });
  }

  // --------------------------------------------------------------- Precio

  /**
   * Precio de un producto en un ámbito (RN-CAT-01). Clave natural: el propio
   * ámbito — (producto, canal, local).
   *
   * `channel` nulo es el precio base y `locationId` nulo son todos los locales;
   * la resolución elige siempre el más específico. La marca **se deriva del
   * producto**, no se acepta del cuerpo: si se aceptara, un precio podría
   * quedar apuntando a una marca distinta de la del producto y desaparecer de
   * los dos catálogos a la vez.
   *
   * El importe **incluye IGV** (RN-T05) y viaja en unidades menores, nunca como
   * decimal en coma flotante.
   */
  async setPrice(
    tenantId: string,
    input: {
      productId: string;
      channel?: string | null | undefined;
      locationId?: string | null | undefined;
      priceMinor: number;
      active?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<PriceView> {
    if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0) {
      throw new ValidationError(
        'El precio tiene que ser un entero de unidades menores no negativo.',
      );
    }
    const importe = Money.fromMinor(input.priceMinor);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: producto } = await ctx.client.query<{ brand_id: string }>(
        'SELECT brand_id FROM cat_products WHERE id = $1',
        [input.productId],
      );
      if (!producto[0]) throw new NotFoundError('Producto no encontrado.');

      if (input.locationId) {
        const { rows } = await ctx.client.query(
          'SELECT 1 FROM org_locations WHERE id = $1',
          [input.locationId],
        );
        if (!rows[0]) throw new NotFoundError('Local no encontrado.');
      }

      const { rows } = await ctx.client.query<FilaPrecio>(
        `INSERT INTO cat_prices
           (tenant_id, product_id, brand_id, channel, location_id, price, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (
           tenant_id,
           product_id,
           COALESCE(channel, '*'),
           COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
         ) DO UPDATE
           SET price = EXCLUDED.price,
               active = EXCLUDED.active,
               brand_id = EXCLUDED.brand_id,
               updated_at = now()
         RETURNING id, product_id, brand_id, channel, location_id, price, active`,
        [
          tenantId,
          input.productId,
          producto[0].brand_id,
          input.channel ?? null,
          input.locationId ?? null,
          importe.toDecimalString(),
          input.active ?? true,
        ],
      );
      const fila = rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.price_set',
        'product',
        input.productId,
        {
          channel: input.channel ?? null,
          locationId: input.locationId ?? null,
          price: importe.toDecimalString(),
        },
      );

      return {
        id: fila.id,
        productId: fila.product_id,
        brandId: fila.brand_id,
        channel: fila.channel,
        locationId: fila.location_id,
        price: fila.price,
        active: fila.active,
      };
    });
  }

  // --------------------------------------------------------- Modificadores

  /** Grupo de modificadores. Clave natural: el nombre dentro de la marca. */
  async upsertModifierGroup(
    tenantId: string,
    input: {
      brandId: string;
      name: string;
      minSelections?: number | undefined;
      maxSelections?: number | undefined;
      allowRepeat?: boolean | undefined;
      sortOrder?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ModifierGroupView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('El grupo necesita un nombre.');

    const min = input.minSelections ?? 0;
    const max = input.maxSelections ?? 1;
    // Se comprueba aquí y no solo en el CHECK de la base porque el mensaje
    // importa: «viola la restricción modifier_rango_coherente» no le dice a
    // nadie que puso el mínimo por encima del máximo.
    if (!Number.isInteger(min) || min < 0) {
      throw new ValidationError(
        'El mínimo de selecciones no puede ser negativo.',
      );
    }
    if (!Number.isInteger(max) || max < 1) {
      throw new ValidationError(
        'El máximo de selecciones tiene que ser al menos 1.',
      );
    }
    if (max < min) {
      throw new ValidationError(
        `El máximo de selecciones (${max}) no puede ser menor que el mínimo (${min}).`,
      );
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      await this.exigeMarca(ctx, input.brandId);
      const { rows: existente } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM cat_modifier_groups WHERE brand_id = $1 AND lower(name) = lower($2)',
        [input.brandId, nombre],
      );

      const fila = existente[0]
        ? (
            await ctx.client.query<FilaGrupo>(
              `UPDATE cat_modifier_groups
                  SET name = $2, min_selections = $3, max_selections = $4,
                      allow_repeat = $5, sort_order = $6
                WHERE id = $1
                RETURNING id, brand_id, name, min_selections, max_selections,
                          allow_repeat, sort_order`,
              [
                existente[0].id,
                nombre,
                min,
                max,
                input.allowRepeat ?? false,
                input.sortOrder ?? 0,
              ],
            )
          ).rows[0]!
        : (
            await ctx.client.query<FilaGrupo>(
              `INSERT INTO cat_modifier_groups
                 (tenant_id, brand_id, name, min_selections, max_selections,
                  allow_repeat, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               RETURNING id, brand_id, name, min_selections, max_selections,
                         allow_repeat, sort_order`,
              [
                tenantId,
                input.brandId,
                nombre,
                min,
                max,
                input.allowRepeat ?? false,
                input.sortOrder ?? 0,
              ],
            )
          ).rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.modifier_group_upserted',
        'modifier_group',
        fila.id,
        { name: nombre },
      );
      return {
        id: fila.id,
        brandId: fila.brand_id,
        name: fila.name,
        minSelections: fila.min_selections,
        maxSelections: fila.max_selections,
        allowRepeat: fila.allow_repeat,
        sortOrder: fila.sort_order,
      };
    });
  }

  /**
   * Opción de un grupo. Clave natural: el nombre dentro del grupo.
   *
   * El delta **puede ser negativo**: «sin papas» descuenta. Por eso no se
   * valida `>= 0` como en el precio.
   */
  async upsertModifierOption(
    tenantId: string,
    input: {
      groupId: string;
      name: string;
      priceDeltaMinor?: number | undefined;
      available?: boolean | undefined;
      sortOrder?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ModifierOptionView> {
    const nombre = input.name.trim();
    if (!nombre) throw new ValidationError('La opción necesita un nombre.');
    const delta = input.priceDeltaMinor ?? 0;
    if (!Number.isInteger(delta)) {
      throw new ValidationError(
        'El diferencial de precio tiene que ser un entero de unidades menores.',
      );
    }
    const importe = Money.fromMinor(delta);

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: grupo } = await ctx.client.query(
        'SELECT 1 FROM cat_modifier_groups WHERE id = $1',
        [input.groupId],
      );
      if (!grupo[0])
        throw new NotFoundError('Grupo de modificadores no encontrado.');

      const { rows: existente } = await ctx.client.query<{ id: string }>(
        'SELECT id FROM cat_modifier_options WHERE group_id = $1 AND lower(name) = lower($2)',
        [input.groupId, nombre],
      );

      const fila = existente[0]
        ? (
            await ctx.client.query<FilaOpcion>(
              `UPDATE cat_modifier_options
                  SET name = $2, price_delta = $3, available = $4, sort_order = $5
                WHERE id = $1
                RETURNING id, group_id, name, price_delta, available, sort_order`,
              [
                existente[0].id,
                nombre,
                importe.toDecimalString(),
                input.available ?? true,
                input.sortOrder ?? 0,
              ],
            )
          ).rows[0]!
        : (
            await ctx.client.query<FilaOpcion>(
              `INSERT INTO cat_modifier_options
                 (tenant_id, group_id, name, price_delta, available, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6)
               RETURNING id, group_id, name, price_delta, available, sort_order`,
              [
                tenantId,
                input.groupId,
                nombre,
                importe.toDecimalString(),
                input.available ?? true,
                input.sortOrder ?? 0,
              ],
            )
          ).rows[0]!;

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.modifier_option_upserted',
        'modifier_option',
        fila.id,
        { name: nombre, priceDelta: importe.toDecimalString() },
      );
      return {
        id: fila.id,
        groupId: fila.group_id,
        name: fila.name,
        priceDelta: fila.price_delta,
        available: fila.available,
        sortOrder: fila.sort_order,
      };
    });
  }

  /**
   * Une un producto con un grupo de modificadores (M:N).
   *
   * Exige que ambos sean de la **misma marca**: la clave foránea solo comprueba
   * el tenant, así que sin esto un «¿con qué gaseosa?» de otra marca aparecería
   * en el producto y el cliente elegiría una bebida que la cocina no tiene.
   */
  async linkProductModifierGroup(
    tenantId: string,
    input: {
      productId: string;
      groupId: string;
      sortOrder?: number | undefined;
      actorId?: string | undefined;
    },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: producto } = await ctx.client.query<{ brand_id: string }>(
        'SELECT brand_id FROM cat_products WHERE id = $1',
        [input.productId],
      );
      if (!producto[0]) throw new NotFoundError('Producto no encontrado.');

      const { rows: grupo } = await ctx.client.query<{ brand_id: string }>(
        'SELECT brand_id FROM cat_modifier_groups WHERE id = $1',
        [input.groupId],
      );
      if (!grupo[0])
        throw new NotFoundError('Grupo de modificadores no encontrado.');

      if (grupo[0].brand_id !== producto[0].brand_id) {
        throw new ValidationError(
          'El grupo de modificadores es de otra marca: no se puede unir a este producto.',
        );
      }

      await ctx.client.query(
        `INSERT INTO cat_product_modifier_groups
           (tenant_id, product_id, group_id, sort_order)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, product_id, group_id) DO UPDATE
           SET sort_order = EXCLUDED.sort_order`,
        [tenantId, input.productId, input.groupId, input.sortOrder ?? 0],
      );

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.product_modifier_group_linked',
        'product',
        input.productId,
        { groupId: input.groupId },
      );
    });
  }

  /** Quita un grupo de un producto. */
  async unlinkProductModifierGroup(
    tenantId: string,
    input: { productId: string; groupId: string; actorId?: string | undefined },
  ): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rowCount } = await ctx.client.query(
        'DELETE FROM cat_product_modifier_groups WHERE product_id = $1 AND group_id = $2',
        [input.productId, input.groupId],
      );
      if (!rowCount) {
        throw new NotFoundError('Ese producto no tiene ese grupo asignado.');
      }
      await this.auditar(
        ctx,
        input.actorId,
        'catalog.product_modifier_group_unlinked',
        'product',
        input.productId,
        { groupId: input.groupId },
      );
    });
  }

  // -------------------------------------------------------------- Listado

  /**
   * La carta **tal como está**, para quien la administra.
   *
   * No es `getResolvedCatalog` con otro nombre, y la diferencia es justo lo que
   * hace falta aquí: aquel omite a propósito los productos sin precio para el
   * canal y los pausados, porque un cliente no debe verlos. Un panel que usara
   * esa vista **no podría enseñar el producto al que le falta el precio** —el
   * que hay que arreglar— ni el que está pausado —el que hay que reactivar—.
   * Sería una pantalla que oculta exactamente el trabajo pendiente.
   *
   * Devuelve todos los precios por ámbito, no uno resuelto: quien edita la
   * carta necesita ver que el mismo plato cuesta 55 de base y 69 en un
   * marketplace.
   */
  async listProducts(
    tenantId: string,
    query: { brandId: string },
  ): Promise<AdminProductView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: productos } = await ctx.client.query<{
        id: string;
        category_id: string | null;
        category_name: string | null;
        sku: string | null;
        name: string;
        active: boolean;
        is_combo: boolean;
        prep_minutes: number;
        image_url: string | null;
        row_version: number;
      }>(
        `SELECT p.id, p.category_id, c.name AS category_name, p.sku, p.name,
                p.active, p.is_combo, p.prep_minutes, p.image_url, p.row_version
           FROM cat_products p
           LEFT JOIN cat_categories c ON c.id = p.category_id
          WHERE p.brand_id = $1
          ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, p.name`,
        [query.brandId],
      );
      if (productos.length === 0) return [];

      const ids = productos.map((p) => p.id);
      const { rows: precios } = await ctx.client.query<{
        product_id: string;
        channel: string | null;
        location_id: string | null;
        price: string;
        active: boolean;
      }>(
        `SELECT product_id, channel, location_id, price, active
           FROM cat_prices WHERE product_id = ANY($1::uuid[])
          ORDER BY channel NULLS FIRST`,
        [ids],
      );
      const { rows: pausas } = await ctx.client.query<{
        product_id: string;
        channel: string;
        until: Date | null;
      }>(
        `SELECT product_id, channel, until
           FROM cat_product_pauses WHERE product_id = ANY($1::uuid[])`,
        [ids],
      );

      const preciosPor = new Map<string, AdminProductView['prices']>();
      for (const p of precios) {
        const lista = preciosPor.get(p.product_id) ?? [];
        lista.push({
          channel: p.channel,
          locationId: p.location_id,
          price: p.price,
          active: p.active,
        });
        preciosPor.set(p.product_id, lista);
      }

      const pausasPor = new Map<string, AdminProductView['pauses']>();
      for (const p of pausas) {
        const lista = pausasPor.get(p.product_id) ?? [];
        lista.push({
          channel: p.channel,
          until: p.until ? p.until.toISOString() : null,
        });
        pausasPor.set(p.product_id, lista);
      }

      return productos.map((p) => ({
        id: p.id,
        categoryId: p.category_id,
        categoryName: p.category_name,
        sku: p.sku,
        name: p.name,
        active: p.active,
        isCombo: p.is_combo,
        prepMinutes: p.prep_minutes,
        imageUrl: p.image_url,
        rowVersion: p.row_version,
        prices: preciosPor.get(p.id) ?? [],
        pauses: pausasPor.get(p.id) ?? [],
      }));
    });
  }

  // ---------------------------------------------------------------- Combo

  /**
   * Composición de un combo (RN-CAT-04). Se envía **entera y reemplaza**: un
   * combo es su lista de componentes, y aplicar la carta otra vez tiene que
   * dejarlo exactamente como dice el archivo, sin arrastrar un componente que
   * el dueño quitó.
   *
   * El precio del combo es el suyo propio (`setPrice`); los componentes son
   * para el consumo de inventario y el costo.
   */
  async setComboComponents(
    tenantId: string,
    input: {
      comboId: string;
      components: Array<{ productId: string; quantity: number }>;
      actorId?: string | undefined;
    },
  ): Promise<void> {
    for (const c of input.components) {
      if (!Number.isInteger(c.quantity) || c.quantity <= 0) {
        throw new ValidationError(
          'La cantidad de cada componente tiene que ser un entero positivo.',
        );
      }
      if (c.productId === input.comboId) {
        throw new ValidationError(
          'Un combo no puede contenerse a sí mismo: el costo no terminaría de calcularse nunca.',
        );
      }
    }

    await withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: combo } = await ctx.client.query<{
        brand_id: string;
        is_combo: boolean;
      }>('SELECT brand_id, is_combo FROM cat_products WHERE id = $1', [
        input.comboId,
      ]);
      if (!combo[0]) throw new NotFoundError('Combo no encontrado.');
      if (!combo[0].is_combo) {
        throw new ValidationError(
          'Ese producto no está marcado como combo: márcalo con "isCombo" antes de darle componentes.',
        );
      }

      for (const c of input.components) {
        const { rows } = await ctx.client.query<{ brand_id: string }>(
          'SELECT brand_id FROM cat_products WHERE id = $1',
          [c.productId],
        );
        if (!rows[0]) {
          throw new NotFoundError(`Componente ${c.productId} no encontrado.`);
        }
        if (rows[0].brand_id !== combo[0].brand_id) {
          throw new ValidationError(
            'Un componente es de otra marca: el combo no se podría producir en la misma cocina.',
          );
        }
      }

      await ctx.client.query(
        'DELETE FROM cat_combo_components WHERE combo_id = $1',
        [input.comboId],
      );
      for (const c of input.components) {
        await ctx.client.query(
          `INSERT INTO cat_combo_components
             (tenant_id, combo_id, component_id, quantity)
           VALUES ($1,$2,$3,$4)`,
          [tenantId, input.comboId, c.productId, c.quantity],
        );
      }

      await this.auditar(
        ctx,
        input.actorId,
        'catalog.combo_components_set',
        'product',
        input.comboId,
        { components: input.components.length },
      );
    });
  }

  // ----------------------------------------------------------------- Apoyo

  private async exigeMarca(ctx: TenantContext, brandId: string): Promise<void> {
    const { rows } = await ctx.client.query(
      'SELECT 1 FROM org_brands WHERE id = $1',
      [brandId],
    );
    if (!rows[0]) throw new NotFoundError('Marca no encontrada.');
  }

  /**
   * Pone o quita la foto de un producto.
   *
   * Endpoint ESTRECHO a propósito, como `pause` y `resume`. El `upsert` general
   * reescribe todos los campos —`image_url = $7`, `description = $6`, …— así que
   * usarlo para cambiar solo la foto obligaría a reenviar el producto entero, y
   * la lista del panel **no devuelve** la descripción ni los alérgenos: cada vez
   * que alguien cambiara una imagen borraría esos dos campos, sin ningún error a
   * la vista. Un producto que pierde sus alérgenos es un problema de salud, no
   * de datos.
   *
   * `null` quita la foto. Es la única forma de deshacer una URL mal pegada sin
   * pasar por el upsert entero.
   */
  async setProductImage(
    tenantId: string,
    productId: string,
    imageUrl: string | null,
    options: { actorId?: string | undefined } = {},
  ): Promise<{ id: string; imageUrl: string | null; rowVersion: number }> {
    if (imageUrl !== null) {
      let url: URL;
      try {
        url = new URL(imageUrl);
      } catch {
        throw new ValidationError(
          'La foto tiene que ser una dirección web completa, empezando por https://.',
        );
      }
      // Solo `https`. Esa URL acaba en un `<img>` de la tienda de un cliente:
      // servida por `http`, el navegador marca la página entera como insegura
      // —o bloquea la imagen— y el dueño ve su tienda «rota» sin saber por qué.
      if (url.protocol !== 'https:') {
        throw new ValidationError(
          'La foto tiene que servirse por https:// — con http el navegador la bloquea.',
        );
      }
      if (imageUrl.length > 500) {
        throw new ValidationError(
          'La dirección de la foto es demasiado larga.',
        );
      }
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        image_url: string | null;
        row_version: number;
      }>(
        `UPDATE cat_products
            SET image_url = $2, row_version = row_version + 1, updated_at = now()
          WHERE id = $1
          RETURNING id, image_url, row_version`,
        [productId, imageUrl],
      );
      const fila = rows[0];
      if (!fila) throw new NotFoundError('Producto no encontrado.');

      await this.auditar(
        ctx,
        options.actorId,
        imageUrl === null
          ? 'catalog.product_image_removed'
          : 'catalog.product_image_set',
        'product',
        fila.id,
        imageUrl === null ? {} : { imageUrl },
      );

      return {
        id: fila.id,
        imageUrl: fila.image_url,
        rowVersion: fila.row_version,
      };
    });
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

interface FilaCategoria {
  id: string;
  brand_id: string;
  name: string;
  sort_order: number;
  active: boolean;
}

interface FilaProducto {
  id: string;
  brand_id: string;
  category_id: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  prep_minutes: number;
  is_combo: boolean;
  active: boolean;
  row_version: number;
}

interface FilaPrecio {
  id: string;
  product_id: string;
  brand_id: string;
  channel: string | null;
  location_id: string | null;
  price: string;
  active: boolean;
}

interface FilaGrupo {
  id: string;
  brand_id: string;
  name: string;
  min_selections: number;
  max_selections: number;
  allow_repeat: boolean;
  sort_order: number;
}

interface FilaOpcion {
  id: string;
  group_id: string;
  name: string;
  price_delta: string;
  available: boolean;
  sort_order: number;
}
