import type { Pool } from 'pg';
import { createPool } from './pool.js';
import { withTenant } from './rls.js';
import { seedPlans } from './seed.js';
import * as schema from './schema/index.js';

/**
 * Onboarding de un tenant demo (T3.17, RN-TEN-01). Provisiona: plan, tenant con
 * defaults Perú (PEN, IGV 18%, America/Lima), feature flags por defecto y una
 * entrada de auditoría de alta. Criterio de salida F3: debe completarse en
 * menos de 60 s. Imprime el tiempo medido.
 */
export async function provisionDemoTenant(pool: Pool): Promise<{
  tenantId: string;
  elapsedMs: number;
}> {
  const start = process.hrtime.bigint();

  await seedPlans(pool);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ten_tenants (name, plan_id, country, currency, timezone, settings)
     SELECT $1, p.id, 'PE', 'PEN', 'America/Lima', $2::jsonb
       FROM ten_plans p WHERE p.code = $3
     RETURNING id`,
    [
      'Demo — Cocina Sahana',
      JSON.stringify({ igvBps: 1800, locale: 'es-PE' }),
      'growth',
    ],
  );
  const tenantId = rows[0]!.id;

  // Datos de negocio del tenant: dentro de su contexto RLS.
  await withTenant(pool, tenantId, async (ctx) => {
    const defaults: Array<{ flag: string; enabled: boolean }> = [
      { flag: 'storefront', enabled: true },
      { flag: 'whatsapp', enabled: true },
      { flag: 'ai_agent', enabled: true },
      { flag: 'inventory', enabled: false },
    ];
    await ctx.db
      .insert(schema.featureFlags)
      .values(
        defaults.map((d) => ({ tenantId, flag: d.flag, enabled: d.enabled })),
      );

    await ctx.db.insert(schema.auditLog).values({
      tenantId,
      actorType: 'system',
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenantId,
      data: { source: 'demo-tenant script' },
    });
  });

  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { tenantId, elapsedMs };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL.');
    process.exit(1);
  }
  const pool = createPool(url, { max: 2 });
  provisionDemoTenant(pool)
    .then(async ({ tenantId, elapsedMs }) => {
      console.error(
        `Tenant demo ${tenantId} provisionado en ${elapsedMs.toFixed(0)} ms ` +
          `(${elapsedMs < 60_000 ? 'OK < 60 s' : 'FUERA DE OBJETIVO'}).`,
      );
      await pool.end();
      process.exit(elapsedMs < 60_000 ? 0 : 1);
    })
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
