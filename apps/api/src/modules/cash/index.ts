/** API pública del módulo Caja (spec 06). */
export { CashModule } from './cash.module.js';
export {
  CashService,
  NoOpenCashSessionError,
  CashSessionAlreadyOpenError,
  CashSessionClosedError,
  CashDifferenceRequiresApprovalError,
  type CashSessionView,
  type CashSummary,
  type MovementKind,
  type PaymentMethod,
} from './app/cash.service.js';
