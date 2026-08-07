import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Contrato de autorización transversal (solo metadatos y tipos).
 *
 * Vive en `common/` y no en el módulo Identity a propósito: TODOS los módulos
 * necesitan declarar el permiso de sus endpoints, pero solo Identity sabe
 * verificarlo. Si el decorador viviera dentro de Identity, cada módulo que lo
 * usara dependería de Identity, e Identity —que escribe auditoría— dependería
 * de Audit: un ciclo. Separando el DECORADOR (aquí, sin dependencias) del
 * GUARD (en Identity, que consume AuthService) el grafo queda acíclico.
 */

export const PERMISSION_KEY = 'sahana:permission';

/** Ámbitos de asignación de permisos (RN-IDN-01). */
export type ScopeType = 'tenant' | 'company' | 'brand' | 'location' | 'kitchen';

export interface ScopeRequirement {
  scopeType: ScopeType;
  /** Nombre del parámetro de ruta que trae el id del recurso. */
  param: string;
}

export interface PermissionRequirement {
  permission: string;
  scope?: ScopeRequirement;
}

/** Claims del access token. El `tid` es la ÚNICA fuente del tenant. */
export interface AccessTokenClaims {
  sub: string;
  tid: string;
  sid: string;
  permissions: string[];
  scopes: Array<{ scopeType: ScopeType; scopeId: string | null }>;
}

/** Request autenticada. Los controladores leen el tenant de aquí, nunca del body. */
export interface AuthenticatedRequest extends Request {
  traceId?: string;
  auth?: AccessTokenClaims;
}

/**
 * Declara el permiso requerido por un endpoint. El guard global de Identity lo
 * verifica en backend (docs/14 §Autorización).
 *
 *   @RequirePermission('orders.cancel')
 *   @RequirePermission('cash.close', { scopeType: 'location', param: 'locationId' })
 */
export function RequirePermission(
  permission: string,
  scope?: ScopeRequirement,
): CustomDecorator<string> {
  return SetMetadata(PERMISSION_KEY, { permission, scope });
}
