/**
 * Roles del sistema (RN-IDN-01, docs/03, docs/14).
 *
 * El CATÁLOGO de permisos vive en `common/permissions.ts` —es un contrato
 * transversal que todos los módulos nombran—; aquí queda lo que es política de
 * negocio: qué permisos lleva cada rol. La ASIGNACIÓN usuario–rol lleva el
 * ámbito (tenant | company | brand | location | kitchen), de modo que el mismo
 * rol "supervisor" puede aplicar a locales distintos para usuarios distintos.
 */

export { PERMISSIONS, type Permission } from '../../../common/permissions.js';
import type { Permission } from '../../../common/permissions.js';

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
      // Liquida el efectivo del repartidor al cierre de su turno: es la misma
      // persona que cuadra la caja (RN-DLV-02).
      'delivery.settle',
      // Ve la tienda; registrar un dominio decide a qué host se sirve el
      // catálogo de quién y queda en propietario/administrador.
      'storefront.read',
      'inventory.read',
      'inventory.adjust',
      'billing.read',
      'billing.issue',
      'billing.void',
      // Mensajería WhatsApp (F4 avisos, F5 bot)
      'messaging.read',
      // Registrar consentimiento y bajas toca datos personales (RN-T10): se
      // separa de la lectura a propósito.
      'messaging.manage',
      'reports.read',
      // Ve los cobros y puede generar un link de pago; devolver dinero y
      // configurar la pasarela quedan arriba.
      'payments.read',
      'payments.charge',
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
      // Cobra: puede generar el link de pago del pedido que atiende. Devolver
      // dinero NO, igual que anular un comprobante.
      'payments.read',
      'payments.charge',
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
    //
    // `delivery.operate` es lo que le permite marcar recogido, entregado o
    // fallido: sin él el rol existe pero no puede hacer su trabajo, y alguien
    // acabaría dándole permisos de supervisor «mientras tanto». NO lleva
    // `delivery.assign` —no se reparte el trabajo a sí mismo— ni nada de caja.
    permissions: ['delivery.read', 'delivery.operate', 'orders.read'],
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
