import type { Pool, PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

/**
 * Núcleo del aislamiento multi-tenant (ADR-0002, docs/09-multi-tenancy.md).
 *
 * TODO acceso a datos de negocio pasa por `withTenant`. El contexto de tenant
 * se fija con `set_config('app.tenant_id', $1, true)` — el tercer argumento
 * `true` lo hace LOCAL a la transacción, así que al terminar la transacción el
 * valor se descarta. Esto es lo que hace seguro el pooling en modo transacción:
 * una conexión reutilizada por otra request no arrastra el tenant anterior.
 *
 * Se usa set_config parametrizado (no `SET LOCAL ... = 'valor'` por
 * interpolación) para no abrir una vía de inyección con el tenant_id.
 *
 * Regla: el tenant_id llega SIEMPRE del token (capa HTTP), nunca del payload.
 */

export type Db = NodePgDatabase<typeof schema>;

/** Contexto de datos disponible dentro de una transacción con tenant fijado. */
export interface TenantContext {
  readonly db: Db;
  readonly client: PoolClient;
  readonly tenantId: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Transacción con ajustes LOCAL fijados, y con el detalle que separa un
 * proceso robusto de uno que se cae solo:
 *
 * Cuando Postgres termina un backend —failover, `pg_terminate_backend`, el
 * contenedor que se reinicia a mitad del despliegue—, el cliente YA PRESTADO
 * emite un evento `error`. Un EventEmitter sin oyentes convierte ese evento en
 * una excepción no capturada, y una excepción no capturada tumba el proceso
 * ENTERO. Es decir: perder una conexión mataría toda la API, no solo la
 * petición en curso. El oyente vacío deja que el fallo llegue por donde debe,
 * como rechazo de la consulta en vuelo, y se retira al liberar el cliente para
 * no acumular oyentes en una conexión reutilizada.
 *
 * Lo descubrió la prueba de caos de ingesta (T4.15).
 */
async function inTransaction<T>(
  pool: Pool,
  settings: ReadonlyArray<readonly [string, string]>,
  work: (ctx: { db: Db; client: PoolClient }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const ignorarErrorDeConexion = (): void => undefined;
  client.on('error', ignorarErrorDeConexion);
  try {
    await client.query('BEGIN');
    for (const [clave, valor] of settings) {
      // Parametrizado y LOCAL a la transacción: al terminar, el valor se
      // descarta y la conexión vuelve limpia al pool.
      await client.query('SELECT set_config($1, $2, true)', [clave, valor]);
    }
    const db = drizzle(client, { schema });
    const result = await work({ db, client });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.off('error', ignorarErrorDeConexion);
    client.release();
  }
}

/**
 * Ejecuta `work` dentro de una transacción con `app.tenant_id` fijado a
 * `tenantId`. La RLS de Postgres restringe cada consulta a ese tenant.
 * Hace COMMIT si `work` resuelve, ROLLBACK si lanza. Siempre libera el cliente.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  work: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    // Defensa en profundidad: un tenant_id malformado nunca debe llegar a SQL.
    throw new TenantContextError(`tenant_id inválido: ${tenantId}`);
  }
  return inTransaction(pool, [['app.tenant_id', tenantId]], ({ db, client }) =>
    work({ db, client, tenantId }),
  );
}

/**
 * Contexto de SISTEMA para el relay de outbox y otros procesos de plataforma
 * que operan cross-tenant. Fija `app.system = 'on'` LOCAL a la transacción.
 *
 * IMPORTANTE: este flag SOLO relaja la RLS de las tablas de plataforma de
 * eventos (outbox, inbox). Las tablas de datos de negocio no lo consultan: su
 * política exige coincidencia estricta de tenant, sin escape de sistema. Por
 * tanto el contexto de sistema jamás expone datos de negocio de otro tenant.
 */
export async function withSystem<T>(
  pool: Pool,
  work: (ctx: { db: Db; client: PoolClient }) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, [['app.system', 'on']], work);
}

/**
 * Contexto de RESOLUCIÓN DE LOGIN. El email de un usuario llega antes de saber
 * a qué tenant pertenece, así que la búsqueda inicial no puede tener contexto
 * de tenant. Fija `app.auth_lookup = 'on'` LOCAL a la transacción, lo que activa
 * una política PERMISIVA de SOLO SELECT sobre `idn_users` (migración 0004).
 *
 * Restricciones deliberadas de este escape:
 *  - Solo lectura: no habilita INSERT/UPDATE/DELETE en ninguna tabla.
 *  - Solo `idn_users`: ninguna otra tabla consulta este flag; el resto del
 *    negocio sigue exigiendo coincidencia estricta de tenant.
 *  - Uso acotado: exclusivamente el paso de resolución de credenciales. Una vez
 *    resuelto el tenant, TODO lo demás pasa por `withTenant`.
 */
export async function withAuthLookup<T>(
  pool: Pool,
  work: (ctx: { db: Db; client: PoolClient }) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, [['app.auth_lookup', 'on']], work);
}

/**
 * Contexto de RESOLUCIÓN DE CONEXIÓN DE INTEGRACIÓN. Mismo problema que el
 * login y misma forma de resolverlo: el webhook de un marketplace llega sin
 * ningún token nuestro, solo con el `webhook_token` opaco de la URL, así que la
 * conexión —y con ella el tenant— hay que resolverla ANTES de tener contexto.
 *
 * Restricciones deliberadas, idénticas a `withAuthLookup` (ADR-0014):
 *  - Solo lectura: la política `integration_lookup` es `FOR SELECT`.
 *  - Solo `int_connections`: ninguna otra tabla consulta este flag.
 *  - Uso acotado: exclusivamente el paso de resolver la conexión. Escribir el
 *    evento entrante ya va por `withTenant` con el tenant recién resuelto.
 *
 * Resolver la conexión NO autoriza nada: la firma HMAC se verifica después, y
 * un token válido con firma inválida se rechaza sin encolar (RN-INT-01).
 */
export async function withIntegrationLookup<T>(
  pool: Pool,
  work: (ctx: { db: Db; client: PoolClient }) => Promise<T>,
): Promise<T> {
  return inTransaction(pool, [['app.integration_lookup', 'on']], work);
}
