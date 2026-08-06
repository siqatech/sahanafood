import { defineConfig } from 'vitest/config';

/**
 * Config de pruebas de la API. Incluye unitarias e integración; las de
 * integración se auto-saltan (`describe.skip`) si no hay DATABASE_URL, así el
 * `pnpm test` local sin BD no falla. En CI se levanta Postgres y corren todas.
 */
export default defineConfig({
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
