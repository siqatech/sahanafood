import { Pool } from 'pg';

/**
 * Semilla del plano de control: planes base del SaaS. Idempotente (ON CONFLICT).
 * Los límites y features salen de spec 01 (tenancy) y son ajustables (DP-05).
 */
export async function seedPlans(pool: Pool): Promise<void> {
  const plans = [
    {
      code: 'starter',
      name: 'Starter',
      limits: { brands: 1, locations: 1, users: 5 },
      features: { ai_agent: false, storefront: true, whatsapp: false },
    },
    {
      code: 'growth',
      name: 'Growth',
      limits: { brands: 3, locations: 5, users: 25 },
      features: { ai_agent: true, storefront: true, whatsapp: true },
    },
    {
      code: 'scale',
      name: 'Scale',
      limits: { brands: 20, locations: 50, users: 200 },
      features: { ai_agent: true, storefront: true, whatsapp: true },
    },
  ];

  for (const p of plans) {
    await pool.query(
      `INSERT INTO ten_plans (code, name, limits, features)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, limits = EXCLUDED.limits, features = EXCLUDED.features`,
      [p.code, p.name, JSON.stringify(p.limits), JSON.stringify(p.features)],
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  seedPlans(pool)
    .then(() => {
      console.error('Planes sembrados.');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
