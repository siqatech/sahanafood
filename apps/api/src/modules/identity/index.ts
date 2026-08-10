/**
 * API pública del módulo Identity. Única vía de importación permitida desde
 * otros módulos (dependency-cruiser lo verifica).
 */
export { IdentityModule } from './identity.module.js';
export {
  AuthService,
  claimsAllow,
  safeEqual,
  InvalidCredentialsError,
  TenantSuspendedError,
  type AuthTokens,
  type AccessTokenClaims,
} from './app/auth.service.js';
export { RequirePermissionGuard } from './api/require-permission.guard.js';
export {
  DeviceService,
  MAX_PIN_ATTEMPTS,
  PIN_LOCK_MINUTES,
  PAIRING_CODE_TTL_MINUTES,
  PinLockedError,
  InvalidPinError,
  PinMustChangeError,
  type PairedDevice,
} from './app/device.service.js';
export {
  seedSystemRoles,
  createOwnerUser,
} from './app/provisioning.service.js';
export {
  PERMISSIONS,
  SYSTEM_ROLES,
  SCOPE_TYPES,
  WILDCARD,
  grants,
  scopeCovers,
  type Permission,
  type ScopeType,
  type SystemRole,
} from './domain/permissions.js';
export {
  PosSessionService,
  type OperadorDelPos,
  type ContextoDelDispositivo,
} from './app/pos-session.service.js';
export {
  UserAdminService,
  ROLES_ASIGNABLES,
  type UsuarioDelEquipo,
} from './app/user-admin.service.js';
