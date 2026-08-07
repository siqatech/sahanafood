import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  diffCatalogVersions,
  applyCatalogDiff,
  CatalogDiffError,
  type CatalogSnapshot,
  type CatalogSnapshotProduct,
} from './version-diff.js';

const snapshot = (
  products: CatalogSnapshotProduct[],
  extra: Record<string, unknown> = {},
): CatalogSnapshot => ({
  brandId: 'marca-1',
  channel: 'web',
  products,
  ...extra,
});

const producto = (
  id: string,
  over: Partial<CatalogSnapshotProduct> = {},
): CatalogSnapshotProduct => ({
  id,
  name: `Producto ${id}`,
  priceMinor: 100_000,
  available: true,
  ...over,
});

describe('Diff entre versiones de catálogo', () => {
  it('dos versiones iguales no producen diff', () => {
    const v = snapshot([producto('a'), producto('b')]);
    const d = diffCatalogVersions(v, v);
    expect(d.identical).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('detecta productos añadidos y retirados', () => {
    const d = diffCatalogVersions(
      snapshot([producto('a'), producto('b')]),
      snapshot([producto('b'), producto('c')]),
    );
    expect(d.added.map((p) => p.id)).toEqual(['c']);
    expect(d.removed.map((p) => p.id)).toEqual(['a']);
    expect(d.identical).toBe(false);
  });

  it('detecta el cambio de precio con su valor anterior', () => {
    // El «antes» no es decorativo: el POS lo usa para avisar de que el precio
    // que tenía en pantalla ya no vale.
    const d = diffCatalogVersions(
      snapshot([producto('a', { priceMinor: 300_000 })]),
      snapshot([producto('a', { priceMinor: 350_000 })]),
    );
    expect(d.changed).toEqual([
      {
        id: 'a',
        name: 'Producto a',
        changes: [{ field: 'priceMinor', from: 300_000, to: 350_000 }],
      },
    ]);
  });

  it('detecta que un producto dejó de estar disponible', () => {
    const d = diffCatalogVersions(
      snapshot([producto('a', { available: true })]),
      snapshot([producto('a', { available: false })]),
    );
    expect(d.changed[0]!.changes).toEqual([
      { field: 'available', from: true, to: false },
    ]);
  });

  it('IGNORA los metadatos que cambian en cada publicación', () => {
    // Si el diff comparase todas las claves, `resolvedAt` haría que nunca
    // estuviera vacío: la PWA se bajaría el catálogo entero siempre y el diff
    // no serviría para nada.
    const d = diffCatalogVersions(
      snapshot([producto('a')], { resolvedAt: '2026-08-07T10:00:00Z' }),
      snapshot([producto('a')], { resolvedAt: '2026-08-07T18:00:00Z' }),
    );
    expect(d.identical).toBe(true);
  });

  it('trata ausente y nulo como el mismo hecho', () => {
    const d = diffCatalogVersions(
      snapshot([producto('a', { description: null })]),
      snapshot([producto('a')]),
    );
    expect(d.identical).toBe(true);
  });

  it('acumula varios cambios del mismo producto', () => {
    const d = diffCatalogVersions(
      snapshot([producto('a', { name: 'Antiguo', priceMinor: 100_000 })]),
      snapshot([producto('a', { name: 'Nuevo', priceMinor: 120_000 })]),
    );
    expect(d.changed[0]!.changes.map((c) => c.field).sort()).toEqual([
      'name',
      'priceMinor',
    ]);
  });
});

describe('Aplicar el diff reconstruye la versión destino', () => {
  it('un diff aplicado sobre la base da exactamente el destino', () => {
    const v1 = snapshot([
      producto('a', { priceMinor: 100_000 }),
      producto('b'),
    ]);
    const v2 = snapshot([
      producto('a', { priceMinor: 150_000 }),
      producto('c'),
    ]);

    const reconstruido = applyCatalogDiff(v1, diffCatalogVersions(v1, v2));
    const ordenar = (s: CatalogSnapshot) =>
      [...s.products].sort((x, y) => x.id.localeCompare(y.id));

    expect(ordenar(reconstruido)).toEqual(ordenar(v2));
  });

  it('un diff que toca un producto inexistente falla en vez de aplicar a medias', () => {
    // Las versiones no encajan. Aplicar la mitad dejaría al POS vendiendo con
    // un catálogo que no es ninguno de los dos.
    const base = snapshot([producto('a')]);
    const diffAjeno = diffCatalogVersions(
      snapshot([producto('z', { priceMinor: 1 })]),
      snapshot([producto('z', { priceMinor: 2 })]),
    );
    expect(() => applyCatalogDiff(base, diffAjeno)).toThrow(CatalogDiffError);
  });

  it('PROPIEDAD: aplicar el diff siempre reconstruye el destino', () => {
    // La propiedad que de verdad importa: da igual qué cambie entre dos
    // versiones, el POS que aplica el diff termina con el mismo catálogo que
    // el servidor. Escribir los casos a mano dejaría huecos justo en las
    // combinaciones raras.
    const arbProducto = fc.record({
      id: fc.string({ minLength: 1, maxLength: 4 }),
      name: fc.string({ maxLength: 8 }),
      priceMinor: fc.integer({ min: 0, max: 1_000_000 }),
      available: fc.boolean(),
      prepMinutes: fc.integer({ min: 1, max: 60 }),
    });
    const arbSnapshot = fc.array(arbProducto, { maxLength: 12 }).map((ps) => {
      // Ids únicos: dos productos con el mismo id no es un catálogo válido.
      const porId = new Map(ps.map((p) => [p.id, p]));
      return snapshot([...porId.values()]);
    });

    fc.assert(
      fc.property(arbSnapshot, arbSnapshot, (v1, v2) => {
        const resultado = applyCatalogDiff(v1, diffCatalogVersions(v1, v2));
        const clave = (s: CatalogSnapshot) =>
          JSON.stringify(
            [...s.products]
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((p) => ({
                id: p.id,
                name: p.name,
                priceMinor: p.priceMinor,
                available: p.available,
                prepMinutes: p.prepMinutes,
              })),
          );
        expect(clave(resultado)).toBe(clave(v2));
      }),
      { numRuns: 300 },
    );
  });
});
