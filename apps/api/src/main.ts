import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { loadConfig } from './config/config.js';

/**
 * Punto de entrada de la API. Versionado `/api/v1`, logs estructurados,
 * errores en formato Problem Details. Ver docs/11-api-guidelines.md.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  await app.listen(config.apiPort);
}

void bootstrap();
