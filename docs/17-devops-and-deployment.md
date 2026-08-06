# DevOps y despliegue

- Entornos: local (docker compose) → dev → staging (datos sintéticos, integraciones sandbox) → prod. Paridad por imágenes.
- CI (por PR): lint + typecheck + dependency-cruiser + unit + integración (testcontainers) + prueba de aislamiento de tenant + SCA. PR no mergea si algo falla.
- CD: main → dev automático; staging por tag; prod por aprobación manual. Despliegue rolling con health checks; canary (10%) a partir de F5. Rollback = redeploy de imagen anterior; toda migración debe ser compatible con la versión anterior (expand → migrate → contract, nunca romper en un paso).
- Migraciones: Drizzle Kit, SQL revisado en PR, prohibido `DROP`/`ALTER` destructivo sin fase de contracción separada.
- IaC: Terraform desde F3 (BD, Redis, objetos, DNS, secretos). Nada creado a mano en prod.
- Feature flags: tabla propia por tenant (simple) en MVP; proveedor externo solo si se necesita segmentación avanzada.
- Versionado semántico de la API y de `@sahana/domain`. Ramas: trunk-based con ramas cortas.
- Gestión de incidentes: severidades S1–S4, on-call desde GA, postmortem sin culpa obligatorio S1/S2 en 72 h → acciones a `docs/23-technical-debt.md`.
