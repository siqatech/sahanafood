import { Client } from 'pg';
import { TABLAS_APPEND_ONLY } from './append-only.js';

/**
 * Prepara un Postgres GESTIONADO (Railway, Neon, Supabase…) para Sahana Food.
 *
 * El problema que resuelve es concreto y **silencioso**. Estos proveedores
 * entregan UNA sola `DATABASE_URL`, con el rol administrador. Pegarla en la
 * variable de la aplicación es el camino corto y evidente… y un rol
 * administrador es superusuario o tiene `BYPASSRLS`, así que **Postgres ignora
 * la Row Level Security**: cada cliente vería los datos de todos los demás. Sin
 * error, sin excepción, sin síntoma. Todo «funciona».
 *
 * Este guion crea los dos roles que el sistema espera —el migrador, dueño del
 * esquema, y el de aplicación, sujeto a RLS— y deja escritas las dos URLs que
 * hay que configurar. La comprobación de arranque (`preflight.ts`) rechaza
 * cualquier otra cosa, así que un despliegue mal configurado no llega a servir.
 *
 *   ADMIN_DATABASE_URL=postgres://postgres:...@host:5432/railway \
 *   SAHANA_APP_PASSWORD=... SAHANA_MIGRATOR_PASSWORD=... \
 *     node dist/database/bootstrap-roles.js
 *
 * Es IDEMPOTENTE: se puede repetir en cada despliegue. Si los roles ya existen
 * les actualiza la contraseña y vuelve a aplicar los privilegios — que es justo
 * lo que hace falta al rotar un secreto.
 *
 * CUIDADO en un servidor COMPARTIDO: en Postgres los roles pertenecen al
 * clúster, no a la base. Cambiar la contraseña de `sahana_app` aquí la cambia
 * para TODAS las bases de ese servidor, así que apuntarlo a una base de pruebas
 * deja sin acceso a las demás. En un Postgres gestionado no ocurre —cada
 * instancia es suya— pero en local sí, y no avisa.
 */

export interface ResultadoDeRoles {
  /** Para el servicio de API y el worker. */
  databaseUrl: string;
  /** Solo para el paso de migración. */
  migrationDatabaseUrl: string;
}

/**
 * Extensiones que el esquema da por instaladas.
 *
 * La lista es corta a propósito: cada extensión es una dependencia del
 * proveedor de base de datos, y un proveedor que no la traiga deja de ser una
 * opción. Antes de añadir una, comprobar que existe en Railway, Neon y Supabase.
 */
const EXTENSIONES = [
  {
    nombre: 'vector',
    para: 'la búsqueda por similitud del agente de IA (pgvector, ADR-0011, migración 0028).',
    arreglo:
      'en Railway, usa la plantilla de Postgres que incluye pgvector (la imagen ' +
      '`pgvector/pgvector` o el Postgres de Railway ≥ 16); en Neon y Supabase viene de serie. ' +
      'Es la única extensión que el esquema necesita y no hay alternativa: la tabla ' +
      '`ai_kb_chunks` declara una columna `vector(1536)`.',
  },
] as const;

/** Escapa un valor para un literal SQL. */
function literal(valor: string): string {
  return `'${valor.replaceAll("'", "''")}'`;
}

/** ¿La cadena de conexión pide TLS? `sslmode=disable` y la ausencia dicen que no. */
export function pideTls(url: string): boolean {
  try {
    const modo = new URL(url).searchParams.get('sslmode');
    return modo !== null && modo !== 'disable';
  } catch {
    return false;
  }
}

function conUsuario(url: string, usuario: string, clave: string): string {
  const u = new URL(url);
  u.username = usuario;
  u.password = clave;
  return u.toString();
}

export async function bootstrapRoles(input: {
  adminUrl: string;
  appPassword: string;
  migratorPassword: string;
}): Promise<ResultadoDeRoles> {
  if (input.appPassword.length < 16 || input.migratorPassword.length < 16) {
    throw new Error(
      'SAHANA_APP_PASSWORD y SAHANA_MIGRATOR_PASSWORD necesitan al menos 16 caracteres.\n' +
        'Genera cada una con:  openssl rand -base64 24',
    );
  }
  if (input.appPassword === input.migratorPassword) {
    // Si son la misma, comprometer la de la aplicación entrega también el rol
    // que puede alterar el esquema y quitar las políticas de RLS.
    throw new Error('Las dos contraseñas tienen que ser DISTINTAS.');
  }

  const cliente = new Client({
    connectionString: input.adminUrl,
    // TLS **solo si la propia URL lo pide** (`sslmode=` distinto de `disable`),
    // igual que hace `createPool` para la aplicación. Es importante que las dos
    // decidan igual: si no, el arranque valida una conexión que la API luego no
    // puede abrir, o al revés.
    //
    // Forzarlo por «no es localhost» era lo que había, y se rompe en cuanto la
    // base vive en una red privada: Railway sirve Postgres por
    // `*.railway.internal` sin TLS —la red ya está aislada— y el arranque moría
    // con «The server does not support SSL connections» sin llegar a tocar nada.
    //
    // Cuando sí se pide, se pide SIN verificar la cadena: los proveedores
    // gestionados usan su propia CA y verificarla contra el almacén del sistema
    // falla en casi todos.
    ssl: pideTls(input.adminUrl) ? { rejectUnauthorized: false } : false,
  });
  await cliente.connect();

  try {
    const { rows } = await cliente.query<{
      usuario: string;
      bd: string;
      puede_crear_roles: boolean;
    }>(
      `SELECT current_user AS usuario, current_database() AS bd,
              (rolsuper OR rolcreaterole) AS puede_crear_roles
         FROM pg_roles WHERE rolname = current_user`,
    );
    const admin = rows[0];
    if (!admin?.puede_crear_roles) {
      throw new Error(
        `El rol "${admin?.usuario}" no puede crear roles. ADMIN_DATABASE_URL tiene que ser la de administrador del proveedor.`,
      );
    }

    // `NOSUPERUSER NOBYPASSRLS` explícitos: son la razón de ser de estos roles.
    // Heredarlos por defecto funcionaría hoy y dejaría el aislamiento a merced
    // de que el proveedor cambie sus valores por defecto mañana.
    await cliente.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_migrator') THEN
          CREATE ROLE sahana_migrator LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sahana_app') THEN
          CREATE ROLE sahana_app LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await cliente.query(
      `ALTER ROLE sahana_migrator WITH LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(input.migratorPassword)}`,
    );
    await cliente.query(
      `ALTER ROLE sahana_app WITH LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD ${literal(input.appPassword)}`,
    );

    // Extensiones. `CREATE EXTENSION` exige superusuario y `sahana_migrator`
    // NO lo es a propósito —es lo que impide que una migración se salte RLS—,
    // así que se crean AQUÍ, con el rol administrador, igual que hace
    // `infra/docker/init/02-extensions.sql` en el camino de Docker.
    //
    // Se hace en el arranque y no en la migración 0028 por una razón práctica:
    // si el servidor no trae pgvector, enterarse ahora —en el primer comando
    // del despliegue— es media hora menos que enterarse a mitad de la cadena de
    // migraciones, con veintisiete tablas ya creadas.
    for (const extension of EXTENSIONES) {
      try {
        await cliente.query(
          `CREATE EXTENSION IF NOT EXISTS ${extension.nombre} CASCADE`,
        );
      } catch (error) {
        throw new Error(
          `No se pudo instalar la extensión "${extension.nombre}": ` +
            `${error instanceof Error ? error.message : String(error)}\n\n` +
            `Para qué hace falta: ${extension.para}\n` +
            `Qué hacer: ${extension.arreglo}`,
        );
      }
    }

    // El esquema pertenece al MIGRADOR, no al rol de aplicación. Un dueño de
    // tabla se salta RLS salvo `FORCE ROW LEVEL SECURITY` —que sí aplicamos en
    // todas—, pero depender de una sola barrera para el aislamiento entre
    // clientes es exactamente lo que no se hace.
    await cliente.query('ALTER SCHEMA public OWNER TO sahana_migrator');
    await cliente.query('GRANT USAGE ON SCHEMA public TO sahana_app');
    await cliente.query(
      `GRANT CONNECT ON DATABASE "${admin.bd}" TO sahana_app, sahana_migrator`,
    );

    // Privilegios por defecto: cada tabla que cree el migrador concede DML al
    // rol de aplicación sin que la migración tenga que acordarse.
    await cliente.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE sahana_migrator IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sahana_app;
    `);
    await cliente.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE sahana_migrator IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO sahana_app;
    `);

    // Si ya había tablas —re-ejecución, o una base migrada antes de esto— hay
    // que concederlas ahora: los privilegios por defecto solo alcanzan a lo que
    // se cree DESPUÉS, y sin esto la aplicación arrancaría sin poder leer nada.
    await cliente.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sahana_app',
    );
    await cliente.query(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sahana_app',
    );

    // El GRANT masivo de arriba acaba de conceder UPDATE y DELETE sobre las
    // tablas append-only, que es exactamente lo que sus migraciones revocaron
    // (docs/14, RN-INV-02). Sin deshacerlo, re-ejecutar este arranque —algo
    // pensado para hacerse en cada despliegue— dejaría el histórico de
    // auditoría editable sin que nada lo indicara.
    //
    // Las tablas que aún no existan se ignoran: en una base recién creada el
    // arranque corre ANTES de migrar, y entonces son las propias migraciones
    // las que revocan.
    for (const tabla of TABLAS_APPEND_ONLY) {
      await cliente.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_tables
                      WHERE schemaname = 'public' AND tablename = '${tabla}') THEN
            REVOKE UPDATE, DELETE ON TABLE ${tabla} FROM sahana_app;
          END IF;
        END
        $$;
      `);
    }

    return {
      databaseUrl: conUsuario(input.adminUrl, 'sahana_app', input.appPassword),
      migrationDatabaseUrl: conUsuario(
        input.adminUrl,
        'sahana_migrator',
        input.migratorPassword,
      ),
    };
  } finally {
    await cliente.end();
  }
}

async function main(): Promise<void> {
  const adminUrl =
    process.env['ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
  if (!adminUrl) {
    throw new Error(
      'Falta ADMIN_DATABASE_URL: la URL que da el proveedor, con el rol administrador.',
    );
  }

  const resultado = await bootstrapRoles({
    adminUrl,
    appPassword: process.env['SAHANA_APP_PASSWORD'] ?? '',
    migratorPassword: process.env['SAHANA_MIGRATOR_PASSWORD'] ?? '',
  });

  // A stdout y como JSON: esto se copia a las variables del servicio, así que
  // la salida limpia ES el resultado. Las explicaciones van a stderr.
  process.stdout.write(`${JSON.stringify(resultado, null, 2)}\n`);
  process.stderr.write(
    '\nConfigura DATABASE_URL y MIGRATION_DATABASE_URL con esos valores.\n' +
      'La URL de administrador NO va en ninguna de las dos: con ella Postgres se\n' +
      'salta RLS y el aislamiento entre clientes deja de existir. La API se niega\n' +
      'a arrancar si detecta ese caso.\n',
  );
}

// Solo al invocarse como comando: las pruebas importan `bootstrapRoles`.
if (
  process.argv[1] &&
  (process.argv[1].endsWith('bootstrap-roles.js') ||
    process.argv[1].endsWith('bootstrap-roles.ts'))
) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}
