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

  /**
   * Cadencia de los procesos de fondo. El relay va rápido porque de él depende
   * que la cocina vea el pedido (SLO de docs/06: visible en KDS < 5 s); el
   * barrido de aceptación va cada minuto porque sus plazos son de minutos y
   * consultarlo más a menudo solo gasta conexiones.
   */
  worker: z.object({
    outboxIntervalMs: z.coerce.number().int().positive().default(1_000),
    acceptanceIntervalMs: z.coerce.number().int().positive().default(60_000),
    // La cola de facturación va cada 30 s: un compromiso entre no machacar al
    // OSE y no gastar un plazo que SUNAT cuenta en horas (RN-BIL-03).
    billingIntervalMs: z.coerce.number().int().positive().default(30_000),
    outboxBatchSize: z.coerce.number().int().positive().max(1_000).default(100),
    /**
     * Ingesta de marketplace. Va al ritmo del relay y no al de la facturación:
     * lo que espera al otro lado es una cocina, y el SLO de docs/06 pide el
     * pedido en el KDS en menos de 5 s desde que el canal lo manda.
     */
    ingestionIntervalMs: z.coerce.number().int().positive().default(1_000),
    ingestionBatchSize: z.coerce
      .number()
      .int()
      .positive()
      .max(1_000)
      .default(50),
    /**
     * Devoluciones automáticas. Cada minuto: devolver diez segundos antes no
     * cambia nada para el cliente, y machacar a la pasarela con reintentos sí.
     */
    refundIntervalMs: z.coerce.number().int().positive().default(60_000),
    // Saturación: cada 30 s. Más lento deja la cocina desbordada media hora
    // aceptando pedidos; más rápido no cambia nada, porque una cocina no pasa
    // de holgada a crítica en diez segundos.
    saturationIntervalMs: z.coerce.number().int().positive().default(30_000),
  }),

  /** Colector OTLP. Sin él no se arranca el tracing (ver observability/tracing). */
  otelEndpoint: z.string().url().optional(),

  /**
   * Clave maestra de la que se derivan (HKDF) las claves por tenant que cifran
   * las credenciales de conector (RN-INT-04). 32 caracteres es el mínimo que
   * exige el cifrador; rotarla obliga a recifrar las credenciales existentes.
   */
  credentialsMasterKey: z.string().min(32),

  jwt: z.object({
    accessSecret: z.string().min(16),
    refreshSecret: z.string().min(16),
    accessTtl: z.coerce.number().int().positive().default(900),
    refreshTtl: z.coerce.number().int().positive().default(1_209_600),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Una variable vacía es una variable NO PUESTA.
 *
 * En un `.env` se declara lo opcional dejándolo en blanco —`OTEL_...=`— y
 * `docker compose` propaga esa cadena vacía tal cual. Zod, con razón, no
 * considera `''` una URL válida: `optional()` permite `undefined`, no vacío. El
 * resultado era que un despliegue que no usa OpenTelemetry **no arrancaba**,
 * con un «Invalid url» sobre algo que ni siquiera es obligatorio. Costó
 * encontrarlo porque el `.env` se veía correcto.
 */
function sinVacios(valor: string | undefined): string | undefined {
  const limpio = valor?.trim();
  return limpio ? limpio : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse({
    nodeEnv: env.NODE_ENV,
    // `PORT` como respaldo de `API_PORT`: es la convención que usan Railway,
    // Render, Fly y Heroku para decirle al proceso en qué puerto tiene que
    // escuchar, y el balanceador sondea ESE puerto. Sin esto la aplicación
    // arranca perfectamente en 3000, la sonda no encuentra a nadie y el
    // despliegue se marca fallido con la aplicación funcionando — que es
    // exactamente lo que pasó en el primer despliegue a Railway.
    //
    // `API_PORT` manda cuando está: es el explícito, el que fija el compose.
    apiPort: env.API_PORT ?? env.PORT,
    logLevel: sinVacios(env.LOG_LEVEL),
    databaseUrl: env.DATABASE_URL,
    migrationDatabaseUrl: sinVacios(env.MIGRATION_DATABASE_URL),
    redisUrl: sinVacios(env.REDIS_URL),
    worker: {
      outboxIntervalMs: env.WORKER_OUTBOX_INTERVAL_MS,
      acceptanceIntervalMs: env.WORKER_ACCEPTANCE_INTERVAL_MS,
      billingIntervalMs: env.WORKER_BILLING_INTERVAL_MS,
      outboxBatchSize: env.WORKER_OUTBOX_BATCH_SIZE,
      ingestionIntervalMs: env.WORKER_INGESTION_INTERVAL_MS,
      ingestionBatchSize: env.WORKER_INGESTION_BATCH_SIZE,
      refundIntervalMs: env.WORKER_REFUND_INTERVAL_MS,
      saturationIntervalMs: env.WORKER_SATURATION_INTERVAL_MS,
    },
    otelEndpoint: sinVacios(env.OTEL_EXPORTER_OTLP_ENDPOINT),
    credentialsMasterKey:
      sinVacios(env.CREDENTIALS_MASTER_KEY) ??
      'dev-only-credentials-master-key-change-me',
    jwt: {
      accessSecret:
        sinVacios(env.JWT_ACCESS_SECRET) ?? 'dev-only-access-secret-change-me',
      refreshSecret:
        sinVacios(env.JWT_REFRESH_SECRET) ??
        'dev-only-refresh-secret-change-me',
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

  // Los valores por defecto están en el repositorio, así que en producción
  // equivalen a no tener secreto: cualquiera con acceso al código firmaría
  // tokens válidos o descifraría las credenciales de conector de todos los
  // tenants. Arrancar así es peor que no arrancar.
  if (parsed.data.nodeEnv === 'production') {
    const porDefecto = Object.entries({
      JWT_ACCESS_SECRET: parsed.data.jwt.accessSecret,
      JWT_REFRESH_SECRET: parsed.data.jwt.refreshSecret,
      CREDENTIALS_MASTER_KEY: parsed.data.credentialsMasterKey,
    })
      .filter(([, valor]) => valor.startsWith('dev-only-'))
      .map(([nombre]) => nombre);

    if (porDefecto.length > 0) {
      throw new Error(
        `Configuración inválida: en producción hay que definir ${porDefecto.join(', ')}; ` +
          'los valores por defecto son públicos (están en el repositorio).',
      );
    }
  }

  return parsed.data;
}

export const CONFIG = Symbol('APP_CONFIG');
