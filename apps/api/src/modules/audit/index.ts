/**
 * API pública del módulo Audit (spec 17). Todos los módulos escriben auditoría
 * a través de `recordAudit`, dentro de su propia transacción.
 */
export { AuditModule } from './audit.module.js';
export {
  AuditQueryService,
  type EntradaDeAuditoria,
  type FiltrosDeAuditoria,
} from './app/audit-query.service.js';
export {
  recordAudit,
  AUDITED_ACTIONS,
  AUDIT_REQUIREMENTS,
  AUDIT_REQUIREMENTS_PENDING,
  AuditReasonRequiredError,
  type AuditEntry,
  type AuditedAction,
} from './app/audit.service.js';
