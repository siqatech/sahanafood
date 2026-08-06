# Avance del proyecto

Paquete: **v1.0 consolidado** (2026-08-06). Estados: Pendiente / En análisis / Propuesta / Aprobada / En ejecución / Bloqueada / Finalizada.

| Elemento | Estado | Nota |
|---|---|---|
| Fase 0 — Investigación | Finalizada | Doc maestro v0.1 + revisión comité v0.2 + anexos C/D |
| Fase 1 — Definición de producto | Propuesta | docs/00–07; validar con entrevistas (DP-08) |
| Fase 2 — Arquitectura base | Propuesta | ADR-0001..0013; pendientes de F2: threat model STRIDE + fichas docs/repositories/ |
| ADR-0006 (stack) | **Aceptada** | DP-01 resuelto: la ejecución es en TypeScript/NestJS. Reversa solo si el equipo humano es de perfil PHP (§8) |
| ADR-0013 (Money escala 4) | Aceptada | Representación interna de `Money` documentada e implementada |
| **Fase 3 — Fundamentos** | **En ejecución** | Núcleo técnico verificado contra Postgres real (8/8 pruebas de gate en verde) |
| Fases 4–9 | Pendiente | Backlog se genera al abrir cada fase (T4.00) |

## Fase 3 — Backlog (estado por tarea)

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| T3.01 | Monorepo pnpm + tsconfig + ESLint/Prettier + dep-cruiser | **Finalizada** | `pnpm lint`/`typecheck`/`depcruise` en verde; regla anti-`number` monetario activa |
| T3.02 | docker compose (Postgres 16, Redis, Mailhog) + Makefile | **Finalizada** | `docker compose config` OK; healthchecks; init de roles |
| T3.03 | `@sahana/domain`: Money (half-up RN-T04) + property tests | **Finalizada** | 49 pruebas; **100% de ramas en dinero**; IGV RN-T05; máquina de estados base |
| T3.04 | apps/api NestJS + config tipada + logger + Problem Details | **Finalizada** | `GET /api/v1/health` 200 con `trace_id`; 404 → `application/problem+json` |
| T3.05 | Drizzle + RLS `withTenant` + pool modo transacción | **Finalizada** | **Fuga ×1000 en verde** (misma conexión, tenants alternados) |
| T3.06 | Test de esquema: tenant_id + RLS en toda tabla de negocio | **Finalizada** | Suite `schema-rls` en verde; falla si una tabla nueva no cumple |
| T3.07 | Módulo Tenancy (spec 01) | En análisis | Tablas base (`ten_*`) creadas; falta API + verificación de límites |
| T3.08 | Módulo Identity (spec 02): JWT + roles con ámbito | Pendiente | Config JWT lista; matriz permiso×rol por implementar |
| T3.09 | Dispositivos POS + PIN argon2 | Pendiente | — |
| T3.10 | Módulo Audit (spec 17): append-only + interceptor | En análisis | Tabla `audit_log` con REVOKE UPDATE/DELETE; falta interceptor Nest |
| T3.11 | Outbox/inbox + relay (ADR-0007) | **Finalizada** | **Exactamente-una-vez** verificado bajo kill del relay |
| T3.12 | Módulo Organization (spec 03) + zonas geography | Pendiente | — |
| T3.13 | Harness de aislamiento por endpoint reutilizable | En análisis | Helpers de test creados; falta harness genérico por endpoint |
| T3.14 | OTel + Prometheus + Sentry + dashboards | Pendiente | `trace_id` propagado extremo a extremo; falta exportador OTel |
| T3.15 | CI/CD completo | **En ejecución** | Workflow GitHub Actions (static, domain, integration con Postgres, build, SCA) |
| T3.16 | Terraform dev | Pendiente | — |
| T3.17 | Onboarding tenant demo < 60 s | **Finalizada** | Script mide **50 ms** (gate < 60 s) |
| T3.18 | Gate F3: criterios de salida + demo grabada | Pendiente | 3 gates duros ya en verde; faltan T3.07–T3.16 |

**Próximas acciones humanas:** confirmar DP-01 (equipo ejecutor) · agendar entrevistas DP-08 · revisar diffs de `infra/migrations/*.sql`.
**Próxima acción de Claude Code:** continuar el backlog F3 por T3.07 (módulo Tenancy: API + verificación de límites) y T3.08 (Identity).
