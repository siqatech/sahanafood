import { QuantityError } from './quantity.js';
import type { Quantity, Unit } from './quantity.js';

/**
 * Estallido de recetas y cálculo de consumo (spec 08, RN-INV-01/05, RN-CAT-04).
 *
 * Vive en `@sahana/domain` y no en el servidor porque el POS necesita el mismo
 * cálculo: es lo que le permite avisar «te quedan 3 hamburguesas de carne»
 * estando sin red. Si el servidor y el POS estallaran la receta de dos formas
 * distintas, el aviso mentiría exactamente cuando más se necesita.
 *
 * Dos cosas que la spec pide y que aquí son estructurales:
 *
 * · **Un combo consume por sus componentes, no por sí mismo** (RN-CAT-04). Un
 *   combo tiene precio propio pero no tiene receta propia: descontar «1 combo»
 *   del inventario dejaría la carne, el pan y la gaseosa sin descontar, y el
 *   food cost del combo sería cero.
 * · **Máximo 3 niveles de subreceta y ningún ciclo** (RN-INV-05). Una salsa que
 *   se usa en un alioli que se usa en la salsa es un bucle infinito en un
 *   proceso que corre dentro de la transacción del pedido: no es un error de
 *   validación cosmético, es la diferencia entre rechazar una receta y colgar
 *   la aceptación de pedidos.
 */

export class RecipeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RecipeError';
  }
}

/** Profundidad máxima de anidamiento (RN-INV-05). */
export const MAX_RECIPE_DEPTH = 3;

/** Una línea de receta apunta a un insumo o a otra receta. */
export type RecipeComponentKind = 'item' | 'recipe';

export interface RecipeLine {
  kind: RecipeComponentKind;
  /** Id del insumo (`item`) o de la subreceta (`recipe`). */
  componentId: string;
  /**
   * Cantidad por UNA unidad de rendimiento de la receta. Para `kind: 'recipe'`
   * la unidad debe ser la de rendimiento de esa subreceta.
   */
  quantity: Quantity;
  /**
   * Merma en puntos básicos (RN-INV-01). 500 = 5 %. Es la parte que se pierde
   * al preparar —el recorte de la cebolla, lo que queda en la olla— y forma
   * parte del consumo real: no contarla infla el margen teórico de cada plato.
   */
  wasteBps?: number;
}

export interface Recipe {
  id: string;
  /**
   * Cuánto produce la receta. Una salsa cuya receta rinde 2000 ml y se usa a
   * razón de 30 ml por plato consume 30/2000 de la receta, no una entera.
   */
  yieldQuantity: Quantity;
  lines: RecipeLine[];
}

/** Insumo consumido, ya estallado. */
export interface ConsumptionEntry {
  itemId: string;
  quantity: Quantity;
}

export interface RecipeBook {
  /** Recetas por id, incluidas las subrecetas. */
  recipes: ReadonlyMap<string, Recipe>;
  /** Qué receta produce cada producto vendible. Un combo puede no tener. */
  productRecipe: ReadonlyMap<string, string>;
  /**
   * Composición de los combos (RN-CAT-04): producto → componentes con su
   * cantidad. Se estalla cada componente por su propia receta.
   */
  comboComponents?: ReadonlyMap<
    string,
    ReadonlyArray<{ productId: string; quantity: number }>
  >;
}

/** Acumulador que suma por insumo respetando la unidad. */
class Acumulador {
  private readonly porInsumo = new Map<string, Quantity>();

  add(itemId: string, cantidad: Quantity): void {
    const previo = this.porInsumo.get(itemId);
    if (!previo) {
      this.porInsumo.set(itemId, cantidad);
      return;
    }
    if (previo.unit !== cantidad.unit) {
      // El mismo insumo con dos unidades distintas en dos recetas: dato malo
      // en el catálogo, no un caso a resolver sumando a ojo.
      throw new RecipeError(
        `El insumo ${itemId} aparece con unidades distintas (${previo.unit} y ${cantidad.unit}). Corrige la receta.`,
        'RECIPE_UNIT_MISMATCH',
      );
    }
    this.porInsumo.set(itemId, previo.add(cantidad));
  }

  /**
   * Resultado ordenado por id. El orden importa de verdad: los movimientos se
   * escriben en este orden y bloquean filas de stock. Con dos pedidos
   * simultáneos que comparten insumos, un orden distinto en cada uno es un
   * interbloqueo — y la spec pide 50 pedidos a la vez sobre el mismo insumo.
   */
  entries(): ConsumptionEntry[] {
    return [...this.porInsumo.entries()]
      .map(([itemId, quantity]) => ({ itemId, quantity }))
      .filter((e) => !e.quantity.isZero())
      .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  }
}

/**
 * Estalla una receta en insumos, multiplicada por `factorBps`.
 *
 * `factorBps` es cuántas veces se prepara la receta, en puntos básicos: 10 000
 * es una receta entera, 1 500 es el 15 %. En bps y no en decimal porque una
 * subreceta usada a 30 ml de un rendimiento de 2 000 da 0.015, y arrastrar ese
 * decimal por tres niveles es justo el error que `Quantity` evita.
 */
function estallar(
  recipeId: string,
  factorBps: number,
  book: RecipeBook,
  acumulador: Acumulador,
  profundidad: number,
  cadena: readonly string[],
): void {
  if (cadena.includes(recipeId)) {
    // Se nombra el ciclo entero: «hay un ciclo» no sirve para arreglarlo.
    throw new RecipeError(
      `Ciclo de subrecetas: ${[...cadena, recipeId].join(' → ')}.`,
      'RECIPE_CYCLE',
    );
  }
  if (profundidad > MAX_RECIPE_DEPTH) {
    throw new RecipeError(
      `La receta ${recipeId} anida más de ${MAX_RECIPE_DEPTH} niveles (RN-INV-05): ${[...cadena, recipeId].join(' → ')}.`,
      'RECIPE_TOO_DEEP',
    );
  }

  const receta = book.recipes.get(recipeId);
  if (!receta) {
    throw new RecipeError(
      `No existe la receta ${recipeId}.`,
      'RECIPE_NOT_FOUND',
    );
  }

  const siguienteCadena = [...cadena, recipeId];

  for (const linea of receta.lines) {
    if (linea.wasteBps !== undefined && linea.wasteBps < 0) {
      throw new RecipeError(
        `Merma negativa en la receta ${recipeId}, componente ${linea.componentId}.`,
        'RECIPE_INVALID_WASTE',
      );
    }

    // Merma primero, escalado después: da igual el orden matemáticamente, pero
    // fijar uno hace el redondeo reproducible, y el kardex tiene que cuadrar
    // exactamente contra el stock materializado.
    const conMerma = linea.quantity.applyBps(10_000 + (linea.wasteBps ?? 0));
    const escalada = conMerma.applyBps(factorBps);

    if (linea.kind === 'item') {
      acumulador.add(linea.componentId, escalada);
      continue;
    }

    const sub = book.recipes.get(linea.componentId);
    if (!sub) {
      throw new RecipeError(
        `No existe la subreceta ${linea.componentId}, usada por ${recipeId}.`,
        'RECIPE_NOT_FOUND',
      );
    }
    if (sub.yieldQuantity.isZero() || sub.yieldQuantity.isNegative()) {
      throw new RecipeError(
        `La subreceta ${linea.componentId} tiene rendimiento ${sub.yieldQuantity.toString()}; debe ser positivo.`,
        'RECIPE_INVALID_YIELD',
      );
    }
    if (sub.yieldQuantity.unit !== escalada.unit) {
      throw new RecipeError(
        `La receta ${recipeId} pide ${escalada.unit} de la subreceta ${linea.componentId}, que rinde ${sub.yieldQuantity.unit}.`,
        'RECIPE_UNIT_MISMATCH',
      );
    }

    // Qué fracción de la subreceta se usa, en bps.
    const fraccionBps = Math.round(
      (escalada.minorUnits * 10_000) / sub.yieldQuantity.minorUnits,
    );
    estallar(
      linea.componentId,
      fraccionBps,
      book,
      acumulador,
      profundidad + 1,
      siguienteCadena,
    );
  }
}

/**
 * Valida una receta y todas sus subrecetas sin calcular consumo.
 *
 * Se usa al guardar: un ciclo tiene que rebotar cuando alguien edita la receta,
 * con el editor delante, y no dentro de la transacción que acepta un pedido.
 */
export function assertValidRecipe(recipeId: string, book: RecipeBook): void {
  estallar(recipeId, 10_000, book, new Acumulador(), 1, []);
}

/** Estalla una receta entera en sus insumos. */
export function explodeRecipe(
  recipeId: string,
  book: RecipeBook,
  times = 1,
): ConsumptionEntry[] {
  if (!Number.isInteger(times) || times <= 0) {
    throw new RecipeError(
      `El número de veces debe ser un entero positivo. Recibido: ${times}.`,
      'RECIPE_INVALID_TIMES',
    );
  }
  const acumulador = new Acumulador();
  estallar(recipeId, 10_000 * times, book, acumulador, 1, []);
  return acumulador.entries();
}

export interface OrderLineForConsumption {
  productId: string;
  quantity: number;
}

export interface ConsumptionResult {
  entries: ConsumptionEntry[];
  /**
   * Productos vendidos sin receta ni composición.
   *
   * NO es un error: una gaseosa de reventa o un producto recién creado no
   * tienen por qué tenerla, y **jamás se bloquea una venta por inventario**
   * (RN-INV-02). Se devuelven para que el servidor lo deje anotado y el food
   * cost sepa que ese plato no está costeado, en vez de dar por hecho que
   * cuesta cero.
   */
  productsWithoutRecipe: string[];
}

/**
 * Consumo de un pedido completo.
 *
 * Un combo se estalla por sus componentes (RN-CAT-04) y cada componente por su
 * propia receta. Si un producto es a la vez combo y tiene receta propia, manda
 * la receta: es lo que alguien escribió a propósito.
 */
export function calculateConsumption(
  lines: readonly OrderLineForConsumption[],
  book: RecipeBook,
): ConsumptionResult {
  const acumulador = new Acumulador();
  const sinReceta = new Set<string>();

  const procesar = (productId: string, unidades: number): void => {
    if (!Number.isInteger(unidades) || unidades <= 0) {
      throw new RecipeError(
        `Cantidad inválida para ${productId}: ${unidades}.`,
        'RECIPE_INVALID_TIMES',
      );
    }

    const recetaId = book.productRecipe.get(productId);
    if (recetaId) {
      estallar(recetaId, 10_000 * unidades, book, acumulador, 1, []);
      return;
    }

    const componentes = book.comboComponents?.get(productId);
    if (componentes && componentes.length > 0) {
      for (const c of componentes) procesar(c.productId, c.quantity * unidades);
      return;
    }

    sinReceta.add(productId);
  };

  for (const linea of lines) procesar(linea.productId, linea.quantity);

  return {
    entries: acumulador.entries(),
    productsWithoutRecipe: [...sinReceta].sort(),
  };
}

/**
 * Invierte un consumo (RN-INV-03): cancelación antes de preparar.
 *
 * Es una función y no «restar a mano» porque la reversa tiene que ser
 * EXACTA — la spec lo pide explícitamente. Recalcular la receta al cancelar
 * daría otro resultado si alguien la editó entre medias, y el kardex quedaría
 * con un residuo que nadie sabe explicar. Se invierte lo que se escribió.
 */
export function reverseConsumption(
  consumido: readonly ConsumptionEntry[],
): ConsumptionEntry[] {
  return consumido.map((e) => ({
    itemId: e.itemId,
    quantity: e.quantity.negate(),
  }));
}

/** Ayuda para construir un libro de recetas en pruebas y semillas. */
export function recipeBook(
  recipes: readonly Recipe[],
  productRecipe: Readonly<Record<string, string>> = {},
  comboComponents: Readonly<
    Record<string, ReadonlyArray<{ productId: string; quantity: number }>>
  > = {},
): RecipeBook {
  return {
    recipes: new Map(recipes.map((r) => [r.id, r])),
    productRecipe: new Map(Object.entries(productRecipe)),
    comboComponents: new Map(Object.entries(comboComponents)),
  };
}

export { QuantityError, type Unit };
