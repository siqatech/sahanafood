/**
 * dependency-cruiser — hace cumplir las fronteras del monolito modular
 * (docs/08-architecture.md, CLAUDE.md).
 *
 * Reglas duras que rompen el build:
 *  1. Un módulo NestJS solo puede importarse a través de su `index.ts` público.
 *     Prohibido importar internals (`api/`, `app/`, `infra/`, `domain/`...) de
 *     OTRO módulo.
 *  2. Los paquetes compartidos (@sahana/domain, @sahana/contracts) no pueden
 *     depender de las apps.
 *  3. Sin dependencias circulares.
 *  4. Sin código huérfano.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Dependencia circular: rompe el aislamiento y complica el testeo.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'module-boundary-only-via-index',
      severity: 'error',
      comment:
        'Prohibido importar internals de otro módulo. Usa únicamente su API pública en modules/<x>/index.ts (docs/08-architecture.md).',
      from: { path: 'apps/api/src/modules/([^/]+)/.+' },
      to: {
        path: 'apps/api/src/modules/([^/]+)/.+',
        pathNot: [
          // Permitido importarse a sí mismo (mismo módulo).
          'apps/api/src/modules/$1/.+',
          // Permitido el barrel público de cualquier módulo.
          'apps/api/src/modules/[^/]+/index\\.(ts|js)$',
        ],
      },
    },
    {
      name: 'packages-no-dependen-de-apps',
      severity: 'error',
      comment:
        'Un paquete compartido no puede depender de una app. El dominio es el corazón, no depende de nada de infraestructura.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'domain-es-puro',
      severity: 'error',
      comment:
        '@sahana/domain debe ser lógica pura: sin NestJS, sin Drizzle, sin acceso a red o disco (ADR-0006).',
      from: { path: '^packages/domain/' },
      to: {
        dependencyTypes: ['npm'],
        pathNot: ['^packages/'],
        path: '(@nestjs|drizzle-orm|ioredis|bullmq|pg|axios|node:fs|node:net|node:http)',
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Archivo huérfano: ¿código muerto?',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.',
          '(^|/)(eslint|prettier|vitest|drizzle)\\.config\\.',
          '(^|/)index\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
