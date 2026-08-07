import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Gate del ADR-0006 / gates comunes: 100% de ramas en dinero.
      // Gate de dinero: 100% de ramas. Cubre `money/` (Money e IGV) y
      // `pricing/` (totales y modificadores), porque ambos deciden importes
      // que acaban en un comprobante electrónico.
      thresholds: {
        'src/money/**': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        'src/pricing/**': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
