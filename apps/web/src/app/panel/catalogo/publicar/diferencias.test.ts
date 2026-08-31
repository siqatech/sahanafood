import { describe, it, expect } from 'vitest';
import {
  resumenDeDiferencias,
  rotuloDeCampo,
  valorLegible,
  solesDeMenores,
  tocaElPrecio,
  type DiferenciaDeCarta,
} from './diferencias';

/**
 * Lo que se lee antes de publicar.
 *
 * Publicar empuja la carta a los canales. Lo que se defiende aquí es que el
 * resumen diga lo que el cliente va a notar, y sobre todo **que un precio se
 * lea como un precio**: la escala del dominio es 4, y dividir entre 100 daría
 * importes cien veces mayores justo en la pantalla que decide qué se cobra.
 */

const vacio: DiferenciaDeCarta = {
  added: [],
  removed: [],
  changed: [],
  identical: true,
};

describe('resumenDeDiferencias', () => {
  it('sin cambios lo dice, en vez de enseñar tres ceros', () => {
    expect(resumenDeDiferencias(vacio)).toContain('ningún cambio');
  });

  it('cuenta los tres grupos y omite los vacíos', () => {
    const r = resumenDeDiferencias({
      added: [{ id: 'a', name: 'Nuevo' }],
      removed: [],
      changed: [
        { id: 'c', name: 'Uno', changes: [] },
        { id: 'd', name: 'Otro', changes: [] },
      ],
      identical: false,
    });
    expect(r).toBe('1 plato nuevo · 2 platos con cambios');
    // Un «0 fuera de carta» obligaría a leer la línea entera para encontrar el
    // número que no es cero.
    expect(r).not.toContain('0 ');
  });

  it('singular y plural, que es lo que se lee de un vistazo', () => {
    expect(
      resumenDeDiferencias({
        added: [],
        removed: [{ id: 'x', name: 'Se fue' }],
        changed: [],
        identical: false,
      }),
    ).toBe('1 plato fuera de carta');
  });

  it('no inventa un resumen si el dominio dice que hay cambios y no los trae', () => {
    expect(
      resumenDeDiferencias({
        added: [],
        removed: [],
        changed: [],
        identical: false,
      }),
    ).toContain('Sin diferencias');
  });
});

describe('cómo se lee un cambio', () => {
  it('los campos van en el idioma de quien vende', () => {
    expect(rotuloDeCampo('priceMinor')).toBe('precio');
    expect(rotuloDeCampo('prepMinutes')).toBe('tiempo de preparación');
    // Un campo que no esté en la lista se enseña tal cual antes que ocultarlo:
    // un cambio que no se ve es peor que uno con nombre técnico.
    expect(rotuloDeCampo('loQueSea')).toBe('loQueSea');
  });

  it('EL PRECIO se lee en soles, con la escala del dominio', () => {
    // 4 decimales, no 2. Con `/100` un plato de S/ 32.00 se leería «S/ 3200».
    expect(solesDeMenores(320_000)).toBe('32.00');
    expect(valorLegible('priceMinor', 320_000)).toBe('S/ 32.00');
    expect(valorLegible('priceMinor', 5_000)).toBe('S/ 0.50');
  });

  it('un booleano se lee sí/no y un vacío como raya', () => {
    expect(valorLegible('available', true)).toBe('sí');
    expect(valorLegible('available', false)).toBe('no');
    expect(valorLegible('description', null)).toBe('—');
    expect(valorLegible('description', undefined)).toBe('—');
  });
});

describe('tocaElPrecio', () => {
  it('distingue el cambio que se cobra del que no', () => {
    // Un nombre distinto se corrige mañana; un precio publicado mal se cobra
    // hasta que alguien lo vea.
    expect(
      tocaElPrecio({
        id: 'p',
        name: 'x',
        changes: [{ field: 'name', from: 'a', to: 'b' }],
      }),
    ).toBe(false);
    expect(
      tocaElPrecio({
        id: 'p',
        name: 'x',
        changes: [
          { field: 'name', from: 'a', to: 'b' },
          { field: 'priceMinor', from: 1, to: 2 },
        ],
      }),
    ).toBe(true);
  });
});
