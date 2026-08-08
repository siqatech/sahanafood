/**
 * Presupuesto de IA por tenant (ADR-0011 §4, T5.30).
 *
 * La regla que importa: **al 100 % el negocio NO se queda sin responder**.
 * Siguen operando las acciones deterministas, que no cuestan nada. Un agente
 * que devuelve un error cuando se acaba el saldo es peor que no tener agente,
 * porque el cliente ya está escribiendo y ya está esperando.
 *
 * Tres estados y no dos: entre «todo bien» y «se acabó» hace falta el aviso,
 * porque el dueño necesita margen para decidir si amplía o deja que degrade.
 * Enterarse al 100 % es enterarse tarde.
 */

export type BudgetState = 'ok' | 'warning' | 'exhausted';

export interface AiBudget {
  /** Créditos del plan para el periodo. */
  limitCredits: number;
  /** Consumidos hasta ahora. */
  usedCredits: number;
}

export interface BudgetDecision {
  state: BudgetState;
  /** Fracción consumida, 0..1+ */
  ratio: number;
  /** ¿Se puede llamar al modelo? */
  allowLlm: boolean;
  /** ¿Siguen funcionando las reglas deterministas? SIEMPRE true. */
  allowDeterministic: true;
  reason: string;
}

/** Umbral de aviso: 80 % (spec 19 §2.7). */
export const WARNING_RATIO = 0.8;

export function checkAiBudget(budget: AiBudget): BudgetDecision {
  // Límite cero o negativo = IA desactivada por plan. No es un error: es un
  // tenant que no la contrató, y tiene que seguir vendiendo igual.
  if (budget.limitCredits <= 0) {
    return {
      state: 'exhausted',
      ratio: 1,
      allowLlm: false,
      allowDeterministic: true,
      reason: 'El plan no incluye créditos de IA: solo acciones deterministas.',
    };
  }

  const ratio = budget.usedCredits / budget.limitCredits;

  if (ratio >= 1) {
    return {
      state: 'exhausted',
      ratio,
      allowLlm: false,
      allowDeterministic: true,
      reason:
        'Presupuesto de IA agotado: el agente sigue respondiendo con las ' +
        'acciones configuradas, sin generación.',
    };
  }

  if (ratio >= WARNING_RATIO) {
    return {
      state: 'warning',
      ratio,
      allowLlm: true,
      allowDeterministic: true,
      reason: `Consumido el ${Math.round(ratio * 100)} % del presupuesto de IA.`,
    };
  }

  return {
    state: 'ok',
    ratio,
    allowLlm: true,
    allowDeterministic: true,
    reason: 'Presupuesto disponible.',
  };
}

/**
 * Coste en créditos de una llamada.
 *
 * Créditos ENTEROS y no dinero: el precio del proveedor cambia y la moneda del
 * plan es otra. Guardar soles aquí obligaría a recalcular el histórico cada vez
 * que un proveedor mueva su tarifa, y el consumo pasado no cambia porque el
 * precio de mañana suba.
 *
 * Se redondea hacia ARRIBA: cobrar de menos por sistema convierte el
 * presupuesto en una sugerencia.
 */
export function creditsForTokens(
  inputTokens: number,
  outputTokens: number,
  rate: { creditsPerKInput: number; creditsPerKOutput: number },
): number {
  const creditos =
    (inputTokens / 1000) * rate.creditsPerKInput +
    (outputTokens / 1000) * rate.creditsPerKOutput;
  return Math.max(1, Math.ceil(creditos));
}
