import { ulid } from 'ulid';
import { Money, alergenosDe } from '@sahana/domain';
import type {
  GrupoDeModificadores,
  LineaOffline,
  PedidoOffline,
  ProductoDeCarta,
} from './api';

/**
 * El ticket en curso y su total.
 *
 * **Todo el dinero pasa por `Money`**, el mismo paquete que usa el servidor
 * para recalcular al sincronizar (ADR-0006 §3.2). Es la razón de que el POS
 * sea una PWA en TypeScript y no una app nativa: dos implementaciones del
 * cálculo divergen, y un total divergente en Perú no es un bug, es un
 * comprobante electrónico incorrecto.
 *
 * Aquí no se calcula IGV ni se aplican promociones: el precio del canal `pos`
 * ya viene resuelto **con IGV incluido** (RN-T05) y el desglose lo hace el
 * servidor al emitir. Lo que sí ocurre en el dispositivo es sumar líneas y
 * modificadores, que es lo que el cajero ve mientras cobra.
 */

export interface SeleccionDeModificador {
  id: string;
  name: string;
  priceDeltaMinor: number;
}

export interface LineaDeTicket {
  /** Identificador de la línea EN EL TICKET, no del producto. */
  key: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number;
  modifiers: SeleccionDeModificador[];
  /**
   * Alérgenos declarados EN EL MOMENTO de añadir el plato.
   *
   * Se copian igual que el nombre y el precio: la comanda se imprime con lo que
   * se vendió, no con lo que diga la carta cuando salga el papel.
   */
  allergens: string[];
}

/** Suma de un modificador por unidad. Puede ser negativa («sin papas» descuenta). */
export function deltaDe(linea: LineaDeTicket): Money {
  return linea.modifiers.reduce(
    (acc, m) => acc.add(Money.fromMinor(m.priceDeltaMinor)),
    Money.fromMinor(0),
  );
}

/** Total de una línea: (precio + modificadores) × cantidad. */
export function totalDeLinea(linea: LineaDeTicket): Money {
  return Money.fromMinor(linea.unitPriceMinor)
    .add(deltaDe(linea))
    .multiplyByQuantity(linea.quantity);
}

/** Total del ticket. Es el número gigante de abajo a la derecha. */
export function totalDeTicket(lineas: readonly LineaDeTicket[]): Money {
  return lineas.reduce(
    (acc, l) => acc.add(totalDeLinea(l)),
    Money.fromMinor(0),
  );
}

/**
 * ¿Está completa la selección de modificadores de un producto?
 *
 * Devuelve el motivo, no un booleano. La spec lo pide explícitamente: el botón
 * se deshabilita **con explicación**, porque un botón gris sin decir por qué es
 * lo que hace que el cajero llame al encargado en mitad de la cola.
 */
export function faltaPorElegir(
  grupos: readonly GrupoDeModificadores[],
  elegidas: ReadonlySet<string>,
): string | null {
  for (const g of grupos) {
    const cuantas = g.options.filter((o) => elegidas.has(o.id)).length;
    if (cuantas < g.minSelections) {
      const faltan = g.minSelections - cuantas;
      return `Elige ${faltan} más en «${g.name}».`;
    }
    if (cuantas > g.maxSelections) {
      return `En «${g.name}» solo se pueden elegir ${g.maxSelections}.`;
    }
  }
  return null;
}

/** Añade un producto al ticket con sus modificadores ya elegidos. */
export function nuevaLinea(
  producto: ProductoDeCarta,
  opciones: readonly SeleccionDeModificador[],
): LineaDeTicket {
  return {
    key: ulid(),
    productId: producto.id,
    productName: producto.name,
    allergens: alergenosDe(producto.allergens),
    quantity: 1,
    unitPriceMinor: producto.price.minorUnits,
    modifiers: [...opciones],
  };
}

/**
 * Convierte el ticket en el pedido que viaja al servidor.
 *
 * El `clientId` es un ULID generado **aquí**: es la clave natural del dedupe
 * (ADR-0010). Sincronizar dos veces el mismo lote no crea dos ventas, y esa
 * garantía nace en este dispositivo, no en el servidor.
 *
 * `totalMinor` es el que el POS **cobró de verdad**. El servidor recalcula y
 * compara: si divergiera, prevalece lo cobrado y la diferencia queda como
 * alerta (RN-T07). Un cliente que ya pagó y se fue no puede recibir una
 * corrección tres horas después.
 */
export function aPedidoOffline(
  lineas: readonly LineaDeTicket[],
  contexto: {
    brandId: string;
    locationId: string;
    paymentMethod: string;
    ahora: Date;
  },
): PedidoOffline {
  const total = totalDeTicket(lineas);

  const lineasOffline: LineaOffline[] = lineas.map((l) => {
    const modificadores = deltaDe(l).multiplyByQuantity(l.quantity);
    return {
      productId: l.productId,
      productName: l.productName,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: totalDeLinea(l).minorUnits,
      ...(modificadores.minorUnits !== 0
        ? { modifiersTotalMinor: modificadores.minorUnits }
        : {}),
      ...(l.modifiers.length > 0
        ? {
            modifiers: l.modifiers.map((m) => ({
              id: m.id,
              name: m.name,
              priceDeltaMinor: m.priceDeltaMinor,
            })),
          }
        : {}),
    };
  });

  return {
    clientId: ulid(),
    brandId: contexto.brandId,
    locationId: contexto.locationId,
    channel: 'pos',
    lines: lineasOffline,
    totalMinor: total.minorUnits,
    soldAt: contexto.ahora.toISOString(),
    paymentMethod: contexto.paymentMethod,
  };
}

/**
 * Vuelto a partir de lo entregado. `null` si no alcanza.
 *
 * Se calcula con `Money` y no restando números: el vuelto es dinero que se
 * pone en la mano de alguien, y un céntimo de coma flotante ahí es una
 * discusión en el mostrador.
 */
export function vuelto(total: Money, entregado: Money): Money | null {
  if (entregado.minorUnits < total.minorUnits) return null;
  return entregado.subtract(total);
}
