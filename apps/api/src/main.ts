import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { startTracing, stopTracing } from './observability/tracing.js';
import { configureApp, NEST_APP_OPTIONS } from './bootstrap.js';
import { PG_POOL } from './database/database.module.js';
import { assertTenantIsolationEnforced } from './database/preflight.js';

/**
 * Punto de entrada de la API. Versionado `/api/v1`, logs estructurados,
 * errores en formato Problem Details. Ver docs/11-api-guidelines.md.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();

  // El tracing se inicia ANTES de construir la app: las instrumentaciones
  // automáticas parchean los módulos al cargarse, y si la app ya está montada
  // llegan tarde.
  startTracing({
    serviceName: 'sahana-api',
    endpoint: config.otelEndpoint,
  });
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    ...NEST_APP_OPTIONS,
  });

  app.useLogger(app.get(Logger));

  // ANTES de escuchar: si el rol de conexión se salta RLS, no arrancamos. Un
  // proceso que sirve con el aislamiento apagado es peor que uno que no sirve,
  // porque el daño no se nota hasta que un cliente ve los pedidos de otro.
  const rol = await assertTenantIsolationEnforced(app.get(PG_POOL));
  app
    .get(Logger)
    .log(`Base de datos: conectado como "${rol.usuario}" (RLS activa).`);

  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.apiPort);
}

process.on('SIGTERM', () => {
  void stopTracing();
});

void bootstrap();
