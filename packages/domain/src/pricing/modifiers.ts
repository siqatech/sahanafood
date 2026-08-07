import { Money, MoneyError } from '../money/money.js';

/**
 * Grupos de modificadores (RN-CAT-05).
 *
 * «Sin ají / con doble queso / tamaño grande». La validación de min/max vive
 * aquí, en el dominio compartido, para que la PWA rechace una combinación
 * inválida ANTES de cobrarla y el servidor la rechace igual al sincronizar. Si
 * cada lado validara por su cuenta, el POS aceptaría un pedido que el servidor
 * rechaza — y en offline eso significa comida ya preparada que no se puede
 * facturar.
 */

export class ModifierError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly groupId?: string,
  ) {
    super(message);
    this.name = 'ModifierError';
  }
}

/** Opción concreta dentro de un grupo. El precio puede ser negativo (descuento). */
export interface ModifierOption {
  readonly id: string;
  readonly name: string;
  /** Ajuste de precio en unidades menores; negativo resta. */
  readonly priceDeltaMinor: number;
  readonly available?: boolean;
}

/**
 * Grupo de modificadores con sus reglas de selección.
 * `minSelections = 0` → opcional; `> 0` → obligatorio.
 */
export interface ModifierGroup {
  readonly id: string;
  readonly name: string;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly options: readonly ModifierOption[];
  /** Si permite elegir la misma opción varias veces (p. ej. «doble queso»). */
  readonly allowRepeat?: boolean;
}

/** Selección del cliente: qué opciones eligió de qué grupo. */
export interface ModifierSelection {
  readonly groupId: string;
  readonly optionIds: readonly string[];
}

/**
 * Valida las selecciones contra las reglas de los grupos y devuelve el ajuste
 * de precio total. Lanza `ModifierError` con código estable a la primera
 * infracción, para que la API pueda mapearlo a Problem Details.
 */
export function validateAndPriceModifiers(
  groups: readonly ModifierGroup[],
  selections: readonly ModifierSelection[],
  currency: Parameters<typeof Money.zero>[0] = 'PEN',
): Money {
  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const seenGroups = new Set<string>();
  let delta = Money.zero(currency);

  for (const selection of selections) {
    const group = byGroup.get(selection.groupId);
    if (!group) {
      throw new ModifierError(
        `El grupo de modificadores "${selection.groupId}" no existe en este producto.`,
        'MODIFIER_GROUP_UNKNOWN',
        selection.groupId,
      );
    }
    if (seenGroups.has(selection.groupId)) {
      throw new ModifierError(
        `El grupo "${group.name}" aparece dos veces en la selección.`,
        'MODIFIER_GROUP_DUPLICATED',
        group.id,
      );
    }
    seenGroups.add(selection.groupId);

    const count = selection.optionIds.length;
    if (count < group.minSelections) {
      throw new ModifierError(
        `"${group.name}" requiere al menos ${group.minSelections} opción(es).`,
        'MODIFIER_MIN_NOT_MET',
        group.id,
      );
    }
    if (count > group.maxSelections) {
      throw new ModifierError(
        `"${group.name}" admite como máximo ${group.maxSelections} opción(es).`,
        'MODIFIER_MAX_EXCEEDED',
        group.id,
      );
    }

    if (!group.allowRepeat && new Set(selection.optionIds).size !== count) {
      throw new ModifierError(
        `"${group.name}" no permite repetir la misma opción.`,
        'MODIFIER_REPEAT_NOT_ALLOWED',
        group.id,
      );
    }

    const optionsById = new Map(group.options.map((o) => [o.id, o]));
    for (const optionId of selection.optionIds) {
      const option = optionsById.get(optionId);
      if (!option) {
        throw new ModifierError(
          `La opción "${optionId}" no pertenece al grupo "${group.name}".`,
          'MODIFIER_OPTION_UNKNOWN',
          group.id,
        );
      }
      if (option.available === false) {
        throw new ModifierError(
          `"${option.name}" no está disponible en este momento.`,
          'MODIFIER_OPTION_UNAVAILABLE',
          group.id,
        );
      }
      delta = delta.add(Money.fromMinor(option.priceDeltaMinor, currency));
    }
  }

  // Un grupo obligatorio que el cliente no envió es igual de inválido que uno
  // enviado incompleto: se comprueba aparte porque no aparece en `selections`.
  for (const group of groups) {
    if (group.minSelections > 0 && !seenGroups.has(group.id)) {
      throw new ModifierError(
        `Debes elegir en "${group.name}" (mínimo ${group.minSelections}).`,
        'MODIFIER_MIN_NOT_MET',
        group.id,
      );
    }
  }

  return delta;
}

/** Comprobación de coherencia de la definición de un grupo (para el CRUD). */
export function assertValidGroupDefinition(group: ModifierGroup): void {
  if (!Number.isInteger(group.minSelections) || group.minSelections < 0) {
    throw new MoneyError(
      `"${group.name}": el mínimo debe ser un entero no negativo.`,
    );
  }
  if (!Number.isInteger(group.maxSelections) || group.maxSelections < 1) {
    throw new MoneyError(`"${group.name}": el máximo debe ser al menos 1.`);
  }
  if (group.maxSelections < group.minSelections) {
    throw new MoneyError(
      `"${group.name}": el máximo (${group.maxSelections}) no puede ser menor que el mínimo (${group.minSelections}).`,
    );
  }
  if (!group.allowRepeat && group.maxSelections > group.options.length) {
    throw new MoneyError(
      `"${group.name}": el máximo (${group.maxSelections}) supera el número de opciones disponibles (${group.options.length}) y no se permite repetir.`,
    );
  }
}
