import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { Money, Quantity, type Unit } from '@sahana/domain';
import { PG_POOL } from '../../../database/database.module.js';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { NotFoundError, ValidationError } from '../../../common/errors.js';
import { DomainError } from '../../../common/errors.js';
import { recordAudit } from '../../audit/index.js';
import { InventoryService, RecipeCycleError } from './inventory.service.js';

/**
 * La mitad de ESCRITURA del inventario (spec 08: «CRUD insumos/recetas»).
 *
 * Hasta ahora solo existía la de lectura, exactamente el mismo hueco que
 * tenían catálogo y organización antes de DT-10: un negocio nuevo no podía
 * declarar sus insumos ni sus recetas sin SQL, y sin receta el consumo
 * automático no se dispara nunca — así que el food cost, que es la razón por la
 * que existe este módulo, se quedaba en cero para todo el mundo menos para la
 * pollería de las semillas demo.
 *
 * Todo es **idempotente por clave natural** (SKU dentro del tenant, o nombre si
 * no hay SKU; para recetas, el producto al que cuelgan). Volver a aplicar el
 * mismo archivo de alta no duplica nada, que es lo que hace usable un alta por
 * archivo y una migración de datos de un cliente que llega con su Excel.
 */

export interface ItemView {
  id: string;
  sku: string | null;
  name: string;
  unit: Unit;
  unitCost: string;
  minStock: string | null;
  isActive: boolean;
}

export interface RecipeLineView {
  id: string;
  kind: 'item' | 'recipe';
  itemId: string | null;
  subRecipeId: string | null;
  name: string;
  quantity: string;
  wasteBps: number;
}

export interface RecipeView {
  id: string;
  name: string;
  productId: string | null;
  productName: string | null;
  yieldQuantity: string;
  yieldUnit: Unit;
  isActive: boolean;
  lines: RecipeLineView[];
}

/**
 * Cambiar la unidad de un insumo que ya se movió.
 *
 * Es 409 y no 422 porque el dato que se manda es válido: lo que no se puede es
 * aplicarlo AHORA, con ese histórico detrás. La diferencia importa para quien
 * consume la API — un 422 invita a corregir el campo, y aquí no hay nada que
 * corregir salvo crear otro insumo.
 */
export class UnitLockedError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/inventory-unit-locked';
  readonly title = 'La unidad del insumo ya no se puede cambiar';
  override readonly code = 'INVENTORY_UNIT_LOCKED';
}

const UNIDADES: readonly Unit[] = ['g', 'ml', 'unit'];

/**
 * Decimal escrito a mano → `Quantity`, con aritmética entera.
 *
 * El mismo criterio que el dinero y por el mismo motivo: pasar por `Number`
 * mete coma flotante en una cifra que luego se suma miles de veces en el
 * kardex. 275 g consumidos 50 veces tienen que dar 13 750 g exactos, no
 * 13 749,999999.
 */
function aCantidad(valor: string, unit: Unit, donde: string): Quantity {
  const m = /^(-)?(\d+)(?:[.,](\d{1,4}))?$/.exec(valor.trim());
  if (!m) {
    throw new ValidationError(
      `"${valor}" no es una cantidad válida en ${donde}. Escríbela como 275 o 0.275.`,
    );
  }
  const minor = Number(`${m[2]}${(m[3] ?? '').padEnd(4, '0')}`);
  return Quantity.fromMinorUnits(m[1] === '-' ? -minor : minor, unit);
}

function asegurarUnidad(unit: string, donde: string): Unit {
  if (!UNIDADES.includes(unit as Unit)) {
    throw new ValidationError(
      `Unidad desconocida en ${donde}: "${unit}". Solo hay g, ml y unit.`,
    );
  }
  return unit as Unit;
}

@Injectable()
export class InventoryAdminService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly inventory: InventoryService,
  ) {}

  // ------------------------------------------------------------- Insumos

  async listItems(tenantId: string): Promise<ItemView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        sku: string | null;
        name: string;
        unit: Unit;
        unit_cost: string;
        min_stock: string | null;
        is_active: boolean;
      }>(
        `SELECT id, sku, name, unit, unit_cost, min_stock, is_active
           FROM inv_items ORDER BY name`,
      );
      return rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        unitCost: Money.parse(r.unit_cost).toDecimalString(),
        minStock: r.min_stock
          ? Quantity.fromDatabase(r.min_stock, r.unit).toDatabase()
          : null,
        isActive: r.is_active,
      }));
    });
  }

  /**
   * Crea o actualiza un insumo. Clave natural: SKU, y si no hay, el nombre.
   *
   * **La unidad no se puede cambiar si el insumo ya se movió.** Es la regla que
   * parece burocracia y no lo es: el stock, el kardex y las recetas guardan
   * números sin unidad —la unidad vive en el insumo—, así que pasar de gramos a
   * mililitros no convierte nada, reinterpreta todo el histórico. 20 000 g de
   * pollo se convertirían en 20 000 ml de la nada, y el food cost de los meses
   * cerrados cambiaría sin que nadie tocara un movimiento.
   */
  async upsertItem(
    tenantId: string,
    input: {
      sku?: string | undefined;
      name: string;
      unit: string;
      /** Costo por unidad, en unidades menores. Nunca un decimal. */
      unitCostMinor?: number | undefined;
      minStock?: string | undefined;
      isActive?: boolean | undefined;
      actorId?: string | undefined;
    },
  ): Promise<ItemView> {
    const nombre = input.name.trim();
    if (nombre.length < 2) {
      throw new ValidationError('El insumo necesita un nombre.');
    }
    const unidad = asegurarUnidad(input.unit, `el insumo "${nombre}"`);
    const sku = input.sku?.trim() || null;
    const costo = Money.fromMinor(input.unitCostMinor ?? 0);
    if (costo.minorUnits < 0) {
      throw new ValidationError('El costo de un insumo no puede ser negativo.');
    }
    const minimo =
      input.minStock !== undefined && input.minStock !== ''
        ? aCantidad(input.minStock, unidad, `el mínimo de "${nombre}"`)
        : null;

    return withTenant(this.pool, tenantId, async (ctx) => {
      const existente = await this.buscarItem(ctx, sku, nombre);

      if (existente) {
        if (existente.unit !== unidad) {
          const { rows } = await ctx.client.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM inv_movements WHERE item_id = $1',
            [existente.id],
          );
          if (Number(rows[0]!.n) > 0) {
            throw new UnitLockedError(
              `"${nombre}" ya tiene movimientos en ${existente.unit}: cambiar la unidad reinterpretaría todo el histórico. Crea un insumo nuevo.`,
              { itemId: existente.id, currentUnit: existente.unit },
            );
          }
        }

        await ctx.client.query(
          `UPDATE inv_items
              SET sku = $2, name = $3, unit = $4, unit_cost = $5,
                  min_stock = $6, is_active = $7, updated_at = now()
            WHERE id = $1`,
          [
            existente.id,
            sku,
            nombre,
            unidad,
            costo.toDecimalString(),
            minimo?.toDatabase() ?? null,
            input.isActive ?? true,
          ],
        );
        await this.auditar(
          ctx,
          input.actorId,
          'inventory.item_updated',
          existente.id,
          { name: nombre },
        );
        return this.leerItem(ctx, existente.id);
      }

      const { rows } = await ctx.client.query<{ id: string }>(
        `INSERT INTO inv_items
           (tenant_id, sku, name, unit, unit_cost, min_stock, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          tenantId,
          sku,
          nombre,
          unidad,
          costo.toDecimalString(),
          minimo?.toDatabase() ?? null,
          input.isActive ?? true,
        ],
      );
      const id = rows[0]!.id;
      await this.auditar(ctx, input.actorId, 'inventory.item_created', id, {
        name: nombre,
        unit: unidad,
      });
      return this.leerItem(ctx, id);
    });
  }

  // ------------------------------------------------------------- Recetas

  async listRecipes(tenantId: string): Promise<RecipeView[]> {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows: recetas } = await ctx.client.query<{
        id: string;
        name: string;
        product_id: string | null;
        product_name: string | null;
        yield_quantity: string;
        yield_unit: Unit;
        is_active: boolean;
      }>(
        `SELECT r.id, r.name, r.product_id, p.name AS product_name,
                r.yield_quantity, r.yield_unit, r.is_active
           FROM inv_recipes r
           LEFT JOIN cat_products p ON p.id = r.product_id
          ORDER BY r.name`,
      );

      const { rows: lineas } = await ctx.client.query<{
        id: string;
        recipe_id: string;
        kind: 'item' | 'recipe';
        item_id: string | null;
        sub_recipe_id: string | null;
        name: string;
        quantity: string;
        unit: Unit;
        waste_bps: number;
      }>(
        `SELECT l.id, l.recipe_id, l.kind, l.item_id, l.sub_recipe_id,
                COALESCE(i.name, sr.name) AS name,
                l.quantity,
                COALESCE(i.unit, sr.yield_unit) AS unit,
                l.waste_bps
           FROM inv_recipe_lines l
           LEFT JOIN inv_items i    ON i.id = l.item_id
           LEFT JOIN inv_recipes sr ON sr.id = l.sub_recipe_id
          ORDER BY l.sort_order, l.id`,
      );

      return recetas.map((r) => ({
        id: r.id,
        name: r.name,
        productId: r.product_id,
        productName: r.product_name,
        yieldQuantity: Quantity.fromDatabase(
          r.yield_quantity,
          r.yield_unit,
        ).toDatabase(),
        yieldUnit: r.yield_unit,
        isActive: r.is_active,
        lines: lineas
          .filter((l) => l.recipe_id === r.id)
          .map((l) => ({
            id: l.id,
            kind: l.kind,
            itemId: l.item_id,
            subRecipeId: l.sub_recipe_id,
            name: l.name,
            quantity: Quantity.fromDatabase(l.quantity, l.unit).toDatabase(),
            wasteBps: l.waste_bps,
          })),
      }));
    });
  }

  /**
   * Crea o actualiza la receta de un producto, con sus componentes.
   *
   * Las líneas se **reemplazan enteras**, no se mezclan. Una receta es una
   * lista cerrada: fusionar por nombre dejaría ingredientes viejos dentro
   * cuando alguien quita uno, y el consumo seguiría descontando algo que ya no
   * lleva el plato.
   *
   * Y se **valida antes de devolver** (RN-INV-05): ciclos y más de tres
   * niveles se rechazan aquí, dentro de la transacción, no cuando llegue el
   * primer pedido a las ocho de la noche.
   */
  async upsertRecipe(
    tenantId: string,
    input: {
      name: string;
      productId?: string | undefined;
      yieldQuantity: string;
      yieldUnit: string;
      lines: Array<{
        itemId?: string | undefined;
        subRecipeId?: string | undefined;
        quantity: string;
        wasteBps?: number | undefined;
      }>;
      actorId?: string | undefined;
    },
  ): Promise<RecipeView> {
    const nombre = input.name.trim();
    if (nombre.length < 2) {
      throw new ValidationError('La receta necesita un nombre.');
    }
    if (input.lines.length === 0) {
      throw new ValidationError(
        'Una receta sin componentes no descuenta nada: añade al menos uno.',
      );
    }
    const unidad = asegurarUnidad(input.yieldUnit, `la receta "${nombre}"`);
    const rendimiento = aCantidad(
      input.yieldQuantity,
      unidad,
      `el rendimiento de "${nombre}"`,
    );
    if (rendimiento.minorUnits <= 0) {
      throw new ValidationError('El rendimiento de una receta es positivo.');
    }

    const recipeId = await withTenant(this.pool, tenantId, async (ctx) => {
      const existente = await this.buscarReceta(ctx, input.productId, nombre);

      let id: string;
      if (existente) {
        await ctx.client.query(
          `UPDATE inv_recipes
              SET name = $2, product_id = $3, yield_quantity = $4,
                  yield_unit = $5, is_active = true, updated_at = now()
            WHERE id = $1`,
          [
            existente,
            nombre,
            input.productId ?? null,
            rendimiento.toDatabase(),
            unidad,
          ],
        );
        id = existente;
        // Reemplazo, no mezcla: ver el comentario del método.
        await ctx.client.query(
          'DELETE FROM inv_recipe_lines WHERE recipe_id = $1',
          [id],
        );
      } else {
        const { rows } = await ctx.client.query<{ id: string }>(
          `INSERT INTO inv_recipes
             (tenant_id, name, product_id, yield_quantity, yield_unit)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [
            tenantId,
            nombre,
            input.productId ?? null,
            rendimiento.toDatabase(),
            unidad,
          ],
        );
        id = rows[0]!.id;
      }

      let orden = 0;
      for (const linea of input.lines) {
        const esItem = linea.itemId !== undefined && linea.itemId !== '';
        const esSub =
          linea.subRecipeId !== undefined && linea.subRecipeId !== '';
        if (esItem === esSub) {
          throw new ValidationError(
            'Cada componente es un insumo O una subreceta, no ambos ni ninguno.',
          );
        }
        // La base tiene una restricción para esto (`sin_autorreferencia`), pero
        // dejar que salte devuelve un 500 con el texto de Postgres dentro. La
        // restricción se queda como última línea de defensa; el mensaje
        // entendible se da aquí.
        if (esSub && linea.subRecipeId === id) {
          throw new RecipeCycleError(
            `"${nombre}" no puede llevarse a sí misma como componente.`,
          );
        }
        const unidadLinea = esItem
          ? await this.unidadDeItem(ctx, linea.itemId!)
          : await this.unidadDeReceta(ctx, linea.subRecipeId!);
        const cantidad = aCantidad(
          linea.quantity,
          unidadLinea,
          `un componente de "${nombre}"`,
        );
        if (cantidad.minorUnits <= 0) {
          throw new ValidationError(
            'La cantidad de un componente es positiva.',
          );
        }
        const merma = linea.wasteBps ?? 0;
        if (!Number.isInteger(merma) || merma < 0 || merma > 100_000) {
          // La merma va en PUNTOS BÁSICOS, como el resto de porcentajes del
          // sistema: un 5 % es 500, y un decimal aquí sería la única puerta
          // por la que entraría coma flotante al cálculo de consumo.
          throw new ValidationError(
            'La merma va en puntos básicos enteros (5 % = 500), entre 0 y 100000.',
          );
        }

        await ctx.client.query(
          `INSERT INTO inv_recipe_lines
             (tenant_id, recipe_id, kind, item_id, sub_recipe_id,
              quantity, waste_bps, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            tenantId,
            id,
            esItem ? 'item' : 'recipe',
            esItem ? linea.itemId : null,
            esSub ? linea.subRecipeId : null,
            cantidad.toDatabase(),
            merma,
            orden++,
          ],
        );
      }

      // Se valida DENTRO de la transacción, con el `ctx` que acaba de escribir
      // (RN-INV-05). Validar después de confirmar dejaba la receta cíclica
      // guardada aunque la petición fallara: el operador veía un error, creía
      // que no se había guardado nada, y el ciclo esperaba al primer pedido.
      // Cuesta tener las filas de la receta bloqueadas mientras se recorre el
      // árbol —son pocas y de un solo tenant— y a cambio un ciclo no llega a
      // existir.
      await this.inventory.validateRecipe(tenantId, id, ctx);

      await this.auditar(ctx, input.actorId, 'inventory.recipe_saved', id, {
        name: nombre,
        lines: input.lines.length,
      });
      return id;
    });

    const todas = await this.listRecipes(tenantId);
    return todas.find((r) => r.id === recipeId)!;
  }

  // ------------------------------------------------------------- Internos

  private async buscarItem(
    ctx: TenantContext,
    sku: string | null,
    nombre: string,
  ): Promise<{ id: string; unit: Unit } | null> {
    const { rows } = await ctx.client.query<{ id: string; unit: Unit }>(
      // Por SKU si lo hay —es la clave que trae el Excel del cliente— y por
      // nombre exacto si no. Buscar por nombre cuando hay SKU juntaría dos
      // insumos distintos que alguien llamó igual en dos almacenes.
      sku !== null
        ? 'SELECT id, unit FROM inv_items WHERE sku = $1 LIMIT 1'
        : 'SELECT id, unit FROM inv_items WHERE sku IS NULL AND lower(name) = lower($1) LIMIT 1',
      [sku ?? nombre],
    );
    return rows[0] ?? null;
  }

  private async buscarReceta(
    ctx: TenantContext,
    productId: string | undefined,
    nombre: string,
  ): Promise<string | null> {
    const { rows } = await ctx.client.query<{ id: string }>(
      productId
        ? 'SELECT id FROM inv_recipes WHERE product_id = $1 AND is_active LIMIT 1'
        : 'SELECT id FROM inv_recipes WHERE product_id IS NULL AND lower(name) = lower($1) LIMIT 1',
      [productId ?? nombre],
    );
    return rows[0]?.id ?? null;
  }

  private async unidadDeItem(
    ctx: TenantContext,
    itemId: string,
  ): Promise<Unit> {
    const { rows } = await ctx.client.query<{ unit: Unit }>(
      'SELECT unit FROM inv_items WHERE id = $1',
      [itemId],
    );
    if (!rows[0]) throw new NotFoundError('Insumo no encontrado.');
    return rows[0].unit;
  }

  private async unidadDeReceta(
    ctx: TenantContext,
    recipeId: string,
  ): Promise<Unit> {
    const { rows } = await ctx.client.query<{ yield_unit: Unit }>(
      'SELECT yield_unit FROM inv_recipes WHERE id = $1',
      [recipeId],
    );
    if (!rows[0]) throw new NotFoundError('Subreceta no encontrada.');
    return rows[0].yield_unit;
  }

  private async leerItem(ctx: TenantContext, id: string): Promise<ItemView> {
    const { rows } = await ctx.client.query<{
      id: string;
      sku: string | null;
      name: string;
      unit: Unit;
      unit_cost: string;
      min_stock: string | null;
      is_active: boolean;
    }>(
      `SELECT id, sku, name, unit, unit_cost, min_stock, is_active
         FROM inv_items WHERE id = $1`,
      [id],
    );
    const r = rows[0]!;
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      unitCost: Money.parse(r.unit_cost).toDecimalString(),
      minStock: r.min_stock
        ? Quantity.fromDatabase(r.min_stock, r.unit).toDatabase()
        : null,
      isActive: r.is_active,
    };
  }

  private async auditar(
    ctx: TenantContext,
    actorId: string | undefined,
    action: string,
    resourceId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(ctx, {
      actorType: 'user',
      ...(actorId !== undefined ? { actorId } : {}),
      action,
      resourceType: 'inventory',
      resourceId,
      data,
    });
  }
}
