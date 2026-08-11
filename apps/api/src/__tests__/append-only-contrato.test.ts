import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TABLAS_APPEND_ONLY } from '../database/append-only.js';
import { pideTls } from '../database/bootstrap-roles.js';

/**
 * La lista de tablas append-only tiene que decir la verdad.
 *
 * `bootstrap-roles.ts` concede DML sobre todas las tablas y después vuelve a
 * revocar `UPDATE`/`DELETE` sobre las de esta lista. Si alguien añade una tabla
 * append-only en una migración y no la añade a la lista, no pasa nada visible:
 * el sistema funciona igual… hasta que se re-ejecuta el arranque en un
 * despliegue y esa tabla queda editable, sin error, sin log y sin síntoma.
 *
 * Por eso la comprobación no es «la lista está bien escrita» sino «la lista
 * coincide con los REVOKE reales del esquema». La fuente de verdad son las
 * migraciones; esto solo impide que las dos se separen.
 */

const MIGRACIONES = join(process.cwd(), '..', '..', 'infra', 'migrations');

async function tablasQueRevocanEscritura(): Promise<Set<string>> {
  const archivos = (await readdir(MIGRACIONES)).filter((f) =>
    f.endsWith('.sql'),
  );
  const encontradas = new Set<string>();

  for (const archivo of archivos) {
    const sql = await readFile(join(MIGRACIONES, archivo), 'utf8');
    // `REVOKE UPDATE, DELETE ON [TABLE] <tabla> FROM sahana_app;`
    const patron =
      /REVOKE\s+UPDATE\s*,\s*DELETE\s+ON\s+(?:TABLE\s+)?([a-z_]+)\s+FROM\s+sahana_app/gi;
    for (const coincidencia of sql.matchAll(patron)) {
      encontradas.add(coincidencia[1]!);
    }
  }
  return encontradas;
}

describe('Contrato append-only', () => {
  it('LA LISTA COINCIDE con lo que revocan las migraciones', async () => {
    const enMigraciones = [...(await tablasQueRevocanEscritura())].sort();

    // Que el barrido encuentre algo: un patrón roto haría pasar la prueba
    // comparando dos listas vacías.
    expect(enMigraciones.length).toBeGreaterThan(5);

    expect([...TABLAS_APPEND_ONLY].sort()).toEqual(enMigraciones);
  });
});

describe('TLS del arranque de roles', () => {
  /**
   * La decisión de TLS la manda la URL, no el nombre del host.
   *
   * Antes se forzaba TLS por «no es localhost», y eso rompe en cuanto la base
   * vive en una red privada: Railway sirve Postgres por `*.railway.internal`
   * sin TLS y el arranque moría con «The server does not support SSL
   * connections» sin llegar a crear ningún rol. Medido en el despliegue.
   */
  it('SOLO pide TLS si lo pide la cadena de conexión', () => {
    expect(
      pideTls('postgres://u:p@postgres.railway.internal:5432/railway'),
    ).toBe(false);
    expect(pideTls('postgres://u:p@localhost:5432/sahana')).toBe(false);
    expect(pideTls('postgres://u:p@host.neon.tech/db?sslmode=require')).toBe(
      true,
    );
    expect(pideTls('postgres://u:p@host/db?sslmode=disable')).toBe(false);
  });
});
