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
            "TSPropertySignature[key.name=/^(amount|price|prices|unitPrice|total|subtotal|grandTotal|cost|unitCost|igv|tax|taxAmount|discount|discountAmount|fee|commission|balance|money|paid|change|tip|deposit)$/i] > TSTypeAnnotation > TSNumberKeyword",
          message:
            'Campo monetario tipado como `number`. Usa el value object Money (enteros en céntimos) de @sahana/domain. Ver ADR-0006 y CLAUDE.md.',
        },
        {
          selector:
            "PropertyDefinition[key.name=/^(amount|price|unitPrice|total|subtotal|grandTotal|cost|unitCost|igv|tax|taxAmount|discount|fee|commission|balance)$/i] > TSTypeAnnotation > TSNumberKeyword",
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
    // Los tests pueden usar console y helpers laxos.
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  prettier,
);
