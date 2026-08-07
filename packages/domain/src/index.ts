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

export {
  BOUNDARY_EPSILON,
  boundingBox,
  inBoundingBox,
  isOnBoundary,
  isPointInPolygon,
  selectCoverageZone,
  GeoError,
  type Position,
  type Ring,
  type BoundingBox,
  type CoverageZone,
} from './geo/geo.js';

export {
  isOpenAt,
  crossesMidnight,
  toMinutes,
  toLocalMoment,
  ScheduleError,
  type Schedule,
  type WeeklySlot,
  type TimeRange,
  type ScheduleException,
  type LocalMoment,
  type Weekday,
} from './schedule/schedule.js';
