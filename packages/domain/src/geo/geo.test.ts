import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  BOUNDARY_EPSILON,
  boundingBox,
  inBoundingBox,
  isOnBoundary,
  isPointInPolygon,
  selectCoverageZone,
  GeoError,
  type Position,
  type Ring,
  type CoverageZone,
} from './geo.js';

// Cuadrado unitario con vértices en (0,0), (0,1), (1,1), (1,0).
const square: Ring = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

// Polígono cóncavo en forma de L, para que el cruce de rayos trabaje de verdad.
const lShape: Ring = [
  [0, 0],
  [0, 3],
  [1, 3],
  [1, 1],
  [3, 1],
  [3, 0],
];

describe('boundingBox', () => {
  it('calcula el rectángulo envolvente', () => {
    expect(boundingBox(square)).toEqual({
      minLng: 0,
      minLat: 0,
      maxLng: 1,
      maxLat: 1,
    });
  });

  it('rechaza polígonos degenerados', () => {
    expect(() => boundingBox([[0, 0]] as unknown as Ring)).toThrow(GeoError);
    expect(() =>
      boundingBox([
        [0, 0],
        [1, 1],
      ] as unknown as Ring),
    ).toThrow(GeoError);
  });

  it('inBoundingBox incluye los bordes', () => {
    const box = boundingBox(square);
    expect(inBoundingBox([0, 0], box)).toBe(true);
    expect(inBoundingBox([0.5, 0.5], box)).toBe(true);
    expect(inBoundingBox([1.1, 0.5], box)).toBe(false);
    expect(inBoundingBox([0.5, -0.1], box)).toBe(false);
  });
});

describe('isPointInPolygon — interior y exterior', () => {
  it('detecta el interior', () => {
    expect(isPointInPolygon([0.5, 0.5], square)).toBe(true);
  });

  it('detecta el exterior', () => {
    expect(isPointInPolygon([2, 2], square)).toBe(false);
    expect(isPointInPolygon([-0.001, 0.5], square)).toBe(false);
  });

  it('resuelve correctamente un polígono cóncavo (forma de L)', () => {
    expect(isPointInPolygon([0.5, 2.5], lShape)).toBe(true); // brazo vertical
    expect(isPointInPolygon([2.5, 0.5], lShape)).toBe(true); // brazo horizontal
    // El hueco de la L queda FUERA aunque esté dentro del rectángulo envolvente.
    expect(isPointInPolygon([2.5, 2.5], lShape)).toBe(false);
    expect(inBoundingBox([2.5, 2.5], boundingBox(lShape))).toBe(true);
  });

  it('rechaza polígonos degenerados', () => {
    expect(() => isPointInPolygon([0, 0], [[0, 0]] as unknown as Ring)).toThrow(
      GeoError,
    );
  });
});

describe('isPointInPolygon — FRONTERA (caso exigido por la spec)', () => {
  it('un vértice cuenta como dentro', () => {
    expect(isPointInPolygon([0, 0], square)).toBe(true);
    expect(isPointInPolygon([1, 1], square)).toBe(true);
  });

  it('un punto sobre una arista cuenta como dentro', () => {
    expect(isPointInPolygon([0.5, 0], square)).toBe(true); // borde inferior
    expect(isPointInPolygon([0, 0.5], square)).toBe(true); // borde izquierdo
    expect(isPointInPolygon([1, 0.5], square)).toBe(true); // borde derecho
    expect(isPointInPolygon([0.5, 1], square)).toBe(true); // borde superior
  });

  it('la frontera puede excluirse explícitamente', () => {
    expect(isPointInPolygon([0.5, 0], square, { includeBoundary: false })).toBe(
      false,
    );
    // El interior no cambia.
    expect(
      isPointInPolygon([0.5, 0.5], square, { includeBoundary: false }),
    ).toBe(true);
  });

  it('isOnBoundary distingue borde de interior', () => {
    expect(isOnBoundary([0.5, 0], square)).toBe(true);
    expect(isOnBoundary([0.5, 0.5], square)).toBe(false);
    expect(isOnBoundary([5, 5], square)).toBe(false);
  });

  it('es estable con coordenadas reales de Lima', () => {
    // Zona pequeña alrededor de Miraflores.
    const zona: Ring = [
      [-77.035, -12.13],
      [-77.035, -12.11],
      [-77.015, -12.11],
      [-77.015, -12.13],
    ];
    expect(isPointInPolygon([-77.025, -12.12], zona)).toBe(true);
    expect(isPointInPolygon([-77.05, -12.12], zona)).toBe(false);
    // Exactamente en el vértice.
    expect(isPointInPolygon([-77.035, -12.13], zona)).toBe(true);
  });
});

describe('selectCoverageZone (RN-ORG-02)', () => {
  const zona = (
    id: string,
    polygon: Ring,
    deliveryFeeMinor: number,
    extra: Partial<CoverageZone> = {},
  ): CoverageZone => ({
    id,
    polygon,
    deliveryFeeMinor,
    minOrderMinor: 200_000,
    baseMinutes: 30,
    ...extra,
  });

  const grande: Ring = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
  ];
  const pequena: Ring = [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
  ];

  it('devuelve undefined si ninguna zona cubre el punto', () => {
    expect(
      selectCoverageZone([50, 50], [zona('a', grande, 500_000)]),
    ).toBeUndefined();
  });

  it('devuelve la única zona que cubre', () => {
    const z = selectCoverageZone([5, 5], [zona('a', grande, 500_000)]);
    expect(z?.id).toBe('a');
  });

  it('con solapamiento gana la de MENOR tarifa', () => {
    const zonas = [
      zona('cara', grande, 900_000),
      zona('barata', pequena, 300_000),
    ];
    // Punto en la intersección.
    expect(selectCoverageZone([1, 1], zonas)?.id).toBe('barata');
    // Punto solo en la grande.
    expect(selectCoverageZone([5, 5], zonas)?.id).toBe('cara');
  });

  it('ignora zonas inactivas', () => {
    const zonas = [
      zona('inactiva', pequena, 100_000, { active: false }),
      zona('activa', grande, 900_000),
    ];
    expect(selectCoverageZone([1, 1], zonas)?.id).toBe('activa');
  });

  it('rompe empates de forma determinista y repetible', () => {
    const zonas = [
      zona('b', grande, 500_000, { minOrderMinor: 100_000 }),
      zona('a', grande, 500_000, { minOrderMinor: 100_000 }),
    ];
    // Misma tarifa y mismo mínimo → decide el id, siempre igual.
    const primera = selectCoverageZone([5, 5], zonas)?.id;
    const segunda = selectCoverageZone([5, 5], [...zonas].reverse())?.id;
    expect(primera).toBe('a');
    expect(segunda).toBe('a');
  });

  it('con igual tarifa prefiere el menor pedido mínimo', () => {
    const zonas = [
      zona('alta', grande, 500_000, { minOrderMinor: 500_000 }),
      zona('baja', grande, 500_000, { minOrderMinor: 100_000 }),
    ];
    expect(selectCoverageZone([5, 5], zonas)?.id).toBe('baja');
  });

  it('con igual tarifa y mínimo prefiere el menor tiempo base', () => {
    const zonas = [
      zona('lenta', grande, 500_000, { baseMinutes: 60 }),
      zona('rapida', grande, 500_000, { baseMinutes: 20 }),
    ];
    expect(selectCoverageZone([5, 5], zonas)?.id).toBe('rapida');
  });

  it('sin zonas devuelve undefined', () => {
    expect(selectCoverageZone([1, 1], [])).toBeUndefined();
  });

  it('el resultado no depende del orden de la lista', () => {
    // Cada criterio de desempate, con el mejor candidato PRIMERO y último.
    const porTarifa = [
      zona('barata', grande, 100_000),
      zona('cara', grande, 900_000),
    ];
    expect(selectCoverageZone([5, 5], porTarifa)?.id).toBe('barata');
    expect(selectCoverageZone([5, 5], [...porTarifa].reverse())?.id).toBe(
      'barata',
    );

    const porMinimo = [
      zona('bajo', grande, 500_000, { minOrderMinor: 100_000 }),
      zona('alto', grande, 500_000, { minOrderMinor: 900_000 }),
    ];
    expect(selectCoverageZone([5, 5], porMinimo)?.id).toBe('bajo');
    expect(selectCoverageZone([5, 5], [...porMinimo].reverse())?.id).toBe(
      'bajo',
    );

    const porTiempo = [
      zona('rapida', grande, 500_000, { baseMinutes: 15 }),
      zona('lenta', grande, 500_000, { baseMinutes: 90 }),
    ];
    expect(selectCoverageZone([5, 5], porTiempo)?.id).toBe('rapida');
    expect(selectCoverageZone([5, 5], [...porTiempo].reverse())?.id).toBe(
      'rapida',
    );
  });
});

describe('Propiedades (fast-check)', () => {
  const coord = () => fc.double({ min: -3, max: 6, noNaN: true });

  it('todo punto dentro del polígono pasa el pre-filtro de bounding box', () => {
    // Con la MISMA tolerancia que usa la frontera. Sin ella, un punto a
    // distancia infinitesimal del borde (p. ej. [-5e-324, 0]) sería aceptado
    // por isPointInPolygon y descartado por el pre-filtro: el fallo real que
    // esta propiedad encontró.
    fc.assert(
      fc.property(coord(), coord(), (lng, lat) => {
        const p: Position = [lng, lat];
        if (isPointInPolygon(p, lShape)) {
          expect(inBoundingBox(p, boundingBox(lShape), BOUNDARY_EPSILON)).toBe(
            true,
          );
        }
      }),
    );
  });

  it('la zona elegida siempre cubre el punto y es la de menor tarifa', () => {
    const zonas: CoverageZone[] = [
      {
        id: 'grande',
        polygon: [
          [0, 0],
          [0, 5],
          [5, 5],
          [5, 0],
        ],
        deliveryFeeMinor: 800_000,
        minOrderMinor: 0,
        baseMinutes: 40,
      },
      {
        id: 'centro',
        polygon: [
          [1, 1],
          [1, 3],
          [3, 3],
          [3, 1],
        ],
        deliveryFeeMinor: 300_000,
        minOrderMinor: 0,
        baseMinutes: 20,
      },
    ];

    fc.assert(
      fc.property(coord(), coord(), (lng, lat) => {
        const p: Position = [lng, lat];
        const elegida = selectCoverageZone(p, zonas);
        if (!elegida) return;
        // La elegida cubre el punto...
        expect(isPointInPolygon(p, elegida.polygon)).toBe(true);
        // ...y ninguna otra que lo cubra es más barata.
        for (const z of zonas) {
          if (isPointInPolygon(p, z.polygon)) {
            expect(elegida.deliveryFeeMinor).toBeLessThanOrEqual(
              z.deliveryFeeMinor,
            );
          }
        }
      }),
    );
  });
});
