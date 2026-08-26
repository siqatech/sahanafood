// `vitest/config` y no `vite`: es el mismo `defineConfig` con el bloque `test`
// tipado. Importado desde `vite`, la configuración de pruebas no compila.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Compilación de la PWA del POS/KDS (ADR-0019).
 *
 * Dos cosas van aquí a propósito:
 *
 *  · **El service worker se compila aparte y con nombre fijo.** Un service
 *    worker con hash en el nombre no se puede registrar: el navegador pide
 *    siempre la misma URL. Va como segunda entrada, sin hash.
 *  · **Sin `base` relativa.** La aplicación se sirve desde la raíz de su
 *    dominio; un service worker solo controla su propio directorio hacia
 *    abajo, así que ponerlo en un subdirectorio dejaría fuera de la caché a
 *    la propia aplicación.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: 'index.html',
        sw: 'src/sw.ts',
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: { port: 3002 },
  preview: { port: 3002 },
  /**
   * Pruebas (ADR-0021).
   *
   * El entorno por defecto sigue siendo **node**, no jsdom, y es a propósito:
   * las pruebas de `src/lib` —la cola offline contra `fake-indexeddb`, el
   * cálculo del ticket, el arqueo— no tocan el DOM, y montarles un navegador
   * simulado solo las haría más lentas y les daría globales que no deberían
   * usar. Las pruebas de componente piden jsdom en su propia cabecera:
   *
   *     // @vitest-environment jsdom
   *
   * Así el coste del DOM lo paga el archivo que lo necesita.
   */
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
