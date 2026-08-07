import type { TenantContext } from '../../../database/rls.js';
import * as schema from '../../../database/schema/index.js';

/**
 * Auditoría append-only (spec 17, docs/14#auditoria).
 *
 * `recordAudit` se llama SIEMPRE dentro de la transacción del caso de uso: si
 * la acción se revierte, su registro de auditoría también. No hay acción
 * auditada sin efecto ni efecto auditable sin registro.
 *
 * La inmutabilidad no depende de la disciplina del código: el rol de
 * aplicación no tiene UPDATE ni DELETE sobre `audit_log` (migración 0002), así
 * que un intento de alterar el histórico falla en la base de datos.
 */

/** Acciones auditadas obligatoriamente (docs/14#auditoria). */
export const AUDITED_ACTIONS = [
  'auth.login',
  'auth.refresh_reuse_detected',
  'tenant.created',
  'tenant.updated',
  'tenant.suspended',
  'invoice.voided',
  'invoice.credit_note',
  'price.changed',
  'discount.over_threshold',
  'order.cancelled',
  'order.refunded',
  'order.modified_after_accept',
  'inventory.adjusted',
  'permissions.changed',
  'cash.closed_with_difference',
  'support.cross_tenant_access',
  'data.bulk_export',
] as const;

export type AuditedAction = (typeof AUDITED_ACTIONS)[number] | (string & {});

export interface AuditEntry {
  actorType: 'user' | 'system' | 'support';
  actorId?: string;
  action: AuditedAction;
  resourceType: string;
  resourceId?: string;
  traceId?: string;
  /** Obligatorio en accesos de soporte cross-tenant (docs/09 §7). */
  reason?: string;
  /** Estado antes/después y cualquier contexto relevante. */
  data?: Record<string, unknown>;
}

export class AuditReasonRequiredError extends Error {
  constructor() {
    super('El acceso de soporte requiere un motivo explícito para auditoría.');
    this.name = 'AuditReasonRequiredError';
  }
}

/** Escribe una entrada de auditoría en la transacción en curso. */
export async function recordAudit(
  ctx: TenantContext,
  entry: AuditEntry,
): Promise<void> {
  if (entry.actorType === 'support' && !entry.reason?.trim()) {
    throw new AuditReasonRequiredError();
  }
  await ctx.db.insert(schema.auditLog).values({
    tenantId: ctx.tenantId,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    traceId: entry.traceId ?? null,
    reason: entry.reason ?? null,
    data: entry.data ?? {},
  });
}
