/**
 * Catálogo de permisos y roles del sistema (RN-IDN-01, docs/03, docs/14).
 *
 * Un permiso es `modulo.accion`. La ASIGNACIÓN usuario–rol lleva el ámbito
 * (tenant | company | brand | location | kitchen), de modo que el mismo rol
 * "supervisor" puede aplicar a locales distintos para usuarios distintos.
 *
 * Este catálogo es la fuente de verdad: los guards validan contra él y los
 * roles del sistema se siembran a partir de aquí al provisionar un tenant.
 */

export const PERMISSIONS = [
  // Tenancy y configuración
  'tenant.read',
  'tenant.update',
  'tenant.billing',
  // Identidad
  'users.read',
  'users.write',
  'roles.read',
  'roles.write',
  // Auditoría
  'audit.read',
  // Catálogo (F4)
  'catalog.read',
  'catalog.write',
  // Pedidos (F4)
  'orders.read',
  'orders.create',
  'orders.transition',
  'orders.cancel',
  // Cancelar un pedido YA en preparación: hay costo de insumos (RN-ORD-06).
  'orders.cancel_in_progress',
  'orders.modify',
  // Vaciar la bandeja de excepciones cambia el importe que se cobrará: no es
  // una lectura, es una decisión de negocio (RN-ORD-10).
  'orders.review_exceptions',
  'orders.discount',
  // Caja (F4)
  'cash.open',
  'cash.close',
  'cash.read',
  // Cocina (F4)
  'kitchen.read',
  'kitchen.transition',
  // Entregas (F4-5)
  'delivery.read',
  'delivery.assign',
  // Inventario (F4/F6)
  'inventory.read',
  'inventory.adjust',
  // Facturación electrónica (F4)
  'billing.read',
  // Emitir y reenviar un comprobante: lo hace el cajero al cobrar.
  'billing.issue',
  // Anular con nota de crédito NO es emitir. Un comprobante ya declarado se
  // revierte, y quien lo revierte responde ante SUNAT: se separa a propósito.
  'billing.void',
  // Reportes
  'reports.read',
  'reports.export',
  // Integraciones (F4 con simulador, F7 conectores reales)
  'integrations.read',
  // Crear o pausar una conexión toca credenciales y el flujo de pedidos de un
  // canal entero: se separa de la lectura a propósito.
  'integrations.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Comodín: acceso total dentro del tenant. Solo para propietario/administrador. */
export const WILDCARD = '*';

/** Ámbitos de asignación (RN-IDN-01). */
export const SCOPE_TYPES = [
  'tenant',
  'company',
  'brand',
  'location',
  'kitchen',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface SystemRole {
  code: string;
  name: string;
  permissions: readonly (Permission | typeof WILDCARD)[];
}

/**
 * Roles del sistema derivados de la matriz de actores (docs/03).
 * Se crean en cada tenant al provisionarlo; el tenant puede añadir los suyos.
 */
export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    code: 'owner',
    name: 'Propietario',
    permissions: [WILDCARD], // acceso total a su tenant
  },
  {
    code: 'admin',
    name: 'Administrador',
    permissions: [WILDCARD],
  },
  {
    code: 'supervisor',
    name: 'Supervisor',
    permissions: [
      'tenant.read',
      'users.read',
      'catalog.read',
      'catalog.write',
      'orders.read',
      'orders.create',
      'orders.transition',
      'orders.cancel',
      'orders.cancel_in_progress',
      'orders.modify',
      'orders.review_exceptions',
      'orders.discount',
      'cash.open',
      'cash.close',
      'cash.read',
      'kitchen.read',
      'kitchen.transition',
      'delivery.read',
      'delivery.assign',
      'inventory.read',
      'inventory.adjust',
      'billing.read',
      'billing.issue',
      'billing.void',
      'reports.read',
      // Ve la salud de los canales y la bandeja de excepciones, pero no toca
      // credenciales: gestionar conexiones queda en propietario/administrador.
      'integrations.read',
    ],
  },
  {
    code: 'cashier',
    name: 'Cajero',
    permissions: [
      'catalog.read',
      'orders.read',
      'orders.create',
      'orders.transition',
      'orders.modify',
      'cash.open',
      'cash.close',
      'cash.read',
      // Emite el comprobante al cobrar. Anular NO: una nota de crédito la
      // autoriza un supervisor, igual que un descuento sobre el umbral.
      'billing.read',
      'billing.issue',
    ],
  },
  {
    code: 'cook',
    name: 'Cocinero',
    // Solo lectura de pedidos + escritura de estados de preparación (docs/03).
    permissions: ['orders.read', 'kitchen.read', 'kitchen.transition'],
  },
  {
    code: 'packer',
    name: 'Empacador',
    permissions: ['orders.read', 'kitchen.read', 'kitchen.transition'],
  },
  {
    code: 'courier',
    name: 'Repartidor',
    // El filtro "solo sus envíos" es una condición de datos del módulo Delivery (F5).
    permissions: ['delivery.read', 'orders.read'],
  },
  {
    code: 'call_center',
    name: 'Operador call center',
    permissions: ['catalog.read', 'orders.read', 'orders.create'],
  },
  {
    code: 'accountant',
    name: 'Contador',
    // Solo lectura (docs/03).
    permissions: [
      'orders.read',
      'cash.read',
      'billing.read',
      'reports.read',
      'reports.export',
      'audit.read',
    ],
  },
] as const;

/** ¿La lista de permisos concedidos cubre el permiso requerido? */
export function grants(
  granted: readonly string[],
  required: Permission,
): boolean {
  return granted.includes(WILDCARD) || granted.includes(required);
}

/**
 * ¿El ámbito concedido cubre el ámbito requerido?
 * `tenant` (scopeId nulo) cubre todo. Un ámbito concreto solo cubre su propio
 * recurso. Sin ámbito requerido, basta con tener el permiso.
 */
export function scopeCovers(
  grantedScope: { scopeType: ScopeType; scopeId: string | null },
  required: { scopeType: ScopeType; scopeId: string } | undefined,
): boolean {
  if (grantedScope.scopeType === 'tenant' && grantedScope.scopeId === null) {
    return true;
  }
  if (!required) {
    return true;
  }
  return (
    grantedScope.scopeType === required.scopeType &&
    grantedScope.scopeId === required.scopeId
  );
}
