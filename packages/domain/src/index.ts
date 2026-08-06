/**
 * @sahana/domain — API pública.
 *
 * Lógica de dominio compartida entre servidor (apps/api) y cliente offline
 * (apps/pos). Se compila una vez y corre idéntica en ambos lados: es la única
 * defensa estructural contra totales divergentes y, por tanto, contra
 * comprobantes SUNAT incorrectos (ADR-0006).
 */
export {
  Money,
  MoneyError,
  MINOR_SCALE,
  sumMoney,
  type CurrencyCode,
} from './money/money.js';

export {
  extractInclusiveTax,
  addExclusiveTax,
  IGV_PERU_BPS,
  type TaxBreakdown,
} from './money/tax.js';

export {
  StateMachine,
  InvalidTransitionError,
  type StateMachineDefinition,
  type TransitionMap,
} from './state-machine/state-machine.js';
