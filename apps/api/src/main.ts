import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { startTracing, stopTracing } from './observability/tracing.js';
import { configureApp } from './bootstrap.js';

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
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.apiPort);
}

process.on('SIGTERM', () => {
  void stopTracing();
});

void bootstrap();
