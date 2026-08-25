import { describe, it, expect } from 'vitest';
import { alergenosDe, avisoDeAlergenos } from './alergenos.js';

describe('alergenosDe', () => {
  it('deja la lista tal cual cuando viene bien', () => {
    expect(alergenosDe(['maní', 'lácteos'])).toEqual(['maní', 'lácteos']);
  });

  it('sobrevive a CUALQUIER cosa que traiga el jsonb', () => {
    // La columna la escribe el panel, el importador de Excel o una carta que
    // alguien pegó: un `as string[]` reventaría al pintar, y la pantalla que
    // revienta aquí es la que dice si el plato lleva maní.
    expect(alergenosDe(null)).toEqual([]);
    expect(alergenosDe(undefined)).toEqual([]);
    expect(alergenosDe('maní')).toEqual([]);
    expect(alergenosDe(42)).toEqual([]);
    expect(alergenosDe({ mani: true })).toEqual([]);
  });

  it('descarta la basura DENTRO del array sin tirar lo bueno', () => {
    expect(alergenosDe(['maní', null, 7, '', '  ', 'gluten'])).toEqual([
      'maní',
      'gluten',
    ]);
  });

  it('recorta espacios y no repite el mismo alérgeno', () => {
    // «Maní» y «maní» son el mismo alérgeno escrito por dos personas.
    expect(alergenosDe(['  maní ', 'Maní', 'MANÍ', 'soya'])).toEqual([
      'maní',
      'soya',
    ]);
  });
});

describe('avisoDeAlergenos', () => {
  it('redacta el aviso una sola vez, para las tres pantallas', () => {
    expect(avisoDeAlergenos(['maní', 'lácteos'])).toBe(
      'Contiene maní, lácteos.',
    );
  });

  it('sin alérgenos NO hay aviso, y eso es deliberado', () => {
    // Un «no contiene alérgenos» sería una afirmación que el restaurante no ha
    // hecho: lo único que sabemos es que no declaró ninguno, que no es lo
    // mismo. Devolver null obliga a la pantalla a decir la verdad.
    expect(avisoDeAlergenos([])).toBeNull();
  });
});
