import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

/**
 * La configuración se valida al arrancar y el proceso NO arranca si algo falta.
 * Estas pruebas cubren el borde que hizo fallar el primer despliegue con
 * imágenes: una variable OPCIONAL dejada en blanco.
 */
const base = {
  DATABASE_URL: 'postgres://app:secreto@postgres:5432/sahana',
  CREDENTIALS_MASTER_KEY: 'una-clave-maestra-de-treinta-y-dos-o-mas',
  JWT_ACCESS_SECRET: 'acceso-0123456789',
  JWT_REFRESH_SECRET: 'refresco-0123456789',
};

describe('Configuración de arranque', () => {
  it('UNA VARIABLE OPCIONAL VACÍA ES UNA VARIABLE NO PUESTA', () => {
    // Es como se declara «no lo uso» en un `.env`, y `docker compose` propaga
    // la cadena vacía tal cual. Antes, esto tumbaba el arranque con «Invalid
    // url» sobre algo que ni siquiera es obligatorio.
    const config = loadConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      MIGRATION_DATABASE_URL: '   ',
    } as NodeJS.ProcessEnv);

    expect(config.otelEndpoint).toBeUndefined();
    expect(config.migrationDatabaseUrl).toBeUndefined();
  });

  it('una variable opcional con valor SÍ se respeta', () => {
    const config = loadConfig({
      ...base,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://colector:4318',
    } as NodeJS.ProcessEnv);
    expect(config.otelEndpoint).toBe('http://colector:4318');
  });

  it('lo OBLIGATORIO vacío sigue fallando', () => {
    // El vacío se perdona en lo opcional, no en lo que decide si el sistema
    // puede conectarse a su base.
    expect(() =>
      loadConfig({ ...base, DATABASE_URL: '' } as NodeJS.ProcessEnv),
    ).toThrow(/Configuración inválida/);
  });

  it('en PRODUCCIÓN no arranca con los secretos de ejemplo', () => {
    // Están en el repositorio: cualquiera que lo haya leído firmaría tokens
    // válidos. Arrancar así es peor que no arrancar.
    expect(() =>
      loadConfig({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).toThrow(/los valores por defecto son públicos/);
  });

  it('en producción CON secretos propios sí arranca', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(config.nodeEnv).toBe('production');
  });
});
