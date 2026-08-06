# Fase 3 — Fundamentos técnicos
Objetivo: esqueleto sobre el que todo lo demás es "solo" features.
Alcance: monorepo (pnpm workspaces) · apps/api con módulos tenancy+identity+organization+audit · @sahana/domain (Money + property tests, base de máquina de estados) · RLS + pooling transaccional + suite de aislamiento · outbox/inbox + relay (ADR-0007) · docker compose local · CI/CD completo · Terraform dev · OTel + logs estructurados + Sentry.
Riesgos: RLS mal configurado (mitigación: test de esquema que verifica política en TODA tabla).
Salida (además de gates comunes): onboarding de tenant demo por script < 60 s · prueba de fuga con pooling agresivo (misma conexión, tenants alternados ×1000) en verde · evento de prueba viaja outbox→relay→inbox exactamente una vez bajo kill del relay.
Deuda permitida: UI mínima (solo API + seeds); sin MFA.

## Backlog ordenado (una tarea = una sesión de Claude Code)
| ID | Tarea | Entregable verificable |
|---|---|---|
| T3.01 | Monorepo pnpm + tsconfig base + ESLint/Prettier + estructura apps/packages/infra vacía | `pnpm i && pnpm lint` verde |
| T3.02 | docker compose local: Postgres 16, Redis, mailhog; scripts make | `docker compose up` + healthchecks |
| T3.03 | @sahana/domain: Money (enteros, redondeo RN-T04) con property tests | 100% ramas Money |
| T3.04 | apps/api esqueleto NestJS + config tipada + logger estructurado + Problem Details global | GET /health con trace_id |
| T3.05 | Drizzle + migraciones base + patrón RLS: helper `withTenant(tx)` con SET LOCAL; pool modo transacción | Test de fuga (tenants alternados ×1000) verde |
| T3.06 | Test de esquema: toda tabla nueva tiene tenant_id + política RLS (falla si no) | Suite en CI |
| T3.07 | Módulo Tenancy (spec 01): entidades, límites, flags, seeds | Criterios de aceptación spec 01 |
| T3.08 | Módulo Identity (spec 02): JWT+refresh rotativo, roles con ámbito, guard @RequirePermission | Matriz permiso×rol testeada |
| T3.09 | Dispositivos POS + PIN argon2 + emparejamiento | RN-IDN-03/04 testeadas |
| T3.10 | Módulo Audit (spec 17): audit_log append-only + interceptor + API interna | UPDATE sobre audit_log falla a nivel BD |
| T3.11 | Outbox/inbox + relay BullMQ (ADR-0007) + métricas | Evento sobrevive kill del relay exactamente-una-vez |
| T3.12 | Módulo Organization (spec 03): jerarquía completa + zonas geography + semilla demo | GET /coverage con punto en frontera |
| T3.13 | Prueba de aislamiento por endpoint: harness reutilizable + aplicada a todo lo existente | Suite bloqueante en CI |
| T3.14 | OTel + Prometheus + Sentry + dashboards mínimos | Traza de request→outbox→worker visible |
| T3.15 | CI/CD completo (lint, types, dep-cruiser, unit, integración testcontainers, aislamiento, SCA) + CD a dev | Pipeline verde de punta a punta |
| T3.16 | Terraform dev (BD, Redis, objetos, secretos) + runbook de despliegue | `terraform apply` reproducible |
| T3.17 | Onboarding por script: tenant demo completo < 60 s | Cronometrado en CI |
| T3.18 | Gate F3: revisión de criterios de salida + demo grabada + progress.md | Checklist _gates-comunes + fase en verde |

Las fases 4–9 generan su backlog al abrirse, con este mismo formato, derivado de sus specs (tarea T4.00 = "generar backlog F4 desde specs y aprobarlo").
