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

/**
 * Lo que docs/14#auditoria obliga a auditar, y CON QUÉ NOMBRE se cumple.
 *
 * Antes esto era una lista suelta de nombres bonitos —`price.changed`,
 * `permissions.changed`, `order.refunded`— que **no coincidía con lo que el
 * código escribe** y que nada comprobaba. Diez de sus diecisiete entradas no
 * las emitía nadie: el módulo de catálogo escribe `catalog.price_set`, el de
 * identidad `identity.role_changed`, el de pagos `payment.refunded`. La lista
 * daba la impresión de ser un contrato y era una nota.
 *
 * Ahora cada requisito apunta a los nombres REALES que lo satisfacen, y
 * `auditoria-contrato.test.ts` falla si alguno deja de tener quien lo escriba.
 * Un requisito de auditoría sin emisor no se nota nunca —nadie echa de menos
 * una línea que no sabe que debería existir— hasta el día que hay que
 * demostrar quién cambió un precio.
 */
export const AUDIT_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  'Acceso al sistema': ['auth.login', 'auth.refresh_reuse_detected'],
  'Alta y suspensión de clientes': ['tenant.created', 'tenant.suspended'],
  'Anulación de comprobante': ['invoice.credit_note'],
  'Corrección de comprobante rechazado': ['billing.customer_corrected'],
  'Cambio de precio': ['catalog.price_set'],
  'Descuento sobre el umbral': ['order.discount_approved'],
  'Cancelación de pedido': ['order.cancelled'],
  'Devolución de dinero': ['payment.refund_requested', 'payment.refunded'],
  'Modificación de un pedido ya aceptado': ['order.modified'],
  'Ajuste de inventario': ['inventory.adjusted'],
  'Cambio de permisos': [
    'identity.role_changed',
    'identity.user_created',
    'identity.user_disabled',
  ],
  'Cierre de caja descuadrado': ['cash.session_closed_with_difference'],
  'Alta y revocación de dispositivos': ['device.paired', 'device.revoked'],
} as const;

/**
 * Requisitos de docs/14 que HOY no tienen emisor, con el motivo.
 *
 * Se declaran aquí en vez de omitirse: una lista que solo contiene lo que ya
 * está hecho no distingue «cumplido» de «olvidado».
 */
export const AUDIT_REQUIREMENTS_PENDING: Readonly<Record<string, string>> = {
  'support.cross_tenant_access':
    'No existe todavía acceso de soporte cross-tenant. `recordAudit` YA lo exige con motivo (ver abajo): el día que se construya, no se podrá escribir sin él.',
  'data.bulk_export':
    'No hay ningún endpoint de exportación masiva. El permiso `reports.export` existe y no lo usa ninguna ruta; cuando la haya, tiene que auditar.',
} as const;

/** Todos los nombres que el contrato de auditoría exige que alguien escriba. */
export const AUDITED_ACTIONS: readonly string[] =
  Object.values(AUDIT_REQUIREMENTS).flat();

export type AuditedAction = string;

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
