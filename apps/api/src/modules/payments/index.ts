/**
 * API pública del módulo Payments (spec 10 parte F5, ADR-0016).
 *
 * `PaymentProvider` es lo único que una pasarela nueva necesita implementar
 * para entrar en el sistema sin tocar el servicio ni el dominio. Cuando DP-03
 * se cierre y haya que conectar Culqi o Izipay de verdad, el cambio es una
 * clase nueva y una entrada en la lista del módulo.
 */
export { PaymentsModule } from './payments.module.js';
export {
  PaymentsService,
  WebhookSignatureError,
  PaymentConnectionError,
  WEBHOOK_SECRET_FIELD,
  RefundRequiresApprovalError,
  MAX_REFUND_ATTEMPTS,
  DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR,
  type PaymentIntentView,
  type WebhookOutcome,
} from './app/payments.service.js';
export {
  SettlementsService,
  type SettlementInput,
  type SettlementLineInput,
  type ReconciliationReport,
  type SettlementView,
  type TariffView,
} from './app/settlements.service.js';
export {
  WebhookParseError,
  type PaymentProvider,
  type ChargeRequest,
  type ChargeCreated,
  type WebhookEvent,
  type ProviderPaymentStatus,
  type RefundResult,
} from './domain/payment-provider.js';
export {
  CulqiSandboxProvider,
  CULQI_PROVIDER,
} from './app/providers/culqi-sandbox.provider.js';
export {
  MercadoPagoSandboxProvider,
  MERCADOPAGO_PROVIDER,
} from './app/providers/mercadopago-sandbox.provider.js';
export { PAYMENT_PROVIDERS } from './payments.tokens.js';
