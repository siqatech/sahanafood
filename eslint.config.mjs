// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Configuración ESLint raíz del monorepo.
 *
 * Regla clave de negocio (ADR-0006, CLAUDE.md): PROHIBIDO el tipo `number`
 * en campos monetarios. Todo monto se modela con el value object `Money`
 * (enteros en céntimos) de @sahana/domain. La regla `no-restricted-syntax`
 * de abajo rompe el build si alguien tipa un campo de dinero como `number`.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/*.config.{js,cjs,mjs}',
      '**/.dependency-cruiser.cjs',
      // Lo genera Next en cada compilación y va con su propia directiva de
      // triple slash: corregirlo aquí solo sirve para que Next lo reescriba.
      'apps/web/next-env.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // --- Dinero: nunca `number` en campos monetarios (riesgo #1 del ADR-0006) ---
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TSPropertySignature[key.name=/^(amount|price|prices|unitPrice|total|subtotal|grandTotal|cost|unitCost|igv|tax|taxAmount|discount|discountAmount|fee|commission|balance|money|paid|change|tip|deposit)$/i] > TSTypeAnnotation > TSNumberKeyword',
          message:
            'Campo monetario tipado como `number`. Usa el value object Money (enteros en céntimos) de @sahana/domain. Ver ADR-0006 y CLAUDE.md.',
        },
        {
          selector:
            'PropertyDefinition[key.name=/^(amount|price|unitPrice|total|subtotal|grandTotal|cost|unitCost|igv|tax|taxAmount|discount|fee|commission|balance)$/i] > TSTypeAnnotation > TSNumberKeyword',
          message:
            'Campo monetario tipado como `number`. Usa Money (enteros en céntimos) de @sahana/domain. Ver ADR-0006.',
        },
      ],

      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true },
      ],
    },
  },
  {
    /**
     * NestJS resuelve las dependencias del constructor leyendo el metadato
     * `design:paramtypes`, que solo se emite si el tipo se importa como VALOR.
     * Convertir esos imports a `import type` deja el metadato en `undefined` y
     * la inyección falla en tiempo de ejecución (con la clase compilando
     * perfectamente). Por eso la regla se desactiva en la API: TypeScript sigue
     * verificando los tipos igual, y no arriesgamos un fallo que las pruebas
     * de tipos no pueden ver.
     */
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    /**
     * El agente de impresión corre como servicio en la mini PC del local, no
     * en la nube: no hay stack de observabilidad detrás, y su stdout es
     * literalmente lo que captura systemd (o el servicio de Windows) y lo que
     * lee la persona que va a arreglar la impresora. Aquí `console.log` ES el
     * log, no un resto de depuración.
     */
    files: ['apps/print-agent/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    /**
     * Pruebas de carga (T4.30). Dos entornos distintos en la misma carpeta:
     * los `.js` los ejecuta k6 —su propio runtime, con `__VU`, `__ITER` y
     * `__ENV` como globales— y los `.mjs` los ejecuta Node. En ambos, la
     * consola ES la salida de la prueba: no hay logger detrás.
     */
    files: ['tests/load/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        __VU: 'readonly',
        __ITER: 'readonly',
        __ENV: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    /**
     * Scripts de apoyo de la tienda: los ejecuta Node, no el navegador, y su
     * salida ES el resultado —el presupuesto de T5.14 se lee en la consola de
     * CI, no en un logger.
     */
    files: ['apps/web/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    /**
     * Componentes de React: el tipo de retorno de un componente es JSX y
     * anotarlo a mano no añade nada que el compilador no sepa ya.
     */
    files: ['apps/web/**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    /**
     * Semillas de desarrollo: imprimen por consola a propósito, porque su
     * salida es lo que alguien copia y pega para levantar el entorno.
     */
    files: ['apps/api/src/database/seed-shop.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Los tests pueden usar console y helpers laxos.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  prettier,
);
