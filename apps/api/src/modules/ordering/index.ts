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
  IdempotencyPayloadMismatchError,
  SCHEDULED_RELEASE_MARGIN_MINUTES,
  type SubmitOrderInput,
  type SubmitLineInput,
  type OrderSummary,
} from './app/ordering.service.js';
