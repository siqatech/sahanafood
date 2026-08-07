import { z } from 'zod';

/**
 * Configuración tipada y validada al arranque (convenciones docs/29).
 * Si falta una variable o es inválida, el proceso NO arranca: fallar temprano
 * es preferible a arrancar en un estado indefinido.
 */
const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  apiPort: z.coerce.number().int().positive().default(3000),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Conexión de la app (rol SIN BYPASSRLS) y de migraciones (dueño del esquema).
  databaseUrl: z.string().url(),
  migrationDatabaseUrl: z.string().url().optional(),

  redisUrl: z.string().url().default('redis://localhost:6379'),

  /** Colector OTLP. Sin él no se arranca el tracing (ver observability/tracing). */
  otelEndpoint: z.string().url().optional(),

  jwt: z.object({
    accessSecret: z.string().min(16),
    refreshSecret: z.string().min(16),
    accessTtl: z.coerce.number().int().positive().default(900),
    refreshTtl: z.coerce.number().int().positive().default(1_209_600),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    apiPort: env.API_PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL,
    redisUrl: env.REDIS_URL,
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET ?? 'dev-only-access-secret-change-me',
      refreshSecret:
        env.JWT_REFRESH_SECRET ?? 'dev-only-refresh-secret-change-me',
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtl: env.JWT_REFRESH_TTL,
    },
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  return parsed.data;
}

export const CONFIG = Symbol('APP_CONFIG');
