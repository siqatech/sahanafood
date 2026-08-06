import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';

/**
 * Migrador simple y determinista. Aplica los .sql de `infra/migrations` en
 * orden alfabético, una vez cada uno, registrando el nombre en `_migrations`.
 * Corre con el rol MIGRADOR (dueño del esquema), no con el rol de app.
 *
 * Las migraciones son la fuente de verdad del DDL y de las políticas RLS; su
 * diff se revisa siempre a mano (regla de CLAUDE.md / PROMPT-INICIAL).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../../../../infra/migrations');

export async function runMigrations(
  connectionString: string,
): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1 });
  const applied: string[] = [];
  try {
    // La tabla de control puede no existir aún en una BD vacía.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const done = new Set(
      (
        await pool.query<{ name: string }>('SELECT name FROM _migrations')
      ).rows.map((r) => r.name),
    );

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [
          file,
        ]);
        await client.query('COMMIT');
        applied.push(file);

        console.error(`✓ migración aplicada: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `Fallo en migración ${file}: ${(err as Error).message}`,
        );
      } finally {
        client.release();
      }
    }
    return applied;
  } finally {
    await pool.end();
  }
}

// Ejecutable directo: `pnpm --filter @sahana/api migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta MIGRATION_DATABASE_URL (o DATABASE_URL).');
    process.exit(1);
  }
  runMigrations(url)
    .then((applied) => {
      console.error(
        applied.length
          ? `Migraciones aplicadas: ${applied.length}`
          : 'Sin migraciones pendientes.',
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
