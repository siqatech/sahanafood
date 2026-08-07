import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Quantity } from './quantity.js';
import {
  explodeRecipe,
  calculateConsumption,
  reverseConsumption,
  assertValidRecipe,
  recipeBook,
  RecipeError,
  MAX_RECIPE_DEPTH,
  type Recipe,
} from './recipe.js';

/**
 * El estallido vive en el dominio porque el POS lo necesita igual que el
 * servidor: es lo que le permite avisar «te quedan 3 hamburguesas» sin red. Si
 * ambos lados estallaran la receta de dos formas, el aviso mentiría justo
 * cuando más se necesita.
 */

const g = (n: number) => Quantity.fromDecimal(n, 'g');
const ml = (n: number) => Quantity.fromDecimal(n, 'ml');
const un = (n: number) => Quantity.fromDecimal(n, 'unit');

/** Hamburguesa: 150 g de carne, 1 pan, 30 ml de salsa (subreceta). */
const SALSA: Recipe = {
  id: 'r-salsa',
  yieldQuantity: ml(2000),
  lines: [
    { kind: 'item', componentId: 'i-mayonesa', quantity: ml(1500) },
    { kind: 'item', componentId: 'i-ketchup', quantity: ml(500) },
  ],
};

const HAMBURGUESA: Recipe = {
  id: 'r-hamburguesa',
  yieldQuantity: un(1),
  lines: [
    { kind: 'item', componentId: 'i-carne', quantity: g(150) },
    { kind: 'item', componentId: 'i-pan', quantity: un(1) },
    { kind: 'recipe', componentId: 'r-salsa', quantity: ml(30) },
  ],
};

const LIBRO = recipeBook(
  [SALSA, HAMBURGUESA],
  { 'p-hamburguesa': 'r-hamburguesa', 'p-gaseosa-vaso': 'r-gaseosa-vaso' },
  {
    'p-combo': [
      { productId: 'p-hamburguesa', quantity: 1 },
      { productId: 'p-papas', quantity: 1 },
    ],
  },
);

/** Libro completo, con la receta de la gaseosa servida y las papas. */
const LIBRO_COMPLETO = recipeBook(
  [
    SALSA,
    HAMBURGUESA,
    {
      id: 'r-gaseosa-vaso',
      yieldQuantity: un(1),
      lines: [{ kind: 'item', componentId: 'i-gaseosa', quantity: ml(350) }],
    },
    {
      id: 'r-papas',
      yieldQuantity: un(1),
      // 20 % de merma: la papa pierde al pelar y al freír.
      lines: [
        {
          kind: 'item',
          componentId: 'i-papa',
          quantity: g(200),
          wasteBps: 2000,
        },
      ],
    },
  ],
  {
    'p-hamburguesa': 'r-hamburguesa',
    'p-papas': 'r-papas',
    'p-gaseosa-vaso': 'r-gaseosa-vaso',
  },
  {
    'p-combo': [
      { productId: 'p-hamburguesa', quantity: 1 },
      { productId: 'p-papas', quantity: 1 },
      { productId: 'p-gaseosa-vaso', quantity: 1 },
    ],
  },
);

const buscar = (
  entradas: ReturnType<typeof explodeRecipe>,
  itemId: string,
): string => entradas.find((e) => e.itemId === itemId)!.quantity.toDatabase();

describe('Estallido de recetas', () => {
  it('estalla una receta con subreceta a la fracción exacta', () => {
    // 30 ml de una salsa que rinde 2000 ml = 1.5 % de la receta.
    // Mayonesa: 1500 × 0.015 = 22.5 ml. Ketchup: 500 × 0.015 = 7.5 ml.
    const r = explodeRecipe('r-hamburguesa', LIBRO);
    expect(buscar(r, 'i-carne')).toBe('150.0000');
    expect(buscar(r, 'i-pan')).toBe('1.0000');
    expect(buscar(r, 'i-mayonesa')).toBe('22.5000');
    expect(buscar(r, 'i-ketchup')).toBe('7.5000');
  });

  it('aplica la merma: no contarla infla el margen teórico de cada plato', () => {
    // 200 g con 20 % de merma = 240 g realmente consumidos.
    const r = explodeRecipe('r-papas', LIBRO_COMPLETO);
    expect(buscar(r, 'i-papa')).toBe('240.0000');
  });

  it('escala por unidades pedidas', () => {
    const r = explodeRecipe('r-hamburguesa', LIBRO, 3);
    expect(buscar(r, 'i-carne')).toBe('450.0000');
    expect(buscar(r, 'i-mayonesa')).toBe('67.5000');
  });

  it('suma el mismo insumo cuando aparece por varios caminos', () => {
    // La carne está en la receta directa y dentro de una subreceta: tiene que
    // salir UNA línea sumada, no dos. Dos líneas del mismo insumo en el mismo
    // pedido son dos bloqueos de la misma fila y un interbloqueo esperando.
    const libro = recipeBook([
      {
        id: 'r-doble',
        yieldQuantity: un(1),
        lines: [
          { kind: 'item', componentId: 'i-carne', quantity: g(100) },
          { kind: 'recipe', componentId: 'r-relleno', quantity: g(50) },
        ],
      },
      {
        id: 'r-relleno',
        yieldQuantity: g(100),
        lines: [{ kind: 'item', componentId: 'i-carne', quantity: g(100) }],
      },
    ]);
    const r = explodeRecipe('r-doble', libro);
    expect(r.filter((e) => e.itemId === 'i-carne')).toHaveLength(1);
    expect(buscar(r, 'i-carne')).toBe('150.0000');
  });

  it('devuelve los insumos ORDENADOS por id', () => {
    // No es cosmética: los movimientos se escriben en este orden y bloquean
    // filas de stock. Con 50 pedidos simultáneos, un orden distinto en cada uno
    // es un interbloqueo — y la spec pide exactamente esa prueba.
    const r = explodeRecipe('r-hamburguesa', LIBRO);
    const ids = r.map((e) => e.itemId);
    expect(ids).toEqual([...ids].sort());
  });

  it('detecta ciclos y NOMBRA el camino completo', () => {
    // Una salsa dentro de un alioli dentro de la salsa es un bucle infinito
    // dentro de la transacción que acepta el pedido: no es un error cosmético,
    // es la diferencia entre rechazar una receta y colgar las ventas.
    const libro = recipeBook([
      {
        id: 'r-a',
        yieldQuantity: ml(100),
        lines: [{ kind: 'recipe', componentId: 'r-b', quantity: ml(10) }],
      },
      {
        id: 'r-b',
        yieldQuantity: ml(100),
        lines: [{ kind: 'recipe', componentId: 'r-a', quantity: ml(10) }],
      },
    ]);
    try {
      explodeRecipe('r-a', libro);
      throw new Error('debería haber lanzado');
    } catch (e) {
      expect(e).toBeInstanceOf(RecipeError);
      expect((e as RecipeError).code).toBe('RECIPE_CYCLE');
      expect((e as RecipeError).message).toContain('r-a → r-b → r-a');
    }
  });

  it('rechaza más de 3 niveles de anidamiento (RN-INV-05)', () => {
    const niveles = MAX_RECIPE_DEPTH + 1;
    const recetas: Recipe[] = [];
    for (let i = 0; i < niveles; i++) {
      recetas.push({
        id: `r-${i}`,
        yieldQuantity: g(100),
        lines:
          i === niveles - 1
            ? [{ kind: 'item', componentId: 'i-final', quantity: g(10) }]
            : [{ kind: 'recipe', componentId: `r-${i + 1}`, quantity: g(100) }],
      });
    }
    const libro = recipeBook(recetas);
    expect(() => explodeRecipe('r-0', libro)).toThrow(/más de 3 niveles/);
  });

  it('admite exactamente 3 niveles', () => {
    const libro = recipeBook([
      {
        id: 'r-1',
        yieldQuantity: g(100),
        lines: [{ kind: 'recipe', componentId: 'r-2', quantity: g(100) }],
      },
      {
        id: 'r-2',
        yieldQuantity: g(100),
        lines: [{ kind: 'recipe', componentId: 'r-3', quantity: g(100) }],
      },
      {
        id: 'r-3',
        yieldQuantity: g(100),
        lines: [{ kind: 'item', componentId: 'i-x', quantity: g(50) }],
      },
    ]);
    expect(buscar(explodeRecipe('r-1', libro), 'i-x')).toBe('50.0000');
  });

  it('rechaza una subreceta cuyo rendimiento no está en la unidad pedida', () => {
    const libro = recipeBook([
      {
        id: 'r-mal',
        yieldQuantity: un(1),
        // Pide gramos de una subreceta que rinde mililitros.
        lines: [{ kind: 'recipe', componentId: 'r-salsa', quantity: g(30) }],
      },
      SALSA,
    ]);
    expect(() => explodeRecipe('r-mal', libro)).toThrow(/rinde ml/);
  });

  it('rechaza rendimiento cero: dividir por él sería infinito consumo', () => {
    const libro = recipeBook([
      {
        id: 'r-usa',
        yieldQuantity: un(1),
        lines: [{ kind: 'recipe', componentId: 'r-vacia', quantity: ml(10) }],
      },
      { id: 'r-vacia', yieldQuantity: ml(0), lines: [] },
    ]);
    expect(() => explodeRecipe('r-usa', libro)).toThrow(/rendimiento/);
  });

  it('rechaza el mismo insumo con dos unidades distintas', () => {
    // Dato malo del catálogo, no un caso a resolver sumando a ojo.
    const libro = recipeBook([
      {
        id: 'r-x',
        yieldQuantity: un(1),
        lines: [
          { kind: 'item', componentId: 'i-a', quantity: g(10) },
          { kind: 'item', componentId: 'i-a', quantity: ml(10) },
        ],
      },
    ]);
    expect(() => explodeRecipe('r-x', libro)).toThrow(/unidades distintas/);
  });

  it('rechaza recetas y subrecetas inexistentes con un código estable', () => {
    expect(() => explodeRecipe('r-fantasma', LIBRO)).toThrow(RecipeError);
    try {
      explodeRecipe('r-fantasma', LIBRO);
    } catch (e) {
      expect((e as RecipeError).code).toBe('RECIPE_NOT_FOUND');
    }
  });

  it('assertValidRecipe rebota el ciclo al GUARDAR, no al vender', () => {
    // Con el editor delante, que es donde se puede arreglar.
    const libro = recipeBook([
      {
        id: 'r-a',
        yieldQuantity: g(1),
        lines: [{ kind: 'recipe', componentId: 'r-a', quantity: g(1) }],
      },
    ]);
    expect(() => assertValidRecipe('r-a', libro)).toThrow(/Ciclo/);
    expect(() => assertValidRecipe('r-hamburguesa', LIBRO)).not.toThrow();
  });
});

describe('Consumo de un pedido', () => {
  it('un COMBO consume por sus componentes, no por sí mismo (RN-CAT-04)', () => {
    // Descontar «1 combo» dejaría carne, pan y gaseosa sin descontar, y el food
    // cost del combo saldría cero.
    const r = calculateConsumption(
      [{ productId: 'p-combo', quantity: 1 }],
      LIBRO_COMPLETO,
    );
    const ids = r.entries.map((e) => e.itemId);
    expect(ids).toContain('i-carne');
    expect(ids).toContain('i-papa');
    expect(ids).toContain('i-gaseosa');
    expect(ids).not.toContain('p-combo');
    expect(r.productsWithoutRecipe).toEqual([]);
  });

  it('el combo escala: 2 combos son 2 de cada componente', () => {
    const uno = calculateConsumption(
      [{ productId: 'p-combo', quantity: 1 }],
      LIBRO_COMPLETO,
    );
    const dos = calculateConsumption(
      [{ productId: 'p-combo', quantity: 2 }],
      LIBRO_COMPLETO,
    );
    for (const e of uno.entries) {
      const doble = dos.entries.find((x) => x.itemId === e.itemId)!;
      expect(doble.quantity.equals(e.quantity.multiply(2))).toBe(true);
    }
  });

  it('un producto sin receta NO rompe la venta, se reporta', () => {
    // RN-INV-02: jamás se bloquea una venta por inventario. Una gaseosa de
    // reventa o un producto recién creado no tienen por qué tener receta.
    const r = calculateConsumption(
      [
        { productId: 'p-hamburguesa', quantity: 1 },
        { productId: 'p-agua-botella', quantity: 2 },
      ],
      LIBRO_COMPLETO,
    );
    expect(r.productsWithoutRecipe).toEqual(['p-agua-botella']);
    // Y lo que sí tiene receta se consume igual.
    expect(buscar(r.entries, 'i-carne')).toBe('150.0000');
  });

  it('si un producto es combo Y tiene receta propia, manda la receta', () => {
    // Es lo que alguien escribió a propósito.
    const libro = recipeBook(
      [
        {
          id: 'r-propia',
          yieldQuantity: un(1),
          lines: [{ kind: 'item', componentId: 'i-propio', quantity: g(1) }],
        },
        HAMBURGUESA,
        SALSA,
      ],
      { 'p-x': 'r-propia' },
      { 'p-x': [{ productId: 'p-hamburguesa', quantity: 1 }] },
    );
    const r = calculateConsumption([{ productId: 'p-x', quantity: 1 }], libro);
    expect(r.entries.map((e) => e.itemId)).toEqual(['i-propio']);
  });

  it('suma entre líneas del mismo pedido', () => {
    const r = calculateConsumption(
      [
        { productId: 'p-hamburguesa', quantity: 2 },
        { productId: 'p-combo', quantity: 1 },
      ],
      LIBRO_COMPLETO,
    );
    // 2 hamburguesas sueltas + 1 dentro del combo = 3 × 150 g.
    expect(buscar(r.entries, 'i-carne')).toBe('450.0000');
  });

  it('rechaza cantidades que no son enteros positivos', () => {
    for (const mala of [0, -1, 1.5]) {
      expect(() =>
        calculateConsumption(
          [{ productId: 'p-hamburguesa', quantity: mala }],
          LIBRO_COMPLETO,
        ),
      ).toThrow(RecipeError);
    }
  });

  it('un pedido vacío no consume nada', () => {
    const r = calculateConsumption([], LIBRO_COMPLETO);
    expect(r.entries).toEqual([]);
  });
});

describe('Reversa de consumo (RN-INV-03)', () => {
  it('la reversa es EXACTA y suma cero con el consumo', () => {
    // Recalcular la receta al cancelar daría otro resultado si alguien la editó
    // entre medias, y el kardex quedaría con un residuo inexplicable.
    const consumo = calculateConsumption(
      [{ productId: 'p-combo', quantity: 3 }],
      LIBRO_COMPLETO,
    ).entries;
    const reversa = reverseConsumption(consumo);

    expect(reversa).toHaveLength(consumo.length);
    for (const [i, e] of consumo.entries()) {
      expect(reversa[i]!.itemId).toBe(e.itemId);
      expect(e.quantity.add(reversa[i]!.quantity).isZero()).toBe(true);
    }
  });

  it('revertir dos veces devuelve el consumo original', () => {
    const consumo = explodeRecipe('r-hamburguesa', LIBRO, 7);
    const ida = reverseConsumption(reverseConsumption(consumo));
    for (const [i, e] of consumo.entries()) {
      expect(ida[i]!.quantity.equals(e.quantity)).toBe(true);
    }
  });
});

describe('Consumo — propiedades', () => {
  it('consumir n unidades es exactamente n veces consumir una', () => {
    // Es la propiedad de la que depende que el kardex cuadre: el servidor
    // consume por pedido y el analítico multiplica por unidades vendidas.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (n) => {
        const uno = explodeRecipe('r-hamburguesa', LIBRO);
        const enes = explodeRecipe('r-hamburguesa', LIBRO, n);
        for (const e of uno) {
          const escalado = enes.find((x) => x.itemId === e.itemId)!;
          expect(escalado.quantity.equals(e.quantity.multiply(n))).toBe(true);
        }
      }),
    );
  });

  it('el orden de las líneas del pedido no cambia el consumo', () => {
    // La ingesta desde un marketplace no garantiza orden, y el POS offline
    // reenvía lotes en el orden que le queda.
    const productos = ['p-hamburguesa', 'p-papas', 'p-gaseosa-vaso', 'p-combo'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            productId: fc.constantFrom(...productos),
            quantity: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (lineas) => {
          const directo = calculateConsumption(lineas, LIBRO_COMPLETO).entries;
          const alReves = calculateConsumption(
            [...lineas].reverse(),
            LIBRO_COMPLETO,
          ).entries;

          expect(alReves.map((e) => e.itemId)).toEqual(
            directo.map((e) => e.itemId),
          );
          for (const [i, e] of directo.entries()) {
            expect(alReves[i]!.quantity.equals(e.quantity)).toBe(true);
          }
        },
      ),
    );
  });

  it('nunca produce cantidades negativas ni líneas en cero', () => {
    // Un movimiento de cero es ruido en el kardex; uno negativo en un consumo
    // sería una devolución disfrazada.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            productId: fc.constantFrom('p-hamburguesa', 'p-combo', 'p-papas'),
            quantity: fc.integer({ min: 1, max: 20 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (lineas) => {
          for (const e of calculateConsumption(lineas, LIBRO_COMPLETO)
            .entries) {
            expect(e.quantity.isNegative()).toBe(false);
            expect(e.quantity.isZero()).toBe(false);
          }
        },
      ),
    );
  });
});
