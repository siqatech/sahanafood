import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { NEST_APP_OPTIONS } from '../bootstrap.js';
import { createPool } from '../database/pool.js';
import { withTenant } from '../database/rls.js';
import { syncSystemRoles } from '../database/sync-roles.js';
import { TenancyService } from '../modules/tenancy/index.js';
import { seedPlans } from '../database/seed.js';
import { INTEGRATION_DB, deleteTenants } from './helpers.js';

/**
 * Reconciliación de roles del sistema en tenants que YA existen.
 *
 * `seedSystemRoles` corre una sola vez, al provisionar. Un permiso nuevo del
 * catálogo llega a los clientes futuros y **a ningún cliente actual**: el
 * código empieza a exigirlo el día del despliegue y nadie lo tiene. Lo que se
 * ve entonces en el local no es un error de permisos, es que la caja no cierra.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Sincronización de roles del sistema', () => {
  let app: INestApplication;
  const pool = createPool(INTEGRATION_DB!, { max: 4 });
  const created: string[] = [];
  let tenantId = '';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
    process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication(NEST_APP_OPTIONS);
    await app.init();

    await seedPlans(pool);
    const t = await app.get(TenancyService).provisionTenant({
      name: 'Sync Roles Tenant',
      planCode: 'growth',
      owner: {
        email: 'sync-roles@sahana.test',
        password: 'password-sync-roles',
        fullName: 'Dueña Sync',
      },
    });
    tenantId = t.tenantId;
    created.push(tenantId);
  });

  afterAll(async () => {
    await app?.close();
    await deleteTenants(pool, created);
    await pool.end();
  });

  const permisosDeSupervisor = () =>
    withTenant(pool, tenantId, async ({ client }) => {
      const { rows } = await client.query<{ permission: string }>(
        `SELECT rp.permission
           FROM idn_role_permissions rp
           JOIN idn_roles r ON r.id = rp.role_id
          WHERE r.code = 'supervisor'`,
      );
      return rows.map((r) => r.permission);
    });

  it('DEVUELVE un permiso que el tenant no tenía todavía', async () => {
    // Se simula el estado real de un cliente anterior al despliegue: el rol
    // existe y le falta el permiso que el código nuevo va a exigir.
    await withTenant(pool, tenantId, async ({ client }) => {
      await client.query(
        `DELETE FROM idn_role_permissions rp
          USING idn_roles r
          WHERE rp.role_id = r.id AND r.code = 'supervisor'
            AND rp.permission = 'cash.approve_difference'`,
      );
    });
    expect(await permisosDeSupervisor()).not.toContain(
      'cash.approve_difference',
    );

    const resumen = await syncSystemRoles(pool);
    expect(resumen.tenants).toBeGreaterThanOrEqual(1);

    expect(await permisosDeSupervisor()).toContain('cash.approve_difference');
  });

  it('ES IDEMPOTENTE: repetirla no duplica ni quita nada', async () => {
    const antes = (await permisosDeSupervisor()).sort();
    await syncSystemRoles(pool);
    await syncSystemRoles(pool);
    const despues = (await permisosDeSupervisor()).sort();
    expect(despues).toEqual(antes);
  });

  it('NO QUITA lo que el tenant se dio por su cuenta', async () => {
    // El catálogo define el mínimo de cada rol del sistema, no su techo.
    // Borrar lo que no reconoce convertiría un despliegue rutinario en una
    // retirada silenciosa de accesos.
    await withTenant(pool, tenantId, async ({ client }) => {
      await client.query(
        `INSERT INTO idn_role_permissions (tenant_id, role_id, permission)
         SELECT $1, r.id, 'payments.refund'
           FROM idn_roles r WHERE r.code = 'supervisor'
         ON CONFLICT DO NOTHING`,
        [tenantId],
      );
    });

    await syncSystemRoles(pool);

    expect(await permisosDeSupervisor()).toContain('payments.refund');
  });
});
