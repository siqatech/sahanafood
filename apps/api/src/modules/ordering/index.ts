/**
 * API pública del módulo Ordering (spec 05, canónica).
 *
 * RN-ORD-01: cualquier módulo que necesite crear un pedido usa
 * `OrderingService.submit()`. Ninguno escribe en `ord_*` directamente
 * (dependency-cruiser lo verifica).
 */
export { OrderingModule } from './ordering.module.js';
export {
  OrderingService,
  OrderInvalidTransitionError,
  OrderOutOfCoverageError,
  OrderProductUnavailableError,
  OrderBelowMinimumError,
  OrderBrandNotServedError,
  ChannelPausedError,
  OrderVersionConflictError,
  OrderNotModifiableError,
  DiscountRequiresApprovalError,
  IdempotencyPayloadMismatchError,
  SCHEDULED_RELEASE_MARGIN_MINUTES,
  type SubmitOrderInput,
  type SubmitLineInput,
  type OrderSummary,
  type OfflineOrderInput,
  type OfflineOrderLine,
  type OfflineSubmitResult,
} from './app/ordering.service.js';
export {
  AcceptanceService,
  AUTO_REJECT_REASON,
  type SweepResult,
} from './app/acceptance.service.js';
export {
  DEFAULT_ACCEPTANCE_POLICY,
  resolveAcceptancePolicy,
  type AcceptancePolicy,
} from './app/acceptance-policy.js';
