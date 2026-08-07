import { VersioningType, type INestApplication } from '@nestjs/common';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';

/**
 * Configuración de la aplicación, en UN SOLO lugar.
 *
 * `main.ts` y las pruebas e2e llaman aquí. Si cada uno montara la app a su
 * manera, las pruebas dejarían de verificar lo que realmente se despliega: un
 * prefijo, un filtro de errores o una exclusión de versionado distintos bastan
 * para que una suite en verde conviva con un 404 en producción.
 *
 * Rutas fuera del prefijo `/api` y del versionado, a propósito:
 *  · `/metrics` — lo raspa Prometheus, que espera la ruta raíz por convención y
 *    no entiende de versiones de nuestra API de negocio.
 */
export const ROUTES_WITHOUT_PREFIX = ['metrics'];

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api', { exclude: ROUTES_WITHOUT_PREFIX });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
}
