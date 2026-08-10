import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  Money,
  Quantity,
  calculateConsumption,
  reverseConsumption,
  assertValidRecipe,
  RecipeError,
  type ConsumptionEntry,
  type Recipe,
  type RecipeBook,
  type Unit,
} from '@sahana/domain';
import { withTenant, type TenantContext } from '../../../database/rls.js';
import { PG_POOL } from '../../../database/database.module.js';
import { recordAudit } from '../../audit/index.js';
import { enqueueEvent } from '../../../events/outbox.js';
import {
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors.js';

/**
 * Inventario: recetas y consumo automático (spec 08 parcial, T4.25).
 *
 * La regla que gobierna todo lo de abajo es RN-INV-02: **jamás se bloquea una
 * venta por stock**. El inventario de un restaurante siempre va por detrás de
 * la realidad —nadie registra la merma en hora punta—, así que un stock a cero
 * es casi siempre un dato viejo y no una despensa vacía. Un sistema que corta
 * ventas con ese dato hace más daño del que evita.
 *
 * De ahí salen dos consecuencias que se ven en el código:
 *
 * · El consumo **avisa** (stock negativo, bajo mínimo) y sigue adelante.
 * · Un producto sin receta no es un error: se anota y se sigue. Lo que no se
 *   puede es dar por hecho que cuesta cero.
 */

export class RecipeCycleError extends ValidationError {
  override readonly code = 'RECIPE_CYCLE';
}
export class RecipeInvalidError extends ValidationError {
  override readonly code = 'RECIPE_INVALID';
}
/**
 * No hay almacén del que descontar. Es 409 y no 404: el pedido y el local
 * existen, lo que falta es una configuración que alguien tiene que completar.
 */
export class WarehouseNotConfiguredError extends DomainError {
  readonly status = 409;
  readonly type = 'https://errors.sahana.food/warehouse-not-configured';
  readonly title = 'Almacén no configurado';
  override readonly code = 'WAREHOUSE_NOT_CONFIGURED';
}

/** Aviso de inventario. No bloquea nada: informa. */
export interface StockAlert {
  itemId: string;
  itemName: string;
  kind: 'negative' | 'below_minimum';
  quantity: string;
  minStock?: string | undefined;
}

export interface ConsumptionSummary {
  orderId: string;
  warehouseId: string;
  movements: number;
  alerts: StockAlert[];
  /** Productos vendidos sin receta: no rompen la venta, pero no están costeados. */
  productsWithoutRecipe: string[];
  /** `true` si el pedido ya estaba consumido (entrega repetida del evento). */
  alreadyConsumed: boolean;
}

interface FilaMovimiento {
  item_id: string;
  quantity: string;
  unit: Unit;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Consumo
  // -------------------------------------------------------------------------

  /**
   * Descuenta el inventario de un pedido (RN-INV-01).
   *
   * Corre dentro de la transacción del consumidor de eventos cuando se le pasa
   * `ctx`: así el consumo y la marca en `inbox` se escriben juntos, y el
   * exactamente-una-vez efectivo también cubre el inventario.
   */
  async consumeForOrder(
    tenantId: string,
    orderId: string,
    options: { ctx?: TenantContext; traceId?: string } = {},
  ): Promise<ConsumptionSummary> {
    const ejecutar = (ctx: TenantContext): Promise<ConsumptionSummary> =>
      this.consumirEnContexto(ctx, orderId, options.traceId);

    return options.ctx
      ? ejecutar(options.ctx)
      : withTenant(this.pool, tenantId, ejecutar);
  }

  private async consumirEnContexto(
    ctx: TenantContext,
    orderId: string,
    traceId?: string,
  ): Promise<ConsumptionSummary> {
    const pedido = await this.cargarPedido(ctx, orderId);
    const almacen = await this.resolverAlmacen(
      ctx,
      pedido.location_id,
      pedido.brand_id,
    );

    // Idempotencia a nivel de datos: si ya hay consumo de este pedido, no se
    // repite. El índice único lo hace imposible, pero comprobarlo antes evita
    // que una entrega repetida acabe en un error de clave duplicada que el
    // worker interpretaría como fallo y reintentaría en bucle.
    const { rows: yaHay } = await ctx.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inv_movements
        WHERE order_id = $1 AND kind = 'consumption'`,
      [orderId],
    );
    if (Number(yaHay[0]?.n ?? 0) > 0) {
      return {
        orderId,
        warehouseId: almacen,
        movements: 0,
        alerts: [],
        productsWithoutRecipe: [],
        alreadyConsumed: true,
      };
    }

    const lineas = await this.cargarLineas(ctx, orderId);
    const libro = await this.cargarLibroDeRecetas(ctx);

    const consumo = calculateConsumption(lineas, libro);

    if (consumo.productsWithoutRecipe.length > 0) {
      // Se deja constancia: el food cost tiene que saber que ese plato no está
      // costeado, en vez de dar por hecho que cuesta cero.
      this.logger.debug(
        `Pedido ${orderId}: ${consumo.productsWithoutRecipe.length} producto(s) sin receta.`,
      );
    }

    const alertas = await this.aplicarMovimientos(ctx, {
      entries: consumo.entries,
      warehouseId: almacen,
      kind: 'consumption',
      orderId,
      brandId: pedido.brand_id,
      ...(traceId ? { traceId } : {}),
    });

    return {
      orderId,
      warehouseId: almacen,
      movements: consumo.entries.length,
      alerts: alertas,
      productsWithoutRecipe: consumo.productsWithoutRecipe,
      alreadyConsumed: false,
    };
  }

  /**
   * Deshace el consumo de un pedido cancelado (RN-INV-03).
   *
   * `preparado = false` → reversa: la comida no se hizo y los insumos siguen
   * en la despensa. `preparado = true` → merma: la comida se hizo y se tira, y
   * el costo NO vuelve al inventario porque la carne ya no está.
   *
   * Se invierten los MOVIMIENTOS ESCRITOS, no se recalcula la receta. La spec
   * pide que la reversa sea exacta, y recalcular daría otro resultado si
   * alguien editó la receta entre medias: el kardex quedaría con un residuo que
   * nadie sabe explicar.
   */
  async reverseForOrder(
    tenantId: string,
    orderId: string,
    options: {
      ctx?: TenantContext;
      prepared: boolean;
      reason: string;
      actorId?: string;
      traceId?: string;
    },
  ): Promise<{ movements: number; kind: 'reversal' | 'waste' }> {
    const ejecutar = async (
      ctx: TenantContext,
    ): Promise<{ movements: number; kind: 'reversal' | 'waste' }> => {
      const { rows } = await ctx.client.query<
        FilaMovimiento & { warehouse_id: string; brand_id: string | null }
      >(
        `SELECT m.item_id, m.quantity, m.warehouse_id, m.brand_id, i.unit
           FROM inv_movements m
           JOIN inv_items i ON i.id = m.item_id
          WHERE m.order_id = $1 AND m.kind = 'consumption'
          ORDER BY m.item_id`,
        [orderId],
      );

      if (rows.length === 0) return { movements: 0, kind: 'reversal' };

      // Ya revertido: cancelar dos veces no puede devolver dos veces la carne.
      const { rows: yaRevertido } = await ctx.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM inv_movements
          WHERE order_id = $1 AND kind IN ('reversal','waste')`,
        [orderId],
      );
      if (Number(yaRevertido[0]?.n ?? 0) > 0) {
        return {
          movements: 0,
          kind: options.prepared ? 'waste' : 'reversal',
        };
      }

      const consumido: ConsumptionEntry[] = rows.map((r) => ({
        itemId: r.item_id,
        quantity: Quantity.fromDatabase(r.quantity, r.unit),
      }));

      // La merma NO devuelve stock: la comida se preparó y se tiró. Solo deja
      // el movimiento con su motivo, para que el costo quede atribuido.
      const entradas = options.prepared
        ? consumido.map((e) => ({
            ...e,
            quantity: Quantity.zero(e.quantity.unit),
          }))
        : reverseConsumption(consumido);

      if (options.prepared) {
        await this.registrarMerma(ctx, {
          orderId,
          rows,
          reason: options.reason,
          ...(options.actorId ? { actorId: options.actorId } : {}),
          ...(options.traceId ? { traceId: options.traceId } : {}),
        });
        return { movements: rows.length, kind: 'waste' };
      }

      await this.aplicarMovimientos(ctx, {
        entries: entradas,
        warehouseId: rows[0]!.warehouse_id,
        kind: 'reversal',
        orderId,
        brandId: rows[0]!.brand_id,
        reason: options.reason,
        ...(options.actorId ? { actorId: options.actorId } : {}),
        ...(options.traceId ? { traceId: options.traceId } : {}),
      });

      return { movements: entradas.length, kind: 'reversal' };
    };

    return options.ctx
      ? ejecutar(options.ctx)
      : withTenant(this.pool, tenantId, ejecutar);
  }

  /**
   * Merma: la comida se preparó y se tira. El stock NO vuelve —la carne ya no
   * está— pero el movimiento queda con su motivo para que el costo se atribuya
   * a la marca y no desaparezca del análisis de margen.
   */
  private async registrarMerma(
    ctx: TenantContext,
    datos: {
      orderId: string;
      rows: Array<
        FilaMovimiento & { warehouse_id: string; brand_id: string | null }
      >;
      reason: string;
      actorId?: string;
      traceId?: string;
    },
  ): Promise<void> {
    for (const fila of datos.rows) {
      // Cantidad cero no cabe (`movimiento_no_nulo`), así que la merma se
      // registra con el signo del consumo original: es lo que se perdió.
      await ctx.client.query(
        `INSERT INTO inv_movements
           (tenant_id, warehouse_id, item_id, kind, quantity, unit_cost,
            order_id, brand_id, reason, actor_id, trace_id)
         SELECT $1, $2, $3, 'waste', $4, i.unit_cost, $5, $6, $7, $8, $9
           FROM inv_items i WHERE i.id = $3`,
        [
          ctx.tenantId,
          fila.warehouse_id,
          fila.item_id,
          fila.quantity,
          datos.orderId,
          fila.brand_id,
          datos.reason,
          datos.actorId ?? null,
          datos.traceId ?? null,
        ],
      );
    }
  }

  /**
   * Escribe los movimientos y actualiza el stock materializado.
   *
   * Dos cosas la hacen segura con 50 pedidos simultáneos sobre el mismo insumo:
   *
   * 1. **Las entradas llegan ORDENADAS por `itemId`** (lo garantiza el
   *    dominio). Dos transacciones que tocan los mismos insumos los bloquean en
   *    el mismo orden, así que no pueden esperarse mutuamente.
   * 2. **`ON CONFLICT DO UPDATE` con suma relativa.** El nuevo valor se calcula
   *    dentro del UPDATE, con la fila ya bloqueada. Leer y escribir por
   *    separado —que es lo natural— perdería actualizaciones exactamente en
   *    hora punta.
   */
  private async aplicarMovimientos(
    ctx: TenantContext,
    datos: {
      entries: readonly ConsumptionEntry[];
      warehouseId: string;
      kind: 'consumption' | 'reversal' | 'adjustment' | 'waste' | 'purchase';
      orderId?: string | null;
      brandId?: string | null;
      reason?: string;
      actorId?: string;
      traceId?: string;
    },
  ): Promise<StockAlert[]> {
    const alertas: StockAlert[] = [];

    for (const entrada of datos.entries) {
      if (entrada.quantity.isZero()) continue;

      // El consumo descuenta: el dominio devuelve cantidades positivas y el
      // signo lo pone aquí, en un solo sitio.
      const cantidad =
        datos.kind === 'consumption'
          ? entrada.quantity.negate()
          : entrada.quantity;

      const { rows: insumo } = await ctx.client.query<{
        id: string;
        name: string;
        unit: Unit;
        unit_cost: string;
        min_stock: string | null;
      }>(
        `SELECT id, name, unit, unit_cost, min_stock FROM inv_items WHERE id = $1`,
        [entrada.itemId],
      );
      const item = insumo[0];
      if (!item) {
        throw new NotFoundError(`No existe el insumo ${entrada.itemId}.`);
      }

      await ctx.client.query(
        `INSERT INTO inv_movements
           (tenant_id, warehouse_id, item_id, kind, quantity, unit_cost,
            order_id, brand_id, reason, actor_id, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          ctx.tenantId,
          datos.warehouseId,
          entrada.itemId,
          datos.kind,
          cantidad.toDatabase(),
          item.unit_cost,
          datos.orderId ?? null,
          datos.brandId ?? null,
          datos.reason ?? null,
          datos.actorId ?? null,
          datos.traceId ?? null,
        ],
      );

      const { rows: stock } = await ctx.client.query<{ quantity: string }>(
        `INSERT INTO inv_stock (tenant_id, warehouse_id, item_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, warehouse_id, item_id) DO UPDATE
           SET quantity = inv_stock.quantity + EXCLUDED.quantity,
               updated_at = now()
         RETURNING quantity`,
        [
          ctx.tenantId,
          datos.warehouseId,
          entrada.itemId,
          cantidad.toDatabase(),
        ],
      );

      const resultante = Quantity.fromDatabase(stock[0]!.quantity, item.unit);
      const alerta = this.evaluarAlerta(item, resultante);
      if (alerta) alertas.push(alerta);
    }

    return alertas;
  }

  /**
   * Un negativo o un bajo mínimo son AVISOS. Nunca cortan la venta (RN-INV-02):
   * el aviso llega al panel, la comida sale igual.
   */
  private evaluarAlerta(
    item: { id: string; name: string; unit: Unit; min_stock: string | null },
    resultante: Quantity,
  ): StockAlert | null {
    if (resultante.isNegative()) {
      return {
        itemId: item.id,
        itemName: item.name,
        kind: 'negative',
        quantity: resultante.toDatabase(),
      };
    }
    if (item.min_stock !== null) {
      const minimo = Quantity.fromDatabase(item.min_stock, item.unit);
      if (resultante.compare(minimo) < 0) {
        return {
          itemId: item.id,
          itemName: item.name,
          kind: 'below_minimum',
          quantity: resultante.toDatabase(),
          minStock: minimo.toDatabase(),
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Lecturas auxiliares
  // -------------------------------------------------------------------------

  private async cargarPedido(
    ctx: TenantContext,
    orderId: string,
  ): Promise<{ id: string; brand_id: string; location_id: string }> {
    const { rows } = await ctx.client.query<{
      id: string;
      brand_id: string;
      location_id: string;
    }>(`SELECT id, brand_id, location_id FROM ord_orders WHERE id = $1`, [
      orderId,
    ]);
    const pedido = rows[0];
    if (!pedido) throw new NotFoundError(`No existe el pedido ${orderId}.`);
    return pedido;
  }

  private async cargarLineas(
    ctx: TenantContext,
    orderId: string,
  ): Promise<Array<{ productId: string; quantity: number }>> {
    const { rows } = await ctx.client.query<{
      product_id: string | null;
      quantity: number;
    }>(
      `SELECT product_id, quantity FROM ord_order_lines
        WHERE order_id = $1 ORDER BY created_at, id`,
      [orderId],
    );
    // Una línea sin `product_id` es texto libre (un cargo, un ajuste manual):
    // no hay nada que descontar y no es un error.
    return rows
      .filter((r): r is { product_id: string; quantity: number } =>
        Boolean(r.product_id),
      )
      .map((r) => ({ productId: r.product_id, quantity: r.quantity }));
  }

  /**
   * Trae TODAS las recetas del tenant de una vez.
   *
   * Un tenant tiene decenas de recetas, no miles, y el estallido necesita
   * navegar subrecetas: ir a la base por cada nivel dentro de la transacción
   * del pedido convertiría un cálculo en una cascada de consultas justo en el
   * camino crítico de aceptar un pedido.
   */
  private async cargarLibroDeRecetas(ctx: TenantContext): Promise<RecipeBook> {
    const { rows: recetas } = await ctx.client.query<{
      id: string;
      product_id: string | null;
      yield_quantity: string;
      yield_unit: Unit;
    }>(
      `SELECT id, product_id, yield_quantity, yield_unit
         FROM inv_recipes WHERE is_active`,
    );

    const { rows: lineas } = await ctx.client.query<{
      recipe_id: string;
      kind: 'item' | 'recipe';
      item_id: string | null;
      sub_recipe_id: string | null;
      quantity: string;
      waste_bps: number;
      unit: Unit | null;
    }>(
      `SELECT l.recipe_id, l.kind, l.item_id, l.sub_recipe_id, l.quantity,
              l.waste_bps,
              -- La unidad de una línea de insumo es la del insumo; la de una
              -- subreceta, la de su rendimiento.
              COALESCE(i.unit, sr.yield_unit) AS unit
         FROM inv_recipe_lines l
         LEFT JOIN inv_items   i  ON i.id  = l.item_id
         LEFT JOIN inv_recipes sr ON sr.id = l.sub_recipe_id
        ORDER BY l.recipe_id, l.sort_order, l.id`,
    );

    const porReceta = new Map<string, Recipe>();
    for (const r of recetas) {
      porReceta.set(r.id, {
        id: r.id,
        yieldQuantity: Quantity.fromDatabase(r.yield_quantity, r.yield_unit),
        lines: [],
      });
    }
    for (const l of lineas) {
      const receta = porReceta.get(l.recipe_id);
      if (!receta || !l.unit) continue;
      receta.lines.push({
        kind: l.kind,
        componentId: (l.kind === 'item' ? l.item_id : l.sub_recipe_id)!,
        quantity: Quantity.fromDatabase(l.quantity, l.unit),
        wasteBps: l.waste_bps,
      });
    }

    const { rows: combos } = await ctx.client.query<{
      combo_id: string;
      component_id: string;
      quantity: number;
    }>(`SELECT combo_id, component_id, quantity FROM cat_combo_components`);

    const porCombo = new Map<
      string,
      Array<{ productId: string; quantity: number }>
    >();
    for (const c of combos) {
      const lista = porCombo.get(c.combo_id) ?? [];
      lista.push({ productId: c.component_id, quantity: c.quantity });
      porCombo.set(c.combo_id, lista);
    }

    return {
      recipes: porReceta,
      productRecipe: new Map(
        recetas
          .filter((r) => r.product_id)
          .map((r) => [r.product_id!, r.id] as const),
      ),
      comboComponents: porCombo,
    };
  }

  /**
   * De qué almacén se descuenta (RN-INV-01).
   *
   * Prioridad: el almacén de la cocina que sirve esa marca en ese local →
   * el almacén general del local. Si no hay ninguno, se falla en vez de
   * inventar uno: descontar del almacén equivocado ensucia dos inventarios a
   * la vez y nadie lo nota hasta el conteo.
   */
  private async resolverAlmacen(
    ctx: TenantContext,
    locationId: string,
    brandId: string,
  ): Promise<string> {
    const { rows } = await ctx.client.query<{ id: string }>(
      `SELECT w.id
         FROM org_warehouses w
         JOIN org_brand_kitchens bk ON bk.kitchen_id = w.kitchen_id
        WHERE w.location_id = $1 AND bk.brand_id = $2 AND w.active
        LIMIT 1`,
      [locationId, brandId],
    );
    if (rows[0]) return rows[0].id;

    const { rows: general } = await ctx.client.query<{ id: string }>(
      `SELECT id FROM org_warehouses
        WHERE location_id = $1 AND kitchen_id IS NULL AND active
        ORDER BY created_at LIMIT 1`,
      [locationId],
    );
    if (general[0]) return general[0].id;

    throw new WarehouseNotConfiguredError(
      `El local ${locationId} no tiene ningún almacén activo: no se puede descontar inventario.`,
    );
  }

  // -------------------------------------------------------------------------
  // API de consulta y ajuste
  // -------------------------------------------------------------------------

  async getStock(
    tenantId: string,
    filtros: { warehouseId?: string } = {},
  ): Promise<
    Array<{
      warehouseId: string;
      warehouseName: string;
      itemId: string;
      itemName: string;
      unit: Unit;
      quantity: string;
      minStock: string | null;
      belowMinimum: boolean;
    }>
  > {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        warehouse_id: string;
        warehouse_name: string;
        item_id: string;
        item_name: string;
        unit: Unit;
        quantity: string;
        min_stock: string | null;
      }>(
        `SELECT s.warehouse_id, w.name AS warehouse_name,
                s.item_id, i.name AS item_name, i.unit,
                s.quantity, i.min_stock
           FROM inv_stock s
           JOIN org_warehouses w ON w.id = s.warehouse_id
           JOIN inv_items i      ON i.id = s.item_id
          WHERE ($1::uuid IS NULL OR s.warehouse_id = $1)
          ORDER BY w.name, i.name`,
        [filtros.warehouseId ?? null],
      );

      return rows.map((r) => {
        const cantidad = Quantity.fromDatabase(r.quantity, r.unit);
        const minimo =
          r.min_stock === null
            ? null
            : Quantity.fromDatabase(r.min_stock, r.unit);
        return {
          warehouseId: r.warehouse_id,
          warehouseName: r.warehouse_name,
          itemId: r.item_id,
          itemName: r.item_name,
          unit: r.unit,
          quantity: cantidad.toDatabase(),
          minStock: minimo?.toDatabase() ?? null,
          belowMinimum: minimo ? cantidad.compare(minimo) < 0 : false,
        };
      });
    });
  }

  /**
   * El KARDEX de un insumo: por qué el stock es el que es.
   *
   * `inv_movements` es append-only por diseño (RN-INV-02) —`UPDATE` y `DELETE`
   * están revocados al rol de aplicación— y eso solo tiene sentido si alguien
   * puede LEERLO. Se escribía en tres sitios desde F4 y ninguna ruta lo
   * devolvía: el libro existía, era inalterable, y era ilegible. Cuando alguien
   * preguntaba por qué faltan 3 kg de carne, la respuesta seguía siendo
   * «alguien lo ajustó», que es exactamente lo que la restricción de motivo
   * obligatorio venía a evitar.
   *
   * Devuelve además el **costo unitario del momento** (RN-INV-04), que es el
   * dato del que depende todo F6: sin poder mirarlo, «teórico vs real» no se
   * puede ni empezar a conciliar.
   */
  async kardex(
    tenantId: string,
    filtros: {
      itemId?: string | undefined;
      warehouseId?: string | undefined;
      orderId?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<
    Array<{
      id: string;
      occurredAt: string;
      kind: string;
      itemId: string;
      itemName: string;
      warehouseId: string;
      warehouseName: string;
      unit: Unit;
      quantity: string;
      unitCost: string;
      orderId: string | null;
      orderNumber: number | null;
      reason: string | null;
    }>
  > {
    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        occurred_at: Date;
        kind: string;
        item_id: string;
        item_name: string;
        warehouse_id: string;
        warehouse_name: string;
        unit: Unit;
        quantity: string;
        unit_cost: string;
        order_id: string | null;
        order_number: number | null;
        reason: string | null;
      }>(
        `SELECT m.id, m.occurred_at, m.kind, m.item_id, i.name AS item_name,
                m.warehouse_id, w.name AS warehouse_name, i.unit,
                m.quantity, m.unit_cost, m.order_id, o.order_number, m.reason
           FROM inv_movements m
           JOIN inv_items i      ON i.id = m.item_id
           JOIN org_warehouses w ON w.id = m.warehouse_id
           LEFT JOIN ord_orders o ON o.id = m.order_id
          WHERE ($1::uuid IS NULL OR m.item_id = $1)
            AND ($2::uuid IS NULL OR m.warehouse_id = $2)
            AND ($3::uuid IS NULL OR m.order_id = $3)
          ORDER BY m.occurred_at DESC, m.id DESC
          LIMIT $4`,
        [
          filtros.itemId ?? null,
          filtros.warehouseId ?? null,
          filtros.orderId ?? null,
          Math.min(filtros.limit ?? 100, 500),
        ],
      );

      return rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at.toISOString(),
        kind: r.kind,
        itemId: r.item_id,
        itemName: r.item_name,
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        unit: r.unit,
        // La cantidad viaja CON SIGNO, como está en la tabla: quitarle el signo
        // aquí obligaría a la pantalla a deducirlo del tipo, que es justo la
        // tabla de signos que la migración evitó a propósito.
        quantity: Quantity.fromDatabase(r.quantity, r.unit).toDatabase(),
        unitCost: Money.parse(r.unit_cost).toDecimalString(),
        orderId: r.order_id,
        orderNumber: r.order_number,
        reason: r.reason,
      }));
    });
  }

  /**
   * Ajuste manual. Exige motivo —lo impone también la base— porque un
   * descuadre sin explicación es peor que un descuadre: cuando alguien
   * pregunte por qué faltan 3 kg de carne, la respuesta sería «alguien lo
   * ajustó».
   */
  async recordAdjustment(
    tenantId: string,
    datos: {
      warehouseId: string;
      itemId: string;
      /** Con signo: negativo descuenta, positivo repone. */
      quantity: string;
      reason: string;
      actorId: string;
      traceId?: string;
    },
  ): Promise<{ quantity: string; alert: StockAlert | null }> {
    if (!datos.reason?.trim()) {
      throw new ValidationError('Un ajuste de inventario necesita un motivo.');
    }

    return withTenant(this.pool, tenantId, async (ctx) => {
      const { rows } = await ctx.client.query<{
        id: string;
        name: string;
        unit: Unit;
        min_stock: string | null;
      }>(`SELECT id, name, unit, min_stock FROM inv_items WHERE id = $1`, [
        datos.itemId,
      ]);
      const item = rows[0];
      if (!item) {
        // Sin repetir el id en el mensaje. Aquí llega el identificador que
        // mandó quien llama, y si es de otro tenant la respuesta acabaría
        // llevando un dato ajeno — el harness de aislamiento lo marca como
        // fuga, y tiene razón: una respuesta nuestra no reproduce ids que no
        // son del tenant que pregunta.
        throw new NotFoundError(
          'No existe ese insumo, o no pertenece a este tenant.',
        );
      }

      const cantidad = Quantity.fromDatabase(datos.quantity, item.unit);
      if (cantidad.isZero()) {
        throw new ValidationError('Un ajuste de cero no ajusta nada.');
      }

      const alertas = await this.aplicarMovimientos(ctx, {
        entries: [{ itemId: item.id, quantity: cantidad }],
        warehouseId: datos.warehouseId,
        kind: 'adjustment',
        reason: datos.reason,
        actorId: datos.actorId,
        ...(datos.traceId ? { traceId: datos.traceId } : {}),
      });

      const { rows: stock } = await ctx.client.query<{ quantity: string }>(
        `SELECT quantity FROM inv_stock
          WHERE warehouse_id = $1 AND item_id = $2`,
        [datos.warehouseId, item.id],
      );

      await recordAudit(ctx, {
        actorType: 'user',
        actorId: datos.actorId,
        action: 'inventory.adjusted',
        resourceType: 'inv_item',
        resourceId: item.id,
        reason: datos.reason,
        data: {
          warehouseId: datos.warehouseId,
          quantity: cantidad.toDatabase(),
        },
        ...(datos.traceId ? { traceId: datos.traceId } : {}),
      });

      return {
        quantity: stock[0]?.quantity ?? '0.0000',
        alert: alertas[0] ?? null,
      };
    });
  }

  /**
   * Valida una receta completa antes de guardarla.
   *
   * Un ciclo tiene que rebotar AQUÍ, con el editor delante, y no dentro de la
   * transacción que acepta un pedido: allí no sería un error de validación,
   * sería la aceptación de pedidos colgada.
   */
  async validateRecipe(tenantId: string, recipeId: string): Promise<void> {
    await withTenant(this.pool, tenantId, async (ctx) => {
      const libro = await this.cargarLibroDeRecetas(ctx);
      try {
        assertValidRecipe(recipeId, libro);
      } catch (error) {
        if (error instanceof RecipeError) {
          if (error.code === 'RECIPE_CYCLE') {
            throw new RecipeCycleError(error.message);
          }
          throw new RecipeInvalidError(error.message);
        }
        throw error;
      }
    });
  }

  /** Emite el aviso de stock por outbox para que lo recoja el panel. */
  async publishAlerts(
    ctx: TenantContext,
    orderId: string,
    alertas: readonly StockAlert[],
  ): Promise<void> {
    if (alertas.length === 0) return;
    await enqueueEvent(ctx, {
      aggregateType: 'inventory',
      aggregateId: orderId,
      eventType: 'inventory.stock_alert',
      payload: { orderId, alerts: alertas },
    });
  }
}
