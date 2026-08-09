import { describe, it, expect } from 'vitest';
import { Money } from '@sahana/domain';
import {
  aPedidoOffline,
  faltaPorElegir,
  nuevaLinea,
  totalDeLinea,
  totalDeTicket,
  vuelto,
  type LineaDeTicket,
} from './venta';
import type { GrupoDeModificadores, ProductoDeCarta } from './api';

/**
 * El cálculo del ticket en el dispositivo.
 *
 * Es lo que ADR-0006 §3.2 protege: el POS calcula el total **con el mismo
 * `Money`** que el servidor usará al recalcular. Si estos números divergieran,
 * el comprobante electrónico saldría mal, y en Perú eso es un problema
 * tributario, no un bug.
 */

const POLLO: ProductoDeCarta = {
  id: 'p-pollo',
  name: 'Pollo a la brasa entero',
  categoryId: 'c-pollos',
  price: { minorUnits: 550_000, currency: 'PEN', scale: 4 },
  modifierGroups: [],
};

const GUARNICION: GrupoDeModificadores = {
  id: 'g-1',
  name: 'Guarnición',
  minSelections: 1,
  maxSelections: 1,
  allowRepeat: false,
  options: [
    { id: 'o-papas', name: 'Papas', priceDeltaMinor: 0, available: true },
    {
      id: 'o-ensalada',
      name: 'Ensalada',
      priceDeltaMinor: 30_000,
      available: true,
    },
    {
      id: 'o-sin',
      name: 'Sin guarnición',
      priceDeltaMinor: -20_000,
      available: true,
    },
  ],
};

describe('Cálculo del ticket', () => {
  it('suma precio + modificadores × cantidad, todo con Money', () => {
    const linea: LineaDeTicket = {
      ...nuevaLinea(POLLO, [
        { id: 'o-ensalada', name: 'Ensalada', priceDeltaMinor: 30_000 },
      ]),
      quantity: 3,
    };
    // (55.00 + 3.00) × 3 = 174.00
    expect(totalDeLinea(linea).minorUnits).toBe(1_740_000);
    expect(totalDeTicket([linea]).toDecimalString()).toBe('174.0000');
  });

  it('un modificador NEGATIVO descuenta de verdad', () => {
    // «Sin guarnición» resta. Si el delta se tratara como magnitud, el cliente
    // pagaría de más por pedir menos comida.
    const linea = nuevaLinea(POLLO, [
      { id: 'o-sin', name: 'Sin guarnición', priceDeltaMinor: -20_000 },
    ]);
    expect(totalDeLinea(linea).toDecimalString()).toBe('53.0000');
  });

  it('un ticket vacío vale cero, no NaN', () => {
    expect(totalDeTicket([]).minorUnits).toBe(0);
  });

  it('el motivo de un grupo incompleto se DICE, no se calla', () => {
    // La spec pide botón deshabilitado CON explicación: un botón gris sin
    // motivo hace que el cajero llame al encargado en mitad de la cola.
    expect(faltaPorElegir([GUARNICION], new Set())).toContain('Guarnición');
    expect(faltaPorElegir([GUARNICION], new Set(['o-papas']))).toBeNull();
    expect(
      faltaPorElegir([GUARNICION], new Set(['o-papas', 'o-ensalada'])),
    ).toContain('solo se pueden elegir 1');
  });

  it('el vuelto se calcula con Money y avisa si no alcanza', () => {
    const total = Money.fromMinor(550_000);
    expect(vuelto(total, Money.fromMinor(1_000_000))?.toDecimalString()).toBe(
      '45.0000',
    );
    // Un céntimo de menos NO es «pagado»: eso se discute en el mostrador.
    expect(vuelto(total, Money.fromMinor(549_999))).toBeNull();
  });

  it('el pedido offline lleva ULID propio y el total COBRADO', () => {
    const lineas = [
      nuevaLinea(POLLO, [
        { id: 'o-ensalada', name: 'Ensalada', priceDeltaMinor: 30_000 },
      ]),
    ];
    const pedido = aPedidoOffline(lineas, {
      brandId: 'b-1',
      locationId: 'l-1',
      paymentMethod: 'cash',
      ahora: new Date('2026-08-09T18:30:00Z'),
    });

    // ULID: 26 caracteres, ordenable por tiempo. Es la clave del dedupe.
    expect(pedido.clientId).toHaveLength(26);
    expect(pedido.channel).toBe('pos');
    expect(pedido.totalMinor).toBe(580_000);
    expect(pedido.lines[0]!.lineTotalMinor).toBe(580_000);
    expect(pedido.lines[0]!.modifiersTotalMinor).toBe(30_000);
    // El total del pedido es la suma de sus líneas. Si no cuadrara, el servidor
    // levantaría una alerta al sincronizar y alguien tendría que revisarlo a
    // mano — con la venta ya cobrada.
    expect(pedido.lines.reduce((n, l) => n + l.lineTotalMinor, 0)).toBe(
      pedido.totalMinor,
    );
  });

  it('dos pedidos seguidos NO comparten clientId', () => {
    // Compartirlo haría que el segundo se descartara como duplicado al
    // sincronizar: una venta cobrada que nunca llega al servidor.
    const uno = aPedidoOffline([nuevaLinea(POLLO, [])], {
      brandId: 'b-1',
      locationId: 'l-1',
      paymentMethod: 'cash',
      ahora: new Date(),
    });
    const dos = aPedidoOffline([nuevaLinea(POLLO, [])], {
      brandId: 'b-1',
      locationId: 'l-1',
      paymentMethod: 'cash',
      ahora: new Date(),
    });
    expect(uno.clientId).not.toBe(dos.clientId);
  });
});
