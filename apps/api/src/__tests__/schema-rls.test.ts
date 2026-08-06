import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { INTEGRATION_DB } from './helpers.js';

/**
 * Gate de la Fase 3 (T3.06): test de esquema. Verifica que TODA tabla de
 * negocio (las que no están en la allowlist de plano de control) tenga
 * `tenant_id` y RLS habilitada + forzada + con al menos una política. Si un
 * módulo futuro crea una tabla sin RLS, este test rompe el build.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

// Tablas de plano de control (no llevan tenant_id por diseño).
const CONTROL_PLANE = new Set(['_migrations', 'ten_plans', 'ten_tenants']);

suite('Esquema — convención de RLS en toda tabla de negocio', () => {
  const pool = new Pool({ connectionString: INTEGRATION_DB!, max: 1 });

  interface TableInfo {
    table: string;
    hasTenantId: boolean;
    rlsEnabled: boolean;
    rlsForced: boolean;
    policyCount: number;
  }
  let tables: TableInfo[] = [];

  beforeAll(async () => {
    const { rows } = await pool.query<TableInfo>(`
      SELECT
        c.relname AS table,
        EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
        ) AS "hasTenantId",
        c.relrowsecurity  AS "rlsEnabled",
        c.relforcerowsecurity AS "rlsForced",
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS "policyCount"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `);
    tables = rows;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('hay tablas creadas por las migraciones', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it('toda tabla de negocio tiene columna tenant_id', () => {
    const offenders = tables
      .filter((t) => !CONTROL_PLANE.has(t.table))
      .filter((t) => !t.hasTenantId)
      .map((t) => t.table);
    expect(offenders, `tablas sin tenant_id: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('toda tabla con tenant_id tiene RLS habilitada, forzada y con política', () => {
    const offenders = tables
      .filter((t) => t.hasTenantId)
      .filter((t) => !t.rlsEnabled || !t.rlsForced || t.policyCount === 0)
      .map(
        (t) =>
          `${t.table} (enabled=${t.rlsEnabled}, forced=${t.rlsForced}, policies=${t.policyCount})`,
      );
    expect(
      offenders,
      `tablas con RLS incompleta: ${offenders.join('; ')}`,
    ).toEqual([]);
  });
});
