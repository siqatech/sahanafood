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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // LOCAL a la transacción; parametrizado.
    await client.query('SELECT set_config($1, $2, true)', [
      'app.tenant_id',
      tenantId,
    ]);
    const db = drizzle(client, { schema });
    const result = await work({ db, client, tenantId });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.system', 'on']);
    const db = drizzle(client, { schema });
    const result = await work({ db, client });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
