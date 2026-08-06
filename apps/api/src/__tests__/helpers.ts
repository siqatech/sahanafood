import type { Pool } from 'pg';
import { seedPlans } from '../database/seed.js';

/** ¿Hay una BD de integración disponible? Los tests se saltan si no. */
export const INTEGRATION_DB = process.env.DATABASE_URL;

/** Crea un tenant de prueba y devuelve su id. */
export async function createTestTenant(
  pool: Pool,
  name: string,
  planCode = 'growth',
): Promise<string> {
  await seedPlans(pool);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ten_tenants (name, plan_id)
     SELECT $1, p.id FROM ten_plans p WHERE p.code = $2
     RETURNING id`,
    [name, planCode],
  );
  return rows[0]!.id;
}

/** Borra tenants de prueba (CASCADE limpia flags/audit/outbox/inbox). */
export async function deleteTenants(pool: Pool, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query('DELETE FROM ten_tenants WHERE id = ANY($1::uuid[])', [ids]);
}
