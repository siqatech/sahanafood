import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Config de pruebas de la API.
 *
 * IMPORTANTE — por qué SWC y no el esbuild por defecto de Vitest:
 * NestJS resuelve dependencias por el metadato `design:paramtypes` que emite
 * `emitDecoratorMetadata`. esbuild NO emite ese metadato, así que los
 * controladores acabarían con sus servicios en `undefined` y toda petición
 * fallaría con 500 — un fallo que NO existe en producción (tsc sí lo emite).
 * SWC sí lo emite, de modo que el comportamiento en pruebas coincide con el
 * compilado.
 *
 * Las pruebas de integración se auto-saltan si no hay DATABASE_URL, para que
 * `pnpm test` local sin BD no falle. En CI se levanta Postgres y corren todas.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // Integración contra Postgres real: sin paralelismo entre archivos para
    // evitar interferencia de datos entre suites.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
