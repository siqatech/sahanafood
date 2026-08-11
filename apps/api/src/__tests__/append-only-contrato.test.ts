import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TABLAS_APPEND_ONLY } from '../database/append-only.js';

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
