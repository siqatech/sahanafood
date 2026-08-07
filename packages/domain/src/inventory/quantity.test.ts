import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  Quantity,
  QuantityError,
  sumQuantities,
  QUANTITY_SCALE,
} from './quantity.js';

/**
 * Quantity existe por el mismo motivo que Money: una receta dice «0.150 kg», el
 * pedido lleva 3 y la merma es del 5 %. Con coma flotante el error se acumula
 * movimiento a movimiento en un kardex append-only, y al cabo de un día el
 * stock materializado deja de cuadrar con la suma de movimientos.
 */

describe('Quantity', () => {
  it('no arrastra el error de coma flotante que le da sentido', () => {
    // 0.1 + 0.2 !== 0.3 en JavaScript. Aquí sí.
    const a = Quantity.fromDecimal(0.1, 'g');
    const b = Quantity.fromDecimal(0.2, 'g');
    expect(a.add(b).equals(Quantity.fromDecimal(0.3, 'g'))).toBe(true);
    expect(a.add(b).toDatabase()).toBe('0.3000');
  });

  it('se niega a sumar unidades distintas', () => {
    // Sumar gramos con mililitros produce una lista de compra imposible y un
    // food cost que nadie sabe explicar.
    const g = Quantity.fromDecimal(100, 'g');
    const ml = Quantity.fromDecimal(100, 'ml');
    expect(() => g.add(ml)).toThrow(QuantityError);
    expect(() => g.subtract(ml)).toThrow(/unidades distintas/);
    expect(() => g.compare(ml)).toThrow(QuantityError);
    // Comparar por igualdad NO lanza: son distintas, y ya está.
    expect(g.equals(ml)).toBe(false);
  });

  it('aplica mermas en puntos básicos, no en decimal', () => {
    // Un 5 % escrito como `1.05` arrastra justo el error que esto evita.
    const carne = Quantity.fromDecimal(0.15, 'g');
    expect(carne.applyBps(10_500).toDatabase()).toBe('0.1575');
    expect(carne.applyBps(10_000).equals(carne)).toBe(true);
    expect(carne.applyBps(0).isZero()).toBe(true);
  });

  it('redondea half-up, igual que Money', () => {
    // Dos redondeos distintos en el mismo sistema son dos formas de descuadrar.
    const q = Quantity.fromMinorUnits(1, 'g'); // 0.0001
    expect(q.applyBps(15_000).minorUnits).toBe(2); // 0.00015 → 0.0002
    expect(q.applyBps(5_000).minorUnits).toBe(1); // 0.00005 → 0.0001
  });

  it('multiply solo acepta enteros: los porcentajes van por applyBps', () => {
    const q = Quantity.fromDecimal(1, 'unit');
    expect(q.multiply(3).toDecimal()).toBe(3);
    expect(() => q.multiply(1.05)).toThrow(/applyBps/);
  });

  it('rechaza mermas negativas', () => {
    expect(() => Quantity.fromDecimal(1, 'g').applyBps(-1)).toThrow(
      QuantityError,
    );
  });

  it('admite cantidades negativas: el stock negativo está permitido', () => {
    // RN-INV-02: jamás se bloquea una venta por stock. Un negativo es un aviso,
    // no un estado imposible.
    const negativa = Quantity.fromDecimal(-5, 'unit');
    expect(negativa.isNegative()).toBe(true);
    expect(negativa.toDatabase()).toBe('-5.0000');
  });

  it('serializa a NUMERIC(14,4) sin pasar por coma flotante', () => {
    expect(Quantity.fromDecimal(0.15, 'g').toDatabase()).toBe('0.1500');
    expect(Quantity.fromDecimal(1234.5678, 'g').toDatabase()).toBe('1234.5678');
    expect(Quantity.zero('ml').toDatabase()).toBe('0.0000');
  });

  it('lee lo que devuelve PostgreSQL y vuelve a lo mismo', () => {
    const q = Quantity.fromDatabase('0.1500', 'g');
    expect(q.toDatabase()).toBe('0.1500');
    expect(() => Quantity.fromDatabase('no es número', 'g')).toThrow(
      QuantityError,
    );
  });

  it('sumQuantities parte de cero en la unidad indicada', () => {
    expect(sumQuantities([], 'g').isZero()).toBe(true);
    const total = sumQuantities(
      [Quantity.fromDecimal(1, 'g'), Quantity.fromDecimal(2.5, 'g')],
      'g',
    );
    expect(total.toDatabase()).toBe('3.5000');
  });

  it('es inmutable: operar devuelve otra instancia', () => {
    const q = Quantity.fromDecimal(1, 'g');
    q.add(Quantity.fromDecimal(1, 'g'));
    expect(q.toDecimal()).toBe(1);
    expect(Object.isFrozen(q)).toBe(true);
  });

  it('rechaza valores no finitos y unidades inventadas', () => {
    expect(() => Quantity.fromDecimal(Number.NaN, 'g')).toThrow(QuantityError);
    expect(() => Quantity.fromDecimal(Infinity, 'g')).toThrow(QuantityError);
    expect(() => Quantity.fromMinorUnits(1, 'kg' as unknown as 'g')).toThrow(
      /Unidad desconocida/,
    );
  });
});

describe('Quantity — propiedades', () => {
  const unidadesMenores = fc.integer({ min: -(10 ** 9), max: 10 ** 9 });

  it('sumar y restar la misma cantidad deja el valor intacto', () => {
    fc.assert(
      fc.property(unidadesMenores, unidadesMenores, (a, b) => {
        const qa = Quantity.fromMinorUnits(a, 'g');
        const qb = Quantity.fromMinorUnits(b, 'g');
        expect(qa.add(qb).subtract(qb).equals(qa)).toBe(true);
      }),
    );
  });

  it('la suma es asociativa y conmutativa: el kardex se suma en cualquier orden', () => {
    // No es un detalle académico: el stock se recalcula sumando movimientos, y
    // el orden lo decide la base de datos.
    fc.assert(
      fc.property(
        fc.array(unidadesMenores, { minLength: 1, maxLength: 30 }),
        (valores) => {
          const cantidades = valores.map((v) =>
            Quantity.fromMinorUnits(v, 'g'),
          );
          const directo = sumQuantities(cantidades, 'g');
          const alReves = sumQuantities([...cantidades].reverse(), 'g');
          expect(directo.equals(alReves)).toBe(true);
        },
      ),
    );
  });

  it('ida y vuelta por la base de datos conserva el valor exacto', () => {
    fc.assert(
      fc.property(unidadesMenores, (v) => {
        const q = Quantity.fromMinorUnits(v, 'ml');
        expect(Quantity.fromDatabase(q.toDatabase(), 'ml').equals(q)).toBe(
          true,
        );
      }),
    );
  });

  it('toDatabase siempre trae los 4 decimales que espera NUMERIC(14,4)', () => {
    fc.assert(
      fc.property(unidadesMenores, (v) => {
        const texto = Quantity.fromMinorUnits(v, 'g').toDatabase();
        expect(texto.split('.')[1]).toHaveLength(QUANTITY_SCALE);
      }),
    );
  });

  it('multiplicar por n equivale a sumar n veces', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -(10 ** 6), max: 10 ** 6 }),
        fc.integer({ min: 1, max: 50 }),
        (v, n) => {
          const q = Quantity.fromMinorUnits(v, 'unit');
          let sumada = Quantity.zero('unit');
          for (let i = 0; i < n; i++) sumada = sumada.add(q);
          expect(q.multiply(n).equals(sumada)).toBe(true);
        },
      ),
    );
  });
});
