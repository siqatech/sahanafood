/**
 * API pública del módulo Billing (spec 10).
 */
export { BillingModule } from './billing.module.js';
export { BILLING_PROVIDER } from './billing.tokens.js';
export {
  BillingService,
  SeriesNotConfiguredError,
  DocumentAlreadyIssuedError,
  InvalidCustomerIdentityError,
  type DocumentView,
  type DocumentStatus,
} from './app/billing.service.js';
export {
  OseSandboxProvider,
  OSE_REJECTION_CODES,
  type OseSandboxOptions,
} from './app/ose-sandbox.provider.js';
export type {
  BillingProvider,
  SubmissionDocument,
  SubmissionOutcome,
} from './domain/billing-provider.js';
