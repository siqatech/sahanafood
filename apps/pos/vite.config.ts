import { defineConfig } from 'vite';
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
});
