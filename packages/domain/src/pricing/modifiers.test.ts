import { describe, it, expect } from 'vitest';
import { assertValidGroupDefinition, type ModifierGroup } from './modifiers.js';
import { MoneyError } from '../money/money.js';

/**
 * Validación de la DEFINICIÓN de un grupo (la usa el CRUD del catálogo al
 * guardar). Es distinta de validar la selección del cliente: aquí se impide
 * crear un grupo que sería imposible de satisfacer, en vez de esperar a que un
 * cliente lo descubra a mitad del pedido.
 */
const grupo = (over: Partial<ModifierGroup> = {}): ModifierGroup => ({
  id: 'g',
  name: 'Extras',
  minSelections: 0,
  maxSelections: 2,
  options: [
    { id: 'a', name: 'A', priceDeltaMinor: 0 },
    { id: 'b', name: 'B', priceDeltaMinor: 0 },
  ],
  ...over,
});

describe('assertValidGroupDefinition', () => {
  it('acepta una definición coherente', () => {
    expect(() => assertValidGroupDefinition(grupo())).not.toThrow();
  });

  it('acepta max > opciones si se permite repetir', () => {
    expect(() =>
      assertValidGroupDefinition(
        grupo({ maxSelections: 5, allowRepeat: true }),
      ),
    ).not.toThrow();
  });

  it('rechaza mínimo negativo o no entero', () => {
    expect(() =>
      assertValidGroupDefinition(grupo({ minSelections: -1 })),
    ).toThrow(MoneyError);
    expect(() =>
      assertValidGroupDefinition(grupo({ minSelections: 1.5 })),
    ).toThrow(/entero no negativo/);
  });

  it('rechaza máximo menor que 1', () => {
    expect(() =>
      assertValidGroupDefinition(grupo({ maxSelections: 0 })),
    ).toThrow(/al menos 1/);
    expect(() =>
      assertValidGroupDefinition(grupo({ maxSelections: 2.5 })),
    ).toThrow(MoneyError);
  });

  it('rechaza máximo menor que el mínimo', () => {
    expect(() =>
      assertValidGroupDefinition(grupo({ minSelections: 3, maxSelections: 2 })),
    ).toThrow(/no puede ser menor que el mínimo/);
  });

  it('rechaza pedir más opciones de las que existen sin permitir repetir', () => {
    // Un grupo así jamás podría satisfacerse: el cliente se quedaría bloqueado.
    expect(() =>
      assertValidGroupDefinition(grupo({ maxSelections: 5 })),
    ).toThrow(/supera el número de opciones disponibles/);
  });
});
