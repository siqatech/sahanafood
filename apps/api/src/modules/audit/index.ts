/**
 * API pública del módulo Audit (spec 17). Todos los módulos escriben auditoría
 * a través de `recordAudit`, dentro de su propia transacción.
 */
export { AuditModule } from './audit.module.js';
export {
  recordAudit,
  AUDITED_ACTIONS,
  AuditReasonRequiredError,
  type AuditEntry,
  type AuditedAction,
} from './app/audit.service.js';
