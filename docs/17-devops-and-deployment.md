# DevOps y despliegue

- Entornos: local (docker compose) → dev → staging (datos sintéticos, integraciones sandbox) → prod. Paridad por imágenes.
- CI (por PR): lint + typecheck + dependency-cruiser + unit + integración (testcontainers) + prueba de aislamiento de tenant + SCA. PR no mergea si algo falla.
- CD: main → dev automático; staging por tag; prod por aprobación manual. Despliegue rolling con health checks; canary (10%) a partir de F5. Rollback = redeploy de imagen anterior; toda migración debe ser compatible con la versión anterior (expand → migrate → contract, nunca romper en un paso).
- Migraciones: Drizzle Kit, SQL revisado en PR, prohibido `DROP`/`ALTER` destructivo sin fase de contracción separada.
- IaC: Terraform desde F3 (BD, Redis, objetos, DNS, secretos). Nada creado a mano en prod.
- Feature flags: tabla propia por tenant (simple) en MVP; proveedor externo solo si se necesita segmentación avanzada.
- Versionado semántico de la API y de `@sahana/domain`. Ramas: trunk-based con ramas cortas.
- Gestión de incidentes: severidades S1–S4, on-call desde GA, postmortem sin culpa obligatorio S1/S2 en 72 h → acciones a `docs/23-technical-debt.md`.

Puesta en marcha paso a paso —desde un servidor vacío hasta el primer cliente
vendiendo—: **`docs/34-puesta-en-marcha.md`**. Imágenes en `infra/docker/`
(`Dockerfile.api` sirve a la API y al worker: la misma imagen con dos comandos,
para que no puedan divergir en el cálculo de totales).

## Canario y reversión (T5.35)

El criterio de la fase 5 es concreto: **un despliegue malo se revierte sin tocar
la base de datos**. Eso no lo garantiza la herramienta de despliegue — lo
garantizan dos piezas del repositorio, y las dos fallan el build si se rompen:

**1. `infra/scripts/check-migrations.mjs` — gate de compatibilidad.** Rechaza
`DROP TABLE`, `DROP COLUMN`, `RENAME`, cambios de tipo, `SET NOT NULL`, `DROP
POLICY` y columnas `NOT NULL` sin `DEFAULT`. Todo eso rompe a la versión
anterior, que sigue viva durante el despliegue y vuelve a estar sola si hay que
revertir. Corre en CI y tiene una prueba que comprueba **que rechaza de
verdad**: un gate que nunca falla no es un gate.

Cuando de verdad toca borrar algo, se hace en una migración posterior declarada:

```sql
-- fase: contract
-- expande: 0012_catalog_versions.sql
ALTER TABLE cat_catalog_versions DROP COLUMN campo_viejo;
```

Declararlo no es un trámite: obliga a escribir contra qué expansión se está
contrayendo, que es la comprobación que nadie hace de memoria.

**2. `GET /api/v1/health/ready` — la sonda que gobierna el canario.** Devuelve
`ready` solo si la base responde y el esquema aplicado **alcanza** al que trae la
imagen. La regla es una desigualdad, no una igualdad:

- esquema aplicado **≥** requerido por la imagen → `ready`
- esquema aplicado **<** requerido → `not_ready` (sus consultas fallarían contra
  columnas que no existen)

Una base **por delante** del código está lista, y eso no es una concesión: es el
estado exacto justo después de revertir. Si la sonda lo marcara como no listo, la
reversión exigiría tocar la base. Solo se sostiene porque el gate de arriba
impide que una migración rompa hacia atrás — las dos piezas son la misma
garantía, y por separado ninguna vale.

`GET /api/v1/health` (liveness) y `/health/ready` (readiness) son cosas
distintas a propósito: un proceso vivo con la base caída tiene que salir del
balanceador **sin** que nadie lo reinicie, porque reiniciarlo no arregla la base
y sí tira las peticiones en vuelo.

**Procedimiento del canario.** Desplegar la versión nueva al 10 %; el
balanceador la mete en rotación solo cuando `/health/ready` responde `ready`.
Vigilar tasa de 5xx, p95 y `outbox_pending` (docs/18) durante 15 minutos. Si algo
se degrada: **redeploy de la imagen anterior y nada más**. No se revierten
migraciones. El esquema se queda por delante, la sonda sigue diciendo `ready`, y
la contracción se hace días después, cuando ya no queda ninguna instancia de la
versión mala.

**Lo que sigue siendo entregable humano:** el balanceador, el pipeline de CD y el
reparto de tráfico viven en la infraestructura cloud, bloqueada por DT-02. Lo que
está aquí es lo que hace que, cuando exista, revertir funcione.
