import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  SYSTEM_ROLES,
  WILDCARD,
  grants,
  scopeCovers,
  type Permission,
} from '../domain/permissions.js';

/**
 * Matriz permiso×rol (criterio de aceptación de la spec 02) verificada como
 * lógica pura, sin BD. Las restricciones de docs/03 se codifican como
 * aserciones: si alguien amplía un rol de más, la prueba lo detecta.
 */
describe('Catálogo de permisos', () => {
  it('no tiene permisos duplicados', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('todo permiso de un rol existe en el catálogo', () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) {
        if (p === WILDCARD) continue;
        expect(
          PERMISSIONS.includes(p as Permission),
          `rol ${role.code} declara permiso desconocido: ${p}`,
        ).toBe(true);
      }
    }
  });

  it('los roles del sistema cubren la matriz de actores de docs/03', () => {
    const codes = SYSTEM_ROLES.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'owner',
        'admin',
        'supervisor',
        'cashier',
        'cook',
        'packer',
        'courier',
        'call_center',
        'accountant',
      ]),
    );
  });
});

describe('Restricciones de rol (docs/03)', () => {
  const role = (code: string) => SYSTEM_ROLES.find((r) => r.code === code)!;

  it('propietario y administrador tienen acceso total a su tenant', () => {
    expect(role('owner').permissions).toContain(WILDCARD);
    expect(role('admin').permissions).toContain(WILDCARD);
  });

  it('el cajero no accede a configuración ni a auditoría', () => {
    const p = role('cashier').permissions as readonly string[];
    expect(p).not.toContain(WILDCARD);
    expect(p).not.toContain('tenant.update');
    expect(p).not.toContain('audit.read');
    expect(p).not.toContain('users.write');
  });

  it('el cocinero solo lee pedidos y escribe estados de preparación', () => {
    const p = role('cook').permissions as readonly string[];
    expect(p).toContain('orders.read');
    expect(p).toContain('kitchen.transition');
    expect(p).not.toContain('orders.cancel');
    expect(p).not.toContain('orders.discount');
    expect(p).not.toContain('cash.open');
  });

  it('el contador es de solo lectura (no transacciona)', () => {
    const p = role('accountant').permissions as readonly string[];
    expect(p).toContain('reports.read');
    expect(p).toContain('audit.read');
    expect(p).not.toContain('orders.create');
    expect(p).not.toContain('orders.cancel');
    expect(p).not.toContain('inventory.adjust');
    expect(p).not.toContain('catalog.write');
  });

  it('el repartidor no ve catálogo ni caja', () => {
    const p = role('courier').permissions as readonly string[];
    expect(p).toContain('delivery.read');
    expect(p).not.toContain('cash.read');
    expect(p).not.toContain('catalog.write');
  });

  it('el supervisor puede operar pero no tiene comodín', () => {
    const p = role('supervisor').permissions as readonly string[];
    expect(p).not.toContain(WILDCARD);
    expect(p).toContain('orders.cancel');
    expect(p).toContain('cash.close');
  });
});

describe('grants()', () => {
  it('el comodín concede cualquier permiso', () => {
    expect(grants([WILDCARD], 'orders.cancel')).toBe(true);
  });
  it('concede solo lo declarado', () => {
    expect(grants(['orders.read'], 'orders.read')).toBe(true);
    expect(grants(['orders.read'], 'orders.cancel')).toBe(false);
  });
  it('lista vacía no concede nada', () => {
    expect(grants([], 'orders.read')).toBe(false);
  });
});

describe('scopeCovers() — ámbito (RN-IDN-01)', () => {
  const local = (id: string) => ({
    scopeType: 'location' as const,
    scopeId: id,
  });

  it('el ámbito de tenant cubre cualquier recurso', () => {
    expect(
      scopeCovers({ scopeType: 'tenant', scopeId: null }, local('loc-1')),
    ).toBe(true);
  });

  it('un supervisor del local A NO cubre el local B', () => {
    expect(scopeCovers(local('loc-a'), local('loc-b'))).toBe(false);
    expect(scopeCovers(local('loc-a'), local('loc-a'))).toBe(true);
  });

  it('un ámbito de local no cubre un ámbito de marca del mismo id', () => {
    expect(scopeCovers(local('x'), { scopeType: 'brand', scopeId: 'x' })).toBe(
      false,
    );
  });

  it('sin ámbito requerido basta con tener el permiso', () => {
    expect(scopeCovers(local('loc-a'), undefined)).toBe(true);
  });
});
