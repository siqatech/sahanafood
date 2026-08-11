import type { Pool } from 'pg';

/**
 * Comprobación de arranque: ¿con qué rol nos estamos conectando?
 *
 * Existe por un modo de fallo que **no produce ningún error**: si la aplicación
 * se conecta con un rol superusuario o con `BYPASSRLS`, Postgres se salta la
 * Row Level Security por completo. Todo sigue funcionando —las consultas
 * responden, las pruebas pasan, los pedidos entran— y cada cliente ve los datos
 * de todos los demás. No hay excepción, ni log, ni síntoma: el aislamiento
 * simplemente deja de existir.
 *
 * Es fácil de provocar sin darse cuenta. Los Postgres gestionados (Railway,
 * Supabase, Neon…) entregan una `DATABASE_URL` con el rol administrador, y
 * pegarla tal cual en la variable de la aplicación es el camino corto y
 * evidente. Por eso esta comprobación corre al arrancar y **el proceso no
 * arranca si falla**: fallar ruidosamente al desplegar es incomparablemente
 * mejor que servir dos meses con los datos mezclados.
 *
 * CLAUDE.md dice que la deuda que toca tenancy no es aceptable nunca. Esta es
 * la comprobación que lo sostiene fuera del entorno de desarrollo.
 */

export class UnsafeDatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabaseRoleError';
  }
}

export interface RolDeConexion {
  usuario: string;
  superusuario: boolean;
  bypassRls: boolean;
  /** Tablas de negocio de las que este rol es DUEÑO. */
  tablasPropias: number;
}

export async function inspectDatabaseRole(pool: Pool): Promise<RolDeConexion> {
  const cliente = await pool.connect();
  try {
    const { rows } = await cliente.query<{
      usuario: string;
      superusuario: boolean;
      bypass_rls: boolean;
    }>(
      `SELECT current_user AS usuario,
              rolsuper AS superusuario,
              rolbypassrls AS bypass_rls
         FROM pg_roles WHERE rolname = current_user`,
    );

    const { rows: propias } = await cliente.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = current_user`,
    );

    const fila = rows[0];
    return {
      usuario: fila?.usuario ?? 'desconocido',
      superusuario: fila?.superusuario ?? false,
      bypassRls: fila?.bypass_rls ?? false,
      tablasPropias: Number(propias[0]?.n ?? '0'),
    };
  } finally {
    cliente.release();
  }
}

/**
 * Falla si el rol de conexión puede saltarse RLS.
 *
 * El mensaje dice **qué hacer**, no solo qué pasa: quien lo lee está en medio
 * de un despliegue y necesita el siguiente paso, no un diagnóstico.
 */
export async function assertTenantIsolationEnforced(
  pool: Pool,
): Promise<RolDeConexion> {
  const rol = await inspectDatabaseRole(pool);

  if (rol.superusuario || rol.bypassRls) {
    throw new UnsafeDatabaseRoleError(
      `La aplicación se está conectando como "${rol.usuario}", que ` +
        `${rol.superusuario ? 'es superusuario' : 'tiene BYPASSRLS'}. ` +
        'Postgres IGNORA la Row Level Security con ese rol: cada cliente vería ' +
        'los datos de todos los demás, sin ningún error a la vista.\n\n' +
        'Qué hacer: crea los roles de aplicación con\n' +
        '  ADMIN_DATABASE_URL=<la del proveedor> SAHANA_APP_PASSWORD=… SAHANA_MIGRATOR_PASSWORD=… \\\n' +
        '    pnpm --filter @sahana/api bootstrap:roles\n' +
        '(en Docker lo hace solo `infra/docker/init/01-roles.sh`), y apunta ' +
        'DATABASE_URL al rol `sahana_app` que devuelve. La URL de administrador ' +
        'NO va en ninguna variable de ningún servicio: ni en DATABASE_URL ni en ' +
        'MIGRATION_DATABASE_URL, porque el migrador también es un rol propio. ' +
        'El procedimiento completo está en docs/35-railway.md.',
    );
  }

  return rol;
}
