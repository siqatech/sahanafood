import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from '../database/pool.js';
import {
  assertTenantIsolationEnforced,
  inspectDatabaseRole,
  UnsafeDatabaseRoleError,
} from '../database/preflight.js';
import { INTEGRATION_DB } from './helpers.js';

/**
 * El arranque tiene que negarse a servir con RLS desactivada.
 *
 * Es la comprobación que protege del modo de fallo más peligroso del sistema y
 * también del más silencioso: conectarse con un rol superusuario o con
 * `BYPASSRLS`. Postgres se salta la Row Level Security entera y **no pasa nada
 * visible** — las consultas responden, las pruebas de negocio pasan, los
 * pedidos entran— salvo que cada cliente ve los datos de todos los demás.
 *
 * Es fácil de provocar sin querer: los Postgres gestionados entregan una sola
 * URL, la del administrador, y pegarla en la variable de la aplicación es el
 * camino corto.
 *
 * Con `SUPERUSER_DATABASE_URL` en el entorno, el caso malo se fabrica **con un
 * rol real** y se comprueba de punta a punta. Sin ella —el caso normal, porque
 * el rol migrador es `NOCREATEROLE` a propósito— se comprueba la decisión con
 * una conexión simulada: lo que se garantiza siempre es que el proceso se niega
 * a arrancar; lo que solo se ejerce con superusuario es que Postgres informa de
 * ese rol como creemos.
 */
const suite = INTEGRATION_DB ? describe : describe.skip;

suite('Arranque: no se sirve sin aislamiento', () => {
  const pool = createPool(INTEGRATION_DB!, { max: 2 });

  beforeAll(() => {
    process.env['JWT_ACCESS_SECRET'] ??= 'test-access-secret-0123456789';
  });

  afterAll(async () => {
    await pool.end();
  });

  it('EL ROL DE LA APLICACIÓN pasa: ni superusuario ni BYPASSRLS', async () => {
    const rol = await assertTenantIsolationEnforced(pool);
    expect(rol.superusuario).toBe(false);
    expect(rol.bypassRls).toBe(false);
  });

  it('Y NO ES DUEÑO de las tablas: un dueño se salta RLS sin FORCE', async () => {
    // Aplicamos `FORCE ROW LEVEL SECURITY` en todas, así que el dueño tampoco
    // se saltaría nada. Pero depender de UNA sola barrera para el aislamiento
    // entre clientes es exactamente lo que no se hace: el esquema pertenece al
    // migrador y el rol de aplicación solo tiene DML.
    const rol = await inspectDatabaseRole(pool);
    expect(rol.tablasPropias).toBe(0);
  });

  it('UN ROL CON BYPASSRLS no arranca, y el mensaje dice qué hacer', async () => {
    // El rol se fabrica con un SUPERUSUARIO si lo hay: crear un rol con
    // `BYPASSRLS` requiere serlo, y el migrador —bien— es `NOCREATEROLE`.
    // Cuando no lo hay, se comprueba la DECISIÓN con una conexión simulada:
    // sigue siendo la garantía que importa —que el proceso se niega a
    // arrancar— aunque la parte de «Postgres se comporta así» no se ejerza.
    const superUrl = process.env['SUPERUSER_DATABASE_URL'];

    if (superUrl) {
      const admin = createPool(superUrl, { max: 2 });
      const clave = `pf-${Date.now()}`;
      try {
        await admin.query(
          `DO $$
           BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_preflight_malo') THEN
               CREATE ROLE sahana_preflight_malo LOGIN BYPASSRLS;
             END IF;
           END $$;`,
        );
        await admin.query(
          `ALTER ROLE sahana_preflight_malo WITH LOGIN BYPASSRLS PASSWORD '${clave}'`,
        );
        const url = new URL(INTEGRATION_DB!);
        url.username = 'sahana_preflight_malo';
        url.password = clave;
        const malo = createPool(url.toString(), { max: 1 });
        try {
          await expect(assertTenantIsolationEnforced(malo)).rejects.toThrow(
            UnsafeDatabaseRoleError,
          );
        } finally {
          await malo.end();
        }
      } finally {
        await admin
          .query('DROP ROLE IF EXISTS sahana_preflight_malo')
          .catch(() => undefined);
        await admin.end();
      }
      return;
    }

    // Conexión simulada: responde lo que respondería Postgres con un rol
    // administrador de un proveedor gestionado.
    const fingido = {
      connect: async () => ({
        query: async (sql: string) =>
          sql.includes('pg_tables')
            ? { rows: [{ n: '0' }] }
            : {
                rows: [
                  { usuario: 'postgres', superusuario: true, bypass_rls: true },
                ],
              },
        release: () => undefined,
      }),
    };

    await expect(
      assertTenantIsolationEnforced(fingido as never),
    ).rejects.toThrow(UnsafeDatabaseRoleError);

    // El mensaje tiene que llevar al siguiente paso: quien lo lee está en medio
    // de un despliegue, no depurando.
    const error = await assertTenantIsolationEnforced(fingido as never).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('superusuario');
    expect(error!.message).toContain('sahana_app');
    expect(error!.message).toMatch(/bootstrap|01-roles/);
  });
});
