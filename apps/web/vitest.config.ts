import { defineConfig } from 'vitest/config';

/**
 * Pruebas unitarias de `apps/web`.
 *
 * Son pocas a propósito: casi todo lo que hay aquí son componentes de servidor,
 * y probarlos con un renderizador falso comprobaría el renderizador. Lo que sí
 * merece prueba unitaria es la **lógica que replica una regla del servidor** —
 * hoy, la resolución de la política de aceptación de la torre de control—,
 * porque una copia que se desvía enseña un reloj que miente.
 *
 * `e2e/` queda fuera: son de Playwright y `vitest` no sabe ejecutarlas.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
