import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../money/money.js';
import {
  calculateOrderTotals,
  compareTotals,
  PricingError,
  type OrderLineInput,
} from './totals.js';
import { ModifierError, type ModifierGroup } from './modifiers.js';

/** S/ 12.00 en unidades menores a escala 4. */
const soles = (value: string): number => Money.parse(value).minorUnits;

const linea = (over: Partial<OrderLineInput> = {}): OrderLineInput => ({
  lineId: 'l1',
  productId: 'p1',
  productName: 'Pollo a la brasa',
  unitPriceMinor: soles('30.00'),
  quantity: 1,
  ...over,
});

describe('calculateOrderTotals — casos base', () => {
  it('una línea simple', () => {
    const t = calculateOrderTotals({ lines: [linea()] });
    expect(t.subtotal.toDecimalString()).toBe('30.0000');
    expect(t.total.toDecimalString()).toBe('30.0000');
    expect(t.currency).toBe('PEN');
  });

  it('multiplica por cantidad', () => {
    const t = calculateOrderTotals({ lines: [linea({ quantity: 3 })] });
    expect(t.total.toDecimalString()).toBe('90.0000');
    expect(t.lines[0]!.grossTotal.toDecimalString()).toBe('90.0000');
  });

  it('suma varias líneas', () => {
    const t = calculateOrderTotals({
      lines: [
        linea({ lineId: 'a', unitPriceMinor: soles('30.00'), quantity: 2 }),
        linea({ lineId: 'b', unitPriceMinor: soles('12.50'), quantity: 1 }),
      ],
    });
    expect(t.total.toDecimalString()).toBe('72.5000');
  });

  it('rechaza un pedido vacío', () => {
    expect(() => calculateOrderTotals({ lines: [] })).toThrow(PricingError);
  });

  it('rechaza cantidades inválidas', () => {
    expect(() =>
      calculateOrderTotals({ lines: [linea({ quantity: 0 })] }),
    ).toThrow(/Cantidad inválida/);
    expect(() =>
      calculateOrderTotals({ lines: [linea({ quantity: -1 })] }),
    ).toThrow(PricingError);
    expect(() =>
      calculateOrderTotals({ lines: [linea({ quantity: 1.5 })] }),
    ).toThrow(PricingError);
  });

  it('rechaza precios negativos', () => {
    expect(() =>
      calculateOrderTotals({ lines: [linea({ unitPriceMinor: -100 })] }),
    ).toThrow(/no puede ser negativo/);
  });
});

describe('IGV incluido en el precio (RN-T05)', () => {
  it('desglosa el IGV hacia atrás desde el total', () => {
    // S/ 118.00 con IGV incluido = 100.00 de base + 18.00 de impuesto.
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('118.00') })],
    });
    expect(t.total.toDecimalString()).toBe('118.0000');
    expect(t.taxableBase.toDecimalString()).toBe('100.0000');
    expect(t.tax.toDecimalString()).toBe('18.0000');
    expect(t.taxRateBps).toBe(1800);
  });

  it('base + impuesto reconstituyen siempre el importe gravado', () => {
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('35.90'), quantity: 3 })],
    });
    expect(t.taxableBase.add(t.tax).toDecimalString()).toBe(
      t.total.toDecimalString(),
    );
  });

  it('acepta una tasa distinta (otro país, F9)', () => {
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('110.00') })],
      taxRateBps: 1000,
    });
    expect(t.taxableBase.toDecimalString()).toBe('100.0000');
    expect(t.tax.toDecimalString()).toBe('10.0000');
  });

  it('LA PROPINA NO TRIBUTA: queda fuera de la base imponible', () => {
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('118.00') })],
      tipMinor: soles('10.00'),
    });
    expect(t.total.toDecimalString()).toBe('128.0000');
    // El impuesto se calcula solo sobre los 118, no sobre los 128.
    expect(t.taxableBase.add(t.tax).toDecimalString()).toBe('118.0000');
    expect(t.tax.toDecimalString()).toBe('18.0000');
  });
});

describe('Modificadores (RN-CAT-05)', () => {
  const tamano: ModifierGroup = {
    id: 'g-tamano',
    name: 'Tamaño',
    minSelections: 1,
    maxSelections: 1,
    options: [
      { id: 'normal', name: 'Normal', priceDeltaMinor: 0 },
      { id: 'grande', name: 'Grande', priceDeltaMinor: soles('5.00') },
    ],
  };

  const extras: ModifierGroup = {
    id: 'g-extras',
    name: 'Extras',
    minSelections: 0,
    maxSelections: 3,
    options: [
      { id: 'queso', name: 'Queso extra', priceDeltaMinor: soles('3.00') },
      { id: 'papas', name: 'Papas extra', priceDeltaMinor: soles('4.00') },
      { id: 'sin-aji', name: 'Sin ají', priceDeltaMinor: 0 },
      {
        id: 'agotado',
        name: 'Trufa',
        priceDeltaMinor: soles('9.00'),
        available: false,
      },
    ],
  };

  it('suma el precio de los modificadores por unidad', () => {
    const t = calculateOrderTotals({
      lines: [
        linea({
          modifierGroups: [tamano, extras],
          modifierSelections: [
            { groupId: 'g-tamano', optionIds: ['grande'] },
            { groupId: 'g-extras', optionIds: ['queso', 'papas'] },
          ],
        }),
      ],
    });
    // 30 + 5 + 3 + 4 = 42
    expect(t.lines[0]!.modifiersPerUnit.toDecimalString()).toBe('12.0000');
    expect(t.total.toDecimalString()).toBe('42.0000');
  });

  it('el modificador se multiplica por la cantidad', () => {
    const t = calculateOrderTotals({
      lines: [
        linea({
          quantity: 2,
          modifierGroups: [tamano],
          modifierSelections: [{ groupId: 'g-tamano', optionIds: ['grande'] }],
        }),
      ],
    });
    // (30 + 5) × 2 = 70
    expect(t.total.toDecimalString()).toBe('70.0000');
  });

  it('exige los grupos obligatorios aunque no se envíen', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [linea({ modifierGroups: [tamano], modifierSelections: [] })],
      }),
    ).toThrow(/Debes elegir en "Tamaño"/);
  });

  it('rechaza superar el máximo', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [extras],
            modifierSelections: [
              {
                groupId: 'g-extras',
                optionIds: ['queso', 'papas', 'sin-aji', 'queso'],
              },
            ],
          }),
        ],
      }),
    ).toThrow(/Puedes elegir como máximo 3 opciones/);
  });

  it('rechaza quedarse por debajo del mínimo', () => {
    const dosMinimo: ModifierGroup = { ...extras, minSelections: 2 };
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [dosMinimo],
            modifierSelections: [{ groupId: 'g-extras', optionIds: ['queso'] }],
          }),
        ],
      }),
    ).toThrow(/Elige al menos 2 opciones/);
  });

  it('rechaza una opción agotada', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [extras],
            modifierSelections: [
              { groupId: 'g-extras', optionIds: ['agotado'] },
            ],
          }),
        ],
      }),
    ).toThrow(/no está disponible/);
  });

  it('rechaza grupo u opción desconocidos', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [extras],
            modifierSelections: [{ groupId: 'inventado', optionIds: [] }],
          }),
        ],
      }),
    ).toThrow(/no existe en este producto/);

    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [extras],
            modifierSelections: [
              { groupId: 'g-extras', optionIds: ['inventada'] },
            ],
          }),
        ],
      }),
    ).toThrow(/no pertenece al grupo/);
  });

  it('rechaza el mismo grupo dos veces', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [extras],
            modifierSelections: [
              { groupId: 'g-extras', optionIds: ['queso'] },
              { groupId: 'g-extras', optionIds: ['papas'] },
            ],
          }),
        ],
      }),
    ).toThrow(/aparece dos veces/);
  });

  it('rechaza repetir opción si el grupo no lo permite', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [extras],
            modifierSelections: [
              { groupId: 'g-extras', optionIds: ['queso', 'queso'] },
            ],
          }),
        ],
      }),
    ).toThrow(/no permite repetir/);
  });

  it('permite repetir si el grupo lo declara', () => {
    const repetible: ModifierGroup = { ...extras, allowRepeat: true };
    const t = calculateOrderTotals({
      lines: [
        linea({
          modifierGroups: [repetible],
          modifierSelections: [
            { groupId: 'g-extras', optionIds: ['queso', 'queso'] },
          ],
        }),
      ],
    });
    expect(t.total.toDecimalString()).toBe('36.0000'); // 30 + 3 + 3
  });

  it('admite modificadores con precio negativo (quitar ingrediente)', () => {
    const conDescuento: ModifierGroup = {
      id: 'g-quitar',
      name: 'Quitar',
      minSelections: 0,
      maxSelections: 1,
      options: [
        { id: 'sin-papas', name: 'Sin papas', priceDeltaMinor: -soles('2.00') },
      ],
    };
    const t = calculateOrderTotals({
      lines: [
        linea({
          modifierGroups: [conDescuento],
          modifierSelections: [
            { groupId: 'g-quitar', optionIds: ['sin-papas'] },
          ],
        }),
      ],
    });
    expect(t.total.toDecimalString()).toBe('28.0000');
  });

  it('rechaza que los modificadores dejen la línea en negativo', () => {
    const brutal: ModifierGroup = {
      id: 'g-brutal',
      name: 'Brutal',
      minSelections: 1,
      maxSelections: 1,
      options: [{ id: 'x', name: 'X', priceDeltaMinor: -soles('50.00') }],
    };
    expect(() =>
      calculateOrderTotals({
        lines: [
          linea({
            modifierGroups: [brutal],
            modifierSelections: [{ groupId: 'g-brutal', optionIds: ['x'] }],
          }),
        ],
      }),
    ).toThrow(/precio negativo/);
  });

  it('los errores llevan código estable para la API', () => {
    try {
      calculateOrderTotals({
        lines: [linea({ modifierGroups: [tamano], modifierSelections: [] })],
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ModifierError);
      expect((e as ModifierError).code).toBe('MODIFIER_MIN_NOT_MET');
      expect((e as ModifierError).groupId).toBe('g-tamano');
    }
  });
});

describe('Descuentos', () => {
  it('descuento de línea por monto', () => {
    const t = calculateOrderTotals({
      lines: [
        linea({ discount: { kind: 'amount', amountMinor: soles('5.00') } }),
      ],
    });
    expect(t.lines[0]!.discount.toDecimalString()).toBe('5.0000');
    expect(t.total.toDecimalString()).toBe('25.0000');
  });

  it('descuento de línea por porcentaje', () => {
    const t = calculateOrderTotals({
      lines: [linea({ discount: { kind: 'percentage', bps: 1000 } })], // 10 %
    });
    expect(t.total.toDecimalString()).toBe('27.0000');
  });

  it('descuento de pedido sobre el subtotal', () => {
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('50.00') })],
      orderDiscount: { kind: 'percentage', bps: 2000 }, // 20 %
    });
    expect(t.orderDiscount.toDecimalString()).toBe('10.0000');
    expect(t.total.toDecimalString()).toBe('40.0000');
  });

  it('el descuento de pedido se aplica sobre el subtotal YA descontado', () => {
    // 100 − 10 % de línea = 90; luego − 10 % de pedido = 81.
    // Si ambos se aplicaran sobre el bruto serían 80: se regalaría 1 sol.
    const t = calculateOrderTotals({
      lines: [
        linea({
          unitPriceMinor: soles('100.00'),
          discount: { kind: 'percentage', bps: 1000 },
        }),
      ],
      orderDiscount: { kind: 'percentage', bps: 1000 },
    });
    expect(t.subtotal.toDecimalString()).toBe('90.0000');
    expect(t.orderDiscount.toDecimalString()).toBe('9.0000');
    expect(t.total.toDecimalString()).toBe('81.0000');
  });

  it('un descuento nunca deja el total en negativo: se topa a la base', () => {
    const t = calculateOrderTotals({
      lines: [
        linea({ discount: { kind: 'amount', amountMinor: soles('999.00') } }),
      ],
    });
    expect(t.lines[0]!.total.isZero()).toBe(true);
    expect(t.total.isZero()).toBe(true);
  });

  it('rechaza descuentos inválidos', () => {
    expect(() =>
      calculateOrderTotals({
        lines: [linea({ discount: { kind: 'amount', amountMinor: -100 } })],
      }),
    ).toThrow(/no puede ser negativo/);

    expect(() =>
      calculateOrderTotals({
        lines: [linea({ discount: { kind: 'percentage', bps: 10_001 } })],
      }),
    ).toThrow(/no puede superar el 100/);

    expect(() =>
      calculateOrderTotals({
        lines: [linea({ discount: { kind: 'percentage', bps: -5 } })],
      }),
    ).toThrow(/entero no negativo/);

    expect(() =>
      calculateOrderTotals({
        lines: [linea({ discount: { kind: 'percentage', bps: 12.5 } })],
      }),
    ).toThrow(PricingError);
  });

  it('el 100 % de descuento es válido y deja total cero', () => {
    const t = calculateOrderTotals({
      lines: [linea({ discount: { kind: 'percentage', bps: 10_000 } })],
    });
    expect(t.total.isZero()).toBe(true);
  });
});

describe('Envío y propina', () => {
  it('suma envío y propina al total', () => {
    const t = calculateOrderTotals({
      lines: [linea()],
      deliveryFeeMinor: soles('8.50'),
      tipMinor: soles('3.00'),
    });
    expect(t.total.toDecimalString()).toBe('41.5000');
    expect(t.deliveryFee.toDecimalString()).toBe('8.5000');
    expect(t.tip.toDecimalString()).toBe('3.0000');
  });

  it('el envío SÍ tributa; la propina no', () => {
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('100.00') })],
      deliveryFeeMinor: soles('18.00'),
      tipMinor: soles('50.00'),
    });
    // Base gravada = 100 + 18 = 118 → 100 + 18 de IGV.
    expect(t.taxableBase.add(t.tax).toDecimalString()).toBe('118.0000');
    expect(t.total.toDecimalString()).toBe('168.0000');
  });

  it('rechaza envío o propina negativos', () => {
    expect(() =>
      calculateOrderTotals({ lines: [linea()], deliveryFeeMinor: -1 }),
    ).toThrow(/envío no puede ser negativo/);
    expect(() =>
      calculateOrderTotals({ lines: [linea()], tipMinor: -1 }),
    ).toThrow(/propina no puede ser negativa/);
  });
});

describe('Redondeo (RN-T04): solo al total', () => {
  it('los subtotales conservan 4 decimales y el total se redondea a céntimos', () => {
    // 1/3 de descuento genera decimales largos.
    const t = calculateOrderTotals({
      lines: [
        linea({
          unitPriceMinor: soles('10.00'),
          discount: { kind: 'percentage', bps: 3333 },
        }),
      ],
    });
    // 10 × 0.3333 = 3.3330 exacto a escala 4.
    expect(t.lines[0]!.discount.toDecimalString()).toBe('3.3330');
    expect(t.subtotal.toDecimalString()).toBe('6.6670');
    // El total redondea half-up a céntimos.
    expect(t.total.toDecimalString()).toBe('6.6700');
  });

  it('el total siempre tiene como mucho 2 decimales significativos', () => {
    const t = calculateOrderTotals({
      lines: [linea({ unitPriceMinor: soles('33.3333'), quantity: 3 })],
    });
    expect(t.total.toCents()).toBe(t.total.roundToCents().toCents());
    expect(t.total.minorUnits % 100).toBe(0);
  });
});

describe('compareTotals — defensa de la sincronización offline', () => {
  it('detecta coincidencia exacta', () => {
    const r = compareTotals(Money.parse('42.00'), Money.parse('42.00'));
    expect(r.matches).toBe(true);
    expect(r.difference.isZero()).toBe(true);
  });

  it('informa la diferencia exacta cuando no cuadra', () => {
    const r = compareTotals(Money.parse('42.00'), Money.parse('42.50'));
    expect(r.matches).toBe(false);
    expect(r.difference.toDecimalString()).toBe('0.5000');
  });
});

describe('Propiedades (fast-check)', () => {
  const precio = () => fc.integer({ min: 0, max: 1_000_000 });
  const cantidad = () => fc.integer({ min: 1, max: 20 });

  it('el subtotal SIEMPRE es la suma de los totales de línea', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(precio(), cantidad()), {
          minLength: 1,
          maxLength: 10,
        }),
        (entradas) => {
          const t = calculateOrderTotals({
            lines: entradas.map(([p, q], i) => ({
              lineId: `l${i}`,
              productId: `p${i}`,
              productName: `Producto ${i}`,
              unitPriceMinor: p,
              quantity: q,
            })),
          });
          const suma = sumMoney(t.lines.map((l) => l.total));
          expect(t.subtotal.equals(suma)).toBe(true);
        },
      ),
    );
  });

  it('el total nunca es negativo', () => {
    fc.assert(
      fc.property(
        precio(),
        cantidad(),
        fc.integer({ min: 0, max: 10_000 }),
        (p, q, bps) => {
          const t = calculateOrderTotals({
            lines: [
              {
                lineId: 'l',
                productId: 'p',
                productName: 'X',
                unitPriceMinor: p,
                quantity: q,
                discount: { kind: 'percentage', bps },
              },
            ],
          });
          expect(t.total.isNegative()).toBe(false);
        },
      ),
    );
  });

  it('base imponible + impuesto = importe gravado, siempre', () => {
    fc.assert(
      fc.property(precio(), cantidad(), precio(), (p, q, envio) => {
        const t = calculateOrderTotals({
          lines: [
            {
              lineId: 'l',
              productId: 'p',
              productName: 'X',
              unitPriceMinor: p,
              quantity: q,
            },
          ],
          deliveryFeeMinor: envio,
        });
        const gravado = t.taxableBase.add(t.tax);
        expect(gravado.equals(t.total)).toBe(true);
        expect(t.tax.isNegative()).toBe(false);
      }),
    );
  });

  it('sin descuentos, el total es el subtotal redondeado', () => {
    fc.assert(
      fc.property(precio(), cantidad(), (p, q) => {
        const t = calculateOrderTotals({
          lines: [
            {
              lineId: 'l',
              productId: 'p',
              productName: 'X',
              unitPriceMinor: p,
              quantity: q,
            },
          ],
        });
        expect(t.total.equals(t.subtotal.roundToCents())).toBe(true);
      }),
    );
  });
});
