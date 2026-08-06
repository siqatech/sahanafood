import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPool } from '../database/pool.js';
import { withTenant, TenantContextError } from '../database/rls.js';
import * as schema from '../database/schema/index.js';
import { INTEGRATION_DB, createTestTenant, deleteTenants } from './helpers.js';

/**
 * Gate de la Fase 3: prueba de fuga de aislamiento con pooling agresivo.
 *
 * Un pool de UNA sola conexión (max=1) fuerza que la MISMA conexión física se
 * reutilice en 1000 transacciones alternando tenants. Si `SET LOCAL
 * app.tenant_id` no fuera realmente local a la transacción, un tenant vería
 * datos del otro. La prueba lo verifica exhaustivamente.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('RLS — aislamiento de tenant con pooling agresivo', () => {
  const pool = createPool(INTEGRATION_DB!, { max: 1 });
  let tenantA = '';
  let tenantB = '';

  beforeAll(async () => {
    tenantA = await createTestTenant(pool, 'RLS-A');
    tenantB = await createTestTenant(pool, 'RLS-B');
    await withTenant(pool, tenantA, async (ctx) => {
      await ctx.db
        .insert(schema.featureFlags)
        .values({ tenantId: tenantA, flag: 'a-only', enabled: true });
    });
    await withTenant(pool, tenantB, async (ctx) => {
      await ctx.db
        .insert(schema.featureFlags)
        .values({ tenantId: tenantB, flag: 'b-only', enabled: true });
    });
  });

  afterAll(async () => {
    await deleteTenants(pool, [tenantA, tenantB]);
    await pool.end();
  });

  it('1000 transacciones alternadas sobre la misma conexión no filtran datos', async () => {
    for (let i = 0; i < 1000; i++) {
      const isA = i % 2 === 0;
      const tenant = isA ? tenantA : tenantB;
      const ownFlag = isA ? 'a-only' : 'b-only';
      const foreignFlag = isA ? 'b-only' : 'a-only';

      const rows = await withTenant(pool, tenant, async (ctx) => {
        return ctx.db.select().from(schema.featureFlags);
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.flag).toBe(ownFlag);
      expect(rows.some((r) => r.flag === foreignFlag)).toBe(false);
      expect(rows.every((r) => r.tenantId === tenant)).toBe(true);
    }
  });

  it('WITH CHECK impide insertar filas de OTRO tenant', async () => {
    await expect(
      withTenant(pool, tenantA, async (ctx) => {
        // Intentar escribir una fila marcada como del tenant B desde el
        // contexto de A: la política WITH CHECK debe rechazarlo.
        await ctx.db
          .insert(schema.featureFlags)
          .values({ tenantId: tenantB, flag: 'forged', enabled: true });
      }),
    ).rejects.toThrow();
  });

  it('una consulta cruzada explícita devuelve vacío', async () => {
    const count = await withTenant(pool, tenantA, async (ctx) => {
      const r = await ctx.db.execute(
        sql`SELECT count(*)::int AS c FROM ten_feature_flags WHERE flag = 'b-only'`,
      );
      return (r.rows[0] as { c: number }).c;
    });
    expect(count).toBe(0);
  });

  it('rechaza tenant_id malformado antes de tocar SQL', async () => {
    await expect(
      withTenant(pool, 'no-es-uuid', async () => undefined),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});
