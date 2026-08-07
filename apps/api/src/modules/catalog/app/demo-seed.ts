import { Money } from '@sahana/domain';
import type { TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';

/**
 * Catálogo demo, usado por los E2E de las fases 4+.
 *
 * Está construido para ejercitar los casos que rompen: un producto con precio
 * distinto por canal (que es la palanca de rentabilidad del negocio), otro sin
 * precio en un canal (que debe volverse invisible ahí), grupos de modificadores
 * obligatorios y opcionales, y un combo.
 */

export interface DemoCatalog {
  categoryId: string;
  /** Precio base 30, web 32, y en el local 1 de web: 35. */
  polloId: string;
  /** Solo tiene precio en POS: invisible en web (RN-CAT-01). */
  soloPosId: string;
  comboId: string;
  groupTamanoId: string;
  groupExtrasId: string;
  optionGrandeId: string;
  optionQuesoId: string;
}

export async function seedDemoCatalog(
  ctx: TenantContext,
  input: { brandId: string; locationId: string },
): Promise<DemoCatalog> {
  const tenantId = ctx.tenantId;
  const { brandId, locationId } = input;

  const [category] = await ctx.db
    .insert(schema.categories)
    .values({ tenantId, brandId, name: 'Platos principales', sortOrder: 1 })
    .returning({ id: schema.categories.id });
  const categoryId = category!.id;

  // --- Grupos de modificadores ---
  const [tamano] = await ctx.db
    .insert(schema.modifierGroups)
    .values({
      tenantId,
      brandId,
      name: 'Tamaño',
      minSelections: 1, // obligatorio
      maxSelections: 1,
      sortOrder: 1,
    })
    .returning({ id: schema.modifierGroups.id });

  const [extras] = await ctx.db
    .insert(schema.modifierGroups)
    .values({
      tenantId,
      brandId,
      name: 'Extras',
      minSelections: 0, // opcional
      maxSelections: 3,
      sortOrder: 2,
    })
    .returning({ id: schema.modifierGroups.id });

  const tamanoOptions = await ctx.db
    .insert(schema.modifierOptions)
    .values([
      {
        tenantId,
        groupId: tamano!.id,
        name: 'Normal',
        priceDelta: '0',
        sortOrder: 1,
      },
      {
        tenantId,
        groupId: tamano!.id,
        name: 'Grande',
        priceDelta: '5.0000',
        sortOrder: 2,
      },
    ])
    .returning({
      id: schema.modifierOptions.id,
      name: schema.modifierOptions.name,
    });

  const extrasOptions = await ctx.db
    .insert(schema.modifierOptions)
    .values([
      {
        tenantId,
        groupId: extras!.id,
        name: 'Queso extra',
        priceDelta: '3.0000',
        sortOrder: 1,
      },
      {
        tenantId,
        groupId: extras!.id,
        name: 'Sin papas',
        // Negativo: quitar un ingrediente descuenta.
        priceDelta: '-2.0000',
        sortOrder: 2,
      },
      {
        tenantId,
        groupId: extras!.id,
        name: 'Trufa (agotada)',
        priceDelta: '9.0000',
        available: false,
        sortOrder: 3,
      },
    ])
    .returning({
      id: schema.modifierOptions.id,
      name: schema.modifierOptions.name,
    });

  // --- Productos ---
  const [pollo] = await ctx.db
    .insert(schema.products)
    .values({
      tenantId,
      brandId,
      categoryId,
      sku: 'POLLO-1',
      name: 'Pollo a la brasa entero',
      description: 'Con papas y ensalada',
      prepMinutes: 25,
    })
    .returning({ id: schema.products.id });

  const [soloPos] = await ctx.db
    .insert(schema.products)
    .values({
      tenantId,
      brandId,
      categoryId,
      sku: 'MOSTRADOR-1',
      name: 'Promo mostrador',
      prepMinutes: 5,
    })
    .returning({ id: schema.products.id });

  const [bebida] = await ctx.db
    .insert(schema.products)
    .values({
      tenantId,
      brandId,
      categoryId,
      sku: 'BEBIDA-1',
      name: 'Chicha morada 1L',
      prepMinutes: 1,
    })
    .returning({ id: schema.products.id });

  const [combo] = await ctx.db
    .insert(schema.products)
    .values({
      tenantId,
      brandId,
      categoryId,
      sku: 'COMBO-1',
      name: 'Combo familiar',
      isCombo: true,
      prepMinutes: 25,
    })
    .returning({ id: schema.products.id });

  // El combo se compone de pollo + bebida: el consumo de stock va por
  // componentes aunque el precio sea propio (RN-CAT-04).
  await ctx.db.insert(schema.comboComponents).values([
    { tenantId, comboId: combo!.id, componentId: pollo!.id, quantity: 1 },
    { tenantId, comboId: combo!.id, componentId: bebida!.id, quantity: 1 },
  ]);

  await ctx.db.insert(schema.productModifierGroups).values([
    { tenantId, productId: pollo!.id, groupId: tamano!.id, sortOrder: 1 },
    { tenantId, productId: pollo!.id, groupId: extras!.id, sortOrder: 2 },
  ]);

  // --- Precios por ámbito (RN-CAT-01) ---
  await ctx.db.insert(schema.prices).values([
    // Pollo: base 30, web 32, y 35 en el local concreto dentro de web.
    {
      tenantId,
      productId: pollo!.id,
      brandId,
      channel: null,
      price: '30.0000',
    },
    {
      tenantId,
      productId: pollo!.id,
      brandId,
      channel: 'web',
      price: '32.0000',
    },
    {
      tenantId,
      productId: pollo!.id,
      brandId,
      channel: 'web',
      locationId,
      price: '35.0000',
    },
    // Solo POS: sin precio base ni web → invisible en web.
    {
      tenantId,
      productId: soloPos!.id,
      brandId,
      channel: 'pos',
      price: '15.0000',
    },
    // Bebida y combo: solo precio base.
    {
      tenantId,
      productId: bebida!.id,
      brandId,
      channel: null,
      price: '10.0000',
    },
    {
      tenantId,
      productId: combo!.id,
      brandId,
      channel: null,
      price: '38.0000',
    },
  ]);

  const optionGrande = tamanoOptions.find((o) => o.name === 'Grande')!;
  const optionQueso = extrasOptions.find((o) => o.name === 'Queso extra')!;

  // Comprobación de coherencia de la semilla: si el precio base del combo
  // fuera mayor que la suma de sus componentes, la demo no tendría sentido
  // comercial y las pruebas de rentabilidad partirían de datos absurdos.
  const sueltos = Money.parse('30.0000').add(Money.parse('10.0000'));
  if (Money.parse('38.0000').greaterThanOrEqual(sueltos)) {
    throw new Error(
      'Semilla incoherente: el combo no puede costar igual o más que sus componentes por separado.',
    );
  }

  return {
    categoryId,
    polloId: pollo!.id,
    soloPosId: soloPos!.id,
    comboId: combo!.id,
    groupTamanoId: tamano!.id,
    groupExtrasId: extras!.id,
    optionGrandeId: optionGrande.id,
    optionQuesoId: optionQueso.id,
  };
}
