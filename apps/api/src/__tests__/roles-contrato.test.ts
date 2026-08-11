import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROLES_QUE_CREA } from '../database/bootstrap-roles.js';

/**
 * El arranque tiene que crear TODOS los roles que nombran las migraciones.
 *
 * Esta prueba nace de un fallo real en el primer despliegue a Railway. Las
 * migraciones referencian tres roles (`sahana_app`, `sahana_migrator` y
 * `sahana_support`) y el arranque solo creaba dos, así que la cadena se paró en
 * la migración 0002 con «role "sahana_support" does not exist» — con la 0001 ya
 * aplicada, es decir, con la base a medio migrar.
 *
 * Lo que lo hizo difícil de ver es que el ensayo local **sí pasaba**: en
 * Postgres los roles pertenecen al clúster, no a la base, y el clúster de
 * desarrollo ya tenía `sahana_support` creado por `infra/docker/init/01-roles.sh`.
 * La base era nueva; el rol, no. Un ensayo contra un clúster con historia no
 * prueba lo que promete, y por eso esto se comprueba leyendo los archivos y no
 * conectándose a ninguna parte.
 */

const MIGRACIONES = join(process.cwd(), '..', '..', 'infra', 'migrations');

describe('Contrato de roles', () => {
  it('EL ARRANQUE crea todos los roles que nombran las migraciones', async () => {
    const archivos = (await readdir(MIGRACIONES)).filter((f) =>
      f.endsWith('.sql'),
    );

    const nombrados = new Map<string, string>();
    for (const archivo of archivos) {
      const sql = await readFile(join(MIGRACIONES, archivo), 'utf8');
      for (const m of sql.matchAll(/\bsahana_[a-z_]+\b/g)) {
        if (!nombrados.has(m[0])) nombrados.set(m[0], archivo);
      }
    }

    // Que el barrido encuentre algo: un patrón roto haría pasar la prueba
    // comparando dos listas vacías.
    expect(nombrados.size).toBeGreaterThan(1);

    const faltan = [...nombrados].filter(
      ([rol]) => !(ROLES_QUE_CREA as readonly string[]).includes(rol),
    );
    expect(
      faltan.map(([rol, archivo]) => `${rol} (lo nombra ${archivo})`),
    ).toEqual([]);
  });

  it('Y NO SOBRA ninguno: un rol que nadie usa es superficie de más', async () => {
    const archivos = (await readdir(MIGRACIONES)).filter((f) =>
      f.endsWith('.sql'),
    );
    const nombrados = new Set<string>();
    for (const archivo of archivos) {
      const sql = await readFile(join(MIGRACIONES, archivo), 'utf8');
      for (const m of sql.matchAll(/\bsahana_[a-z_]+\b/g)) nombrados.add(m[0]);
    }
    expect([...ROLES_QUE_CREA].filter((r) => !nombrados.has(r))).toEqual([]);
  });
});
