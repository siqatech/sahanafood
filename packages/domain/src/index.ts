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

// --- Facturación electrónica (spec 10, RN-BIL-01/03, ADR-0003) ---
export {
  resolveDocumentType,
  assertValidIdentity,
  assertValidSeries,
  formatDocumentNumber,
  BillingError,
  type DocumentType,
  type CustomerDocType,
  type CustomerIdentity,
} from './billing/document-type.js';

export {
  checkDeferredIssuance,
  deferredQueueOrder,
  DEFAULT_DEFERRAL_POLICY,
  type DeferralPolicy,
  type DeferredCheck,
  type DeferredStatus,
} from './billing/deferred.js';

// --- Mensajería WhatsApp (spec 12, RN-WA-01/02/04) ---
export {
  isWindowOpen,
  decideSend,
  checkMessageBudget,
  isNotifiable,
  MessagingError,
  SERVICE_WINDOW_HOURS,
  DEFAULT_MESSAGE_BUDGET,
  NOTIFIABLE_ORDER_STATES,
  STATE_TEMPLATES,
  type ContactState,
  type MessageKind,
  type SendDecision,
  type MessageBudget,
  type BudgetStatus,
  type NotifiableOrderState,
} from './messaging/whatsapp-window.js';

// --- Pagos online (spec 10, ADR-0016) ---
export {
  PAYMENT_STATES,
  decidePaymentTransition,
  applyPaymentTransition,
  PaymentTransitionError,
  confirmsOrder,
  isOpen,
  type PaymentState,
  type PaymentDecision,
} from './payments/payment-state.js';

export {
  verifyPaidAmount,
  amountConfirms,
  type AmountVerdict,
} from './payments/amount-check.js';

export {
  estimateCommission,
  compareCommission,
  assertValidTariff,
  CommissionError,
  type CommissionTariff,
  type CommissionVariance,
} from './payments/commission.js';

// --- Tienda web (spec 11, F5) ---
export {
  applyCoupon,
  CouponError,
  type Coupon,
  type CouponKind,
  type CouponResult,
  type CouponRejection,
} from './storefront/coupon.js';

// --- Delivery (spec 09, F5) ---
export {
  SHIPMENT_STATES,
  SHIPMENT_EVENTS,
  SHIPMENT_TERMINAL,
  shipmentStateMachine,
  applyShipmentEvent,
  isShipmentTerminal,
  type ShipmentState,
  type ShipmentEvent,
} from './delivery/shipment-state.js';

export {
  rankCouriers,
  pickCourier,
  AssignmentError,
  type CourierLoad,
  type AssignmentRequest,
  type RankedCourier,
} from './delivery/assignment.js';

// --- Cocina: saturación (spec 07 RN-KIT-04, F5) ---
export {
  evaluateSaturation,
  suggestPauseOrder,
  assertValidPolicy,
  SaturationError,
  type KitchenLoad,
  type SaturationPolicy,
  type SaturationLevel,
  type SaturationDecision,
} from './kitchen/saturation.js';

// --- Bandeja omnicanal (spec 18, F5) ---
export {
  windowCountdown,
  CLOSING_SOON_MINUTES,
  type WindowState,
  type WindowCountdown,
} from './conversations/window-countdown.js';

// --- Agente de IA (spec 19, ADR-0011, F5) ---
export {
  validateOutput,
  extractFacts,
  type FactKind,
  type AssertedFact,
  type ToolEvidence,
  type ValidationVerdict,
  type ValidatorOptions,
} from './ai/output-validator.js';

export {
  matchRule,
  detectNegativeSentiment,
  detectPurchaseIntent,
  type ConditionKind,
  type Condition,
  type ActionKind,
  type Action,
  type DeterministicRule,
  type MessageContext,
  type RuleMatch,
} from './ai/deterministic-actions.js';

export {
  checkAiBudget,
  creditsForTokens,
  WARNING_RATIO,
  type BudgetState,
  type AiBudget,
  type BudgetDecision,
} from './ai/budget.js';

/**
 * Analítica del agente (T5.32). Puras: la consulta reúne los números, el
 * dominio decide. Así el umbral del KPI se discute sin tocar SQL.
 */
export {
  messagesPerOrder,
  conversionBps,
  MESSAGES_PER_ORDER_TARGET,
  type MessagesPerOrderInput,
  type MessagesPerOrderResult,
  type ConversionInput,
} from './ai/agent-kpi.js';
export {
  unansweredTopics,
  type TopicCount,
  type UnansweredTopicsOptions,
} from './ai/unanswered-topics.js';
