import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  RequirePermission,
  type AuthenticatedRequest,
} from '../../../common/authz.js';
import { ValidationError } from '../../../common/errors.js';
import { InventoryService } from '../app/inventory.service.js';
import {
  InventoryAdminService,
  type ItemView,
  type RecipeView,
} from '../app/inventory-admin.service.js';

type StockView = Awaited<ReturnType<InventoryService['getStock']>>;
type AdjustResult = Awaited<ReturnType<InventoryService['recordAdjustment']>>;

/**
 * Inventario (spec 08 §API).
 *
 * Solo lectura de stock y ajuste manual. El consumo NO tiene endpoint a
 * propósito: ocurre por evento al aceptar el pedido, y exponerlo invitaría a
 * descontar a mano por encima del automático — dos caminos que descuentan lo
 * mismo son dos oportunidades de descontarlo dos veces.
 */

const ajusteSchema = z.object({
  warehouseId: z.string().uuid(),
  itemId: z.string().uuid(),
  /**
   * Cantidad CON SIGNO, como cadena decimal. Cadena y no número: el importe
   * pasa por `Quantity` sin tocar coma flotante, igual que el dinero.
   */
  quantity: z
    .string()
    .regex(
      /^-?\d+(\.\d{1,4})?$/,
      'La cantidad debe ser un decimal con hasta 4 decimales.',
    ),
  // Obligatorio, y también en la base. Un descuadre sin explicación es peor
  // que un descuadre: la respuesta a «¿por qué faltan 3 kg?» sería «alguien lo
  // ajustó».
  reason: z.string().min(3, 'Un ajuste de inventario necesita un motivo.'),
});

const insumoSchema = z.object({
  sku: z.string().max(60).optional(),
  name: z.string().min(2).max(160),
  unit: z.enum(['g', 'ml', 'unit']),
  /** Costo por unidad en unidades menores. Entero, nunca un decimal. */
  unitCostMinor: z.number().int().nonnegative().optional(),
  minStock: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, 'El mínimo es un decimal positivo.')
    .optional(),
  isActive: z.boolean().optional(),
});

const recetaSchema = z.object({
  name: z.string().min(2).max(160),
  productId: z.string().uuid().optional(),
  yieldQuantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
  yieldUnit: z.enum(['g', 'ml', 'unit']),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid().optional(),
        subRecipeId: z.string().uuid().optional(),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        // Puntos básicos enteros: 5 % = 500. Un decimal aquí sería la única
        // puerta por la que entraría coma flotante al cálculo de consumo.
        wasteBps: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .min(1, 'Una receta sin componentes no descuenta nada.'),
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

@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly admin: InventoryAdminService,
  ) {}

  // ------------------------------------------------- Insumos y recetas

  @Get('items')
  @RequirePermission('inventory.read')
  items(@Req() req: AuthenticatedRequest): Promise<ItemView[]> {
    return this.admin.listItems(req.auth!.tid);
  }

  /**
   * Alta o edición de un insumo, idempotente por SKU (o por nombre si no lo
   * hay). Exige `inventory.adjust` y no un permiso propio: quien puede mover
   * el stock a mano ya puede alterar el inventario, y un permiso más fino aquí
   * sería una distinción que nadie configuraría.
   */
  @Post('items')
  @RequirePermission('inventory.adjust')
  upsertItem(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ItemView> {
    const dto = parse(insumoSchema, body);
    return this.admin.upsertItem(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
    });
  }

  @Get('recipes')
  @RequirePermission('inventory.read')
  recipes(@Req() req: AuthenticatedRequest): Promise<RecipeView[]> {
    return this.admin.listRecipes(req.auth!.tid);
  }

  /** Guarda la receta ENTERA: las líneas se reemplazan, no se mezclan. */
  @Post('recipes')
  @RequirePermission('inventory.adjust')
  upsertRecipe(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<RecipeView> {
    const dto = parse(recetaSchema, body);
    return this.admin.upsertRecipe(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
    });
  }

  /** Stock por almacén, con la marca de bajo mínimo ya resuelta. */
  @Get('stock')
  @RequirePermission('inventory.read')
  stock(
    @Req() req: AuthenticatedRequest,
    @Query('warehouse') warehouse?: string,
  ): Promise<StockView> {
    return this.inventory.getStock(req.auth!.tid, {
      ...(warehouse ? { warehouseId: warehouse } : {}),
    });
  }

  /**
   * El kardex: qué movimientos explican el stock actual.
   *
   * Sin filtro devuelve los últimos movimientos del tenant, que es lo que se
   * mira al abrir la pantalla. Con `item` es la pregunta de verdad: «¿por qué
   * faltan 3 kg de carne?».
   */
  @Get('movements')
  @RequirePermission('inventory.read')
  movements(
    @Req() req: AuthenticatedRequest,
    @Query('item') item?: string,
    @Query('warehouse') warehouse?: string,
    @Query('order') order?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown[]> {
    return this.inventory.kardex(req.auth!.tid, {
      ...(item !== undefined ? { itemId: item } : {}),
      ...(warehouse !== undefined ? { warehouseId: warehouse } : {}),
      ...(order !== undefined ? { orderId: order } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  @Post('movements')
  @RequirePermission('inventory.adjust')
  adjust(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<AdjustResult> {
    const dto = parse(ajusteSchema, body);
    return this.inventory.recordAdjustment(req.auth!.tid, {
      ...dto,
      actorId: req.auth!.sub,
      ...(req.traceId !== undefined ? { traceId: req.traceId } : {}),
    });
  }

  /**
   * Valida una receta y sus subrecetas.
   *
   * Existe para que el editor pueda comprobar ANTES de guardar: un ciclo
   * descubierto al vender no es un error de validación, es la aceptación de
   * pedidos colgada dentro de su propia transacción.
   */
  @Post('recipes/:id/validate')
  @RequirePermission('inventory.adjust')
  async validate(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ valid: true }> {
    await this.inventory.validateRecipe(req.auth!.tid, id);
    return { valid: true };
  }
}
