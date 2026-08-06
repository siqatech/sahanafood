import { Pool, type PoolConfig } from 'pg';

/**
 * Fábrica del pool de conexiones. En producción el pooling va en MODO
 * TRANSACCIÓN (pgBouncer o el pool nativo): el tenant se fija con SET LOCAL por
 * transacción (ver rls.ts). Aquí exponemos parámetros seguros por defecto.
 */
export function createPool(
  connectionString: string,
  overrides: PoolConfig = {},
): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Corta consultas colgadas; protege el pool de un tenant ruidoso.
    statement_timeout: 15_000,
    ...overrides,
  });
}
