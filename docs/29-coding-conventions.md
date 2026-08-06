# Convenciones de código

Complementa CLAUDE.md. Se aprueba ANTES del primer módulo de negocio (gate F3).

## Lenguaje y estilo
TypeScript estricto (`strict: true`, sin `any` salvo frontera externa justificada con comentario). ESLint + Prettier de raíz del monorepo; CI falla ante warnings. Nombres: código e identificadores en inglés; textos de UI, mensajes de error al usuario, commits y documentación en español. Archivos kebab-case; clases PascalCase; constantes UPPER_SNAKE.

## Estructura de un módulo NestJS (plantilla obligatoria)
```
src/modules/<name>/
  index.ts            ← ÚNICA API pública (servicios/tipos exportados)
  <name>.module.ts
  api/                ← controllers + DTOs (zod schemas de packages/contracts)
  app/                ← casos de uso (servicios de aplicación)
  domain/             ← entidades y lógica pura (o re-export de @sahana/domain)
  infra/              ← repositorios Drizzle, adaptadores externos
  events/             ← handlers de eventos consumidos (inbox)
  migrations/         ← SQL del módulo (prefijo de tabla propio)
  __tests__/
```
Prohibido importar de `src/modules/otro/**` salvo `index.ts` (dependency-cruiser lo verifica).

## Patrones obligatorios
- **Dinero:** `Money` de @sahana/domain en todo el camino; en DTOs, céntimos enteros + moneda. Prohibido float.
- **Transacciones:** caso de uso = una transacción explícita (`db.transaction`); dentro: cambio de estado + outbox + auditoría si aplica. Nunca I/O externo dentro de la transacción.
- **Errores:** clases de error de dominio por módulo → mapper global a Problem Details. Nunca lanzar strings ni filtrar errores de Drizzle al cliente.
- **Validación:** zod en el borde (DTOs); el dominio asume datos válidos y valida invariantes de negocio.
- **Fechas:** timestamptz en BD, ISO-8601 UTC en API, formateo a zona del local SOLO en frontend/print.
- **Logs:** logger estructurado inyectado; prohibido console.log; siempre tenant_id y trace_id en contexto.
- **Feature flags/config de tenant:** leer vía servicio de Tenancy, nunca env vars para lógica de negocio.

## Commits y PRs
Formato: `<módulo>: <qué> (<tarea>)` — ej. `ordering: máquina de estados y transiciones (T3.07)`. PR pequeño (< ~600 líneas netas ideal), descripción con: tarea del backlog, decisiones tomadas, cómo probar. Checklist de PR (en plantilla): pruebas nuevas incluidas · prueba de aislamiento si hay endpoint nuevo · migración compatible hacia atrás · spec actualizada si divergió · sin TODOs sin issue.

## Definition of Done de una tarea
Código + pruebas verdes en CI + migración revisada + spec/docs actualizados + progress.md actualizado + demo mínima reproducible (comando o request de ejemplo en la descripción del PR).
