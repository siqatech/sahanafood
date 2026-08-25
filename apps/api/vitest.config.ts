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
    /**
     * En CI, además del informe normal, uno en JUnit que se sube como artefacto
     * si el trabajo falla.
     *
     * Va aquí y no en la línea de órdenes por algo comprobado: pasado como
     * `--outputFile.junit=…` a través de `pnpm --filter … test --`, el archivo
     * acababa en la RAÍZ del repositorio en vez de en `apps/api`, así que el
     * paso que lo sube no habría encontrado nada y el artefacto habría salido
     * vacío. En el config la ruta se resuelve respecto a este archivo.
     *
     * El motivo de tenerlo: cuando este trabajo se puso en rojo de forma
     * intermitente, lo único recuperable eran los registros del contenedor de
     * Postgres —llenos de errores ESPERADOS, porque las pruebas de aislamiento
     * comprueban justo que un INSERT ajeno se rechaza— y no había manera de
     * saber QUÉ prueba falló. Un gate que no se puede diagnosticar se acaba
     * reintentando a ciegas, y reintentar a ciegas es como un fallo real pasa
     * por intermitente.
     */
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'integracion.xml' },
  },
});
