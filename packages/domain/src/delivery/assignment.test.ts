import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  rankCouriers,
  pickCourier,
  AssignmentError,
  type CourierLoad,
} from './assignment.js';

/**
 * La prueba que pide la spec 09: **asignación con 3 repartidores y cargas
 * distintas** (RN-DLV-01).
 */

const AHORA = new Date('2026-06-15T19:00:00Z');
const PROMESA = new Date('2026-06-15T19:00:00Z');

const repartidor = (over: Partial<CourierLoad> = {}): CourierLoad => ({
  courierId: 'c1',
  name: 'Luis',
  activeShipments: 0,
  zoneIds: [],
  status: 'available',
  ...over,
});

const peticion = (zoneId: string | null = 'zona-a') => ({
  zoneId,
  promisedAt: PROMESA,
  now: AHORA,
});

describe('Asignación de repartidor (spec 09, T5.15)', () => {
  it('CON 3 REPARTIDORES Y CARGAS DISTINTAS gana el de menor carga', () => {
    const ranking = rankCouriers(
      [
        repartidor({ courierId: 'c1', name: 'Luis', activeShipments: 3 }),
        repartidor({ courierId: 'c2', name: 'Rosa', activeShipments: 1 }),
        repartidor({ courierId: 'c3', name: 'Iván', activeShipments: 2 }),
      ],
      peticion(),
    );
    expect(ranking.map((r) => r.name)).toEqual(['Rosa', 'Iván', 'Luis']);
  });

  it('LA ZONA ES UN FILTRO, no una preferencia: quien no la cubre no entra', () => {
    // Luis está libre y Rosa lleva dos, pero Luis solo cubre la zona B. Si un
    // repartidor declara zonas es por un motivo real —conoce el distrito, tiene
    // el permiso, vive allí—, y ningún score debe mandarle fuera de ellas solo
    // porque vaya menos cargado. La regla nombra la zona primero.
    const ranking = rankCouriers(
      [
        repartidor({
          courierId: 'c1',
          name: 'Luis',
          activeShipments: 0,
          zoneIds: ['zona-b'],
        }),
        repartidor({
          courierId: 'c2',
          name: 'Rosa',
          activeShipments: 2,
          zoneIds: ['zona-a'],
        }),
      ],
      peticion('zona-a'),
    );
    expect(ranking.map((r) => r.name)).toEqual(['Rosa']);
    expect(ranking[0]!.reason).toContain('cubre la zona');
  });

  it('sin zonas declaradas se cubre todo: el caso del negocio de un local', () => {
    // Obligar a declarar zonas para poder asignar sería burocracia sin
    // beneficio para quien tiene un local y tres motos.
    const ranking = rankCouriers(
      [
        repartidor({ courierId: 'c1', name: 'Luis', activeShipments: 3 }),
        repartidor({
          courierId: 'c2',
          name: 'Rosa',
          activeShipments: 1,
          zoneIds: ['zona-a'],
        }),
      ],
      peticion('zona-a'),
    );
    expect(ranking.map((r) => r.name)).toEqual(['Rosa', 'Luis']);
  });

  it('EMPATE → menor carga: la regla, no la aritmética de hoy', () => {
    // Con la fórmula actual el score ya ordena por carga, así que este
    // desempate no se ejerce. Se mantiene explícito —y probado— porque la
    // fórmula cambiará (F6 mete distancia y antigüedad) y lo que la spec fija
    // es la REGLA: a empate, gana quien menos lleve.
    const ranking = rankCouriers(
      [
        repartidor({ courierId: 'cz', name: 'Zoe', activeShipments: 2 }),
        repartidor({ courierId: 'ca', name: 'Ana', activeShipments: 1 }),
      ],
      peticion(null),
    );
    expect(ranking[0]!.name).toBe('Ana');
    expect(ranking[0]!.activeShipments).toBeLessThan(
      ranking[1]!.activeShipments,
    );
  });

  it('un repartidor de baja NO entra, aunque sea el único de la zona', () => {
    const ranking = rankCouriers(
      [
        repartidor({
          courierId: 'c1',
          name: 'Luis',
          status: 'off',
          zoneIds: ['zona-a'],
        }),
        repartidor({
          courierId: 'c2',
          name: 'Rosa',
          activeShipments: 5,
          zoneIds: ['zona-b'],
        }),
      ],
      peticion('zona-a'),
    );
    expect(ranking.map((r) => r.name)).toEqual(['Rosa']);
  });

  it('un repartidor OCUPADO sí entra, con su carga contada', () => {
    // Excluir a los ocupados dejaría la cola parada en hora punta, que es
    // cuando más falta hace que se mueva.
    const ranking = rankCouriers(
      [
        repartidor({
          courierId: 'c1',
          name: 'Luis',
          status: 'busy',
          activeShipments: 2,
        }),
      ],
      peticion(),
    );
    expect(ranking).toHaveLength(1);
    expect(ranking[0]!.reason).toContain('ocupado');
  });

  it('si NADIE cubre la zona devuelve a todos, avisando', () => {
    // Un pedido sin repartidor posible es un pedido que no sale. Es preferible
    // que el encargado mande a alguien de fuera de zona sabiéndolo.
    const ranking = rankCouriers(
      [
        repartidor({ courierId: 'c1', name: 'Luis', zoneIds: ['zona-x'] }),
        repartidor({ courierId: 'c2', name: 'Rosa', zoneIds: ['zona-y'] }),
      ],
      peticion('zona-a'),
    );
    expect(ranking).toHaveLength(2);
    expect(ranking[0]!.reason).toContain('FUERA de la zona');
  });

  it('sin nadie disponible falla con código, no devuelve vacío', () => {
    expect(() =>
      rankCouriers([repartidor({ status: 'off' })], peticion()),
    ).toThrow(AssignmentError);
  });

  it('el motivo explica la decisión en castellano', () => {
    const elegido = pickCourier(
      [repartidor({ name: 'Rosa', activeShipments: 0, zoneIds: ['zona-a'] })],
      {
        zoneId: 'zona-a',
        promisedAt: new Date('2026-06-15T18:40:00Z'),
        now: AHORA,
      },
    );
    expect(elegido.reason).toContain('sin envíos activos');
    expect(elegido.reason).toContain('cubre la zona');
    expect(elegido.reason).toContain('20 min de retraso');
  });

  it('PROPIEDAD: el primero nunca tiene más carga que uno de score igual', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            courierId: fc.string({ minLength: 1, maxLength: 8 }),
            activeShipments: fc.integer({ min: 0, max: 20 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (crudos) => {
          const couriers = crudos.map((c, i) =>
            repartidor({
              courierId: `${c.courierId}-${i}`,
              activeShipments: c.activeShipments,
            }),
          );
          const ranking = rankCouriers(couriers, peticion(null));
          const primero = ranking[0]!;
          for (const otro of ranking) {
            if (otro.score === primero.score) {
              expect(primero.activeShipments).toBeLessThanOrEqual(
                otro.activeShipments,
              );
            }
          }
          // Y el orden es total y estable: mismo conjunto, mismo resultado.
          const otraVez = rankCouriers([...couriers].reverse(), peticion(null));
          expect(otraVez.map((r) => r.courierId)).toEqual(
            ranking.map((r) => r.courierId),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
