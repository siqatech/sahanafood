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

export {
  calculateOrderTotals,
  compareTotals,
  PricingError,
  type Discount,
  type OrderLineInput,
  type OrderTotalsInput,
  type LineTotals,
  type OrderTotals,
} from './pricing/totals.js';

export {
  validateAndPriceModifiers,
  assertValidGroupDefinition,
  ModifierError,
  type ModifierGroup,
  type ModifierOption,
  type ModifierSelection,
} from './pricing/modifiers.js';

export {
  resolvePrice,
  isSellableInChannel,
  isPaused,
  isAvailable,
  type ScopedPrice,
  type PriceQuery,
  type ProductPause,
} from './pricing/price-resolution.js';

export {
  ORDER_STATES,
  ORDER_EVENTS,
  orderStateMachine,
  transition as transitionOrder,
  canCancel,
  canModify,
  cancellationHasCost,
  cancellationNeedsElevatedPermission,
  isFinalState,
  allowedEvents,
  type OrderState,
  type OrderEvent,
} from './ordering/order-state.js';

// --- Catálogo versionado (spec 04) ---
export {
  diffCatalogVersions,
  applyCatalogDiff,
  CatalogDiffError,
  type CatalogSnapshot,
  type CatalogSnapshotProduct,
  type CatalogVersionDiff,
  type ChangedProduct,
  type FieldChange,
} from './catalog/version-diff.js';

// --- Política de descuentos (RN-T08) ---
export {
  checkDiscountApproval,
  discountAmount,
  DiscountError,
  DEFAULT_DISCOUNT_POLICY,
  type DiscountPolicy,
  type DiscountApprovalCheck,
  type DiscountApprovalResult,
} from './pricing/discount-policy.js';

// --- POS offline (ADR-0008, RN-T07) ---
export {
  SyncQueue,
  backoffFor,
  DEFAULT_SYNC_OPTIONS,
  type SyncItem,
  type SyncItemStatus,
  type SyncQueueOptions,
} from './offline/sync-queue.js';

// --- Inventario: recetas y consumo (spec 08, RN-INV-01/03/05, RN-CAT-04) ---
export {
  Quantity,
  QuantityError,
  sumQuantities,
  QUANTITY_SCALE,
  UNITS,
  type Unit,
} from './inventory/quantity.js';

export {
  explodeRecipe,
  calculateConsumption,
  reverseConsumption,
  assertValidRecipe,
  recipeBook,
  RecipeError,
  MAX_RECIPE_DEPTH,
  type Recipe,
  type RecipeLine,
  type RecipeBook,
  type RecipeComponentKind,
  type ConsumptionEntry,
  type ConsumptionResult,
  type OrderLineForConsumption,
} from './inventory/recipe.js';
