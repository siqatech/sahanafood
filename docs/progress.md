# Avance del proyecto

Paquete: **v1.0 consolidado** (2026-08-06). Estados: Pendiente / En análisis / Propuesta / Aprobada / En ejecución / Bloqueada / Finalizada.

| Elemento | Estado | Nota |
|---|---|---|
| Fase 0 — Investigación | Finalizada | Doc maestro v0.1 + revisión comité v0.2 + anexos C/D |
| Fase 1 — Definición de producto | Propuesta | docs/00–07; validar con entrevistas (DP-08) |
| Fase 2 — Arquitectura base | Propuesta | ADR-0001..0015; pendientes de F2: threat model STRIDE + fichas docs/repositories/ |
| ADR-0006 (stack) | **Aceptada** | DP-01 resuelto: la ejecución es en TypeScript/NestJS. Reversa solo si el equipo humano es de perfil PHP (§8) |
| ADR-0013 (Money escala 4) | Aceptada | Representación interna de `Money` documentada e implementada |
| ADR-0014 (escapes acotados de RLS) | Aceptada | Patrón para relay de outbox y resolución de login sin romper el aislamiento |
| ADR-0015 (geometría en el dominio) | Aceptada | Cobertura y horarios compartidos servidor/cliente en vez de PostGIS; divergencia de la spec 03 registrada |
| **Fase 3 — Fundamentos** | **En ejecución** | Negocio y observabilidad completos, verificados contra Postgres real (**198 pruebas en verde**: 101 API + 97 dominio). Queda T3.16 (Terraform) y el gate T3.18 |
| **Fase 4 — Operación principal** | **En ejecución** | Backlog aprobado (32 tareas). Hecho: T4.01–T4.05, T4.07–T4.15 (salvo T4.06) (totales, catálogo, pedidos con dedupe, modificación con control optimista, aceptación automática con vencimiento, bandeja de excepciones resoluble, simulador de marketplace y **prueba de caos con cero pérdida**). **433 pruebas en verde** (191 dominio + 242 API). Siguiente: T4.06 (publicación versionada del catálogo) y el **worker periódico** que dispare relay de outbox + barrido de aceptación |
| Fases 5–9 | Pendiente | Backlog se genera al abrir cada fase (TX.00) |

## Fase 3 — Backlog (estado por tarea)

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| T3.01 | Monorepo pnpm + tsconfig + ESLint/Prettier + dep-cruiser | **Finalizada** | `pnpm lint`/`typecheck`/`depcruise` en verde; regla anti-`number` monetario activa |
| T3.02 | docker compose (Postgres 16, Redis, Mailhog) + Makefile | **Finalizada** | `docker compose config` OK; healthchecks; init de roles |
| T3.03 | `@sahana/domain`: Money (half-up RN-T04) + property tests | **Finalizada** | 49 pruebas; **100% de ramas en dinero**; IGV RN-T05; máquina de estados base |
| T3.04 | apps/api NestJS + config tipada + logger + Problem Details | **Finalizada** | `GET /api/v1/health` 200 con `trace_id`; 404 → `application/problem+json` |
| T3.05 | Drizzle + RLS `withTenant` + pool modo transacción | **Finalizada** | **Fuga ×1000 en verde** (misma conexión, tenants alternados) |
| T3.06 | Test de esquema: tenant_id + RLS en toda tabla de negocio | **Finalizada** | Suite `schema-rls` en verde; falla si una tabla nueva no cumple |
| T3.07 | Módulo Tenancy (spec 01) | **Finalizada** | `GET /tenant`, `/limits`, `/flags`; límites con cerrojo `FOR UPDATE` (429); suspensión bloquea login sin borrar datos |
| T3.08 | Módulo Identity (spec 02): JWT + roles con ámbito | **Finalizada** | argon2id, refresh rotativo con **revocación de familia por reuso** (RN-IDN-02), guard `@RequirePermission` global, matriz permiso×rol testeada |
| T3.09 | Dispositivos POS + PIN argon2 | **Finalizada** | Emparejamiento con código de un solo uso (garantizado por BD), token de dispositivo revocable, PIN argon2id con **bloqueo 5/15 min que persiste** y cambio obligatorio al primer uso |
| T3.10 | Módulo Audit (spec 17): append-only + interceptor | **Finalizada** | `recordAudit()` transaccional + `GET /audit` con `audit.read`; UPDATE/DELETE fallan en BD (probado). Interceptor automático llega con los módulos de F4 |
| T3.11 | Outbox/inbox + relay (ADR-0007) | **Finalizada** | **Exactamente-una-vez** verificado bajo kill del relay |
| T3.12 | Módulo Organization (spec 03) + zonas de cobertura | **Finalizada** | Jerarquía completa con **FKs compuestas** (docs/09 §4); M:N marca⟷cocina; `GET /coverage` con **punto en frontera**; horario que cruza medianoche; semilla demo de aceptación |
| T3.13 | Harness de aislamiento por endpoint reutilizable | **Finalizada** | `assertEndpointIsolation` recorre la respuesta entera buscando cualquier dato del tenant ajeno; aplicado a los 12 endpoints; incluye prueba del propio detector |
| T3.14 | OTel + Prometheus + dashboards | **Finalizada** | Trazas OTLP, `/metrics` Prometheus con métricas de negocio, y el **gate demostrado**: el `trace_id` sobrevive el salto request→outbox→worker |
| T3.15 | CI/CD completo | **En ejecución** | Workflow GitHub Actions (static, domain, integration con Postgres, build, SCA) |
| T3.16 | Terraform dev | **No entregada** | Definible pero **no verificable sin credenciales cloud**; entregar IaC nunca ejecutada es el artefacto que más caro sale al fallar. Dueño: propietario (docs/31 §3.1) |
| T3.17 | Onboarding tenant demo < 60 s | **Finalizada** | Script mide **50 ms** (gate < 60 s) |
| T3.18 | Gate F3: criterios de salida + demo grabada | **Propuesta** | Evaluación completa en `docs/31-gate-fase-3.md`: **apto con excepciones** (T3.16 y demo grabada, ambas con dueño humano) |

## Fase 4 — Backlog (estado por tarea)

Backlog completo (32 tareas) en `specs/phases/phase-4-operacion.md`. Aquí solo el estado.

| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| T4.00 | Backlog de la fase | **Finalizada** | `specs/phases/phase-4-operacion.md` |
| T4.01 | Entidades de catálogo (spec 04) | **Finalizada** | Migración `0008_catalog.sql`; jerarquía categoría→producto→grupo→opción con FKs compuestas |
| T4.02 | Modificadores y combos en `@sahana/domain` | **Finalizada** | `validateAndPriceModifiers` con códigos de error estables; definición de grupo validada |
| T4.03 | Precios por canal y sucursal | **Finalizada** | `resolvePrice` por especificidad ((canal,sucursal) > canal > base); índice único con `COALESCE` |
| T4.04 | Cálculo de totales (RN-T01..T05) | **Finalizada** | Redondeo half-up solo en el total; IGV extraído hacia atrás; propina fuera de base imponible; **100 % de ramas** |
| T4.05 | Disponibilidad y pausas de producto | **Finalizada** | `POST /catalog/products/:id/pause` emite `catalog.availability_changed` por outbox; pausas caducadas se levantan solas |
| T4.06 | Publicación versionada del catálogo | Pendiente | — |
| **T4.07** | **Máquina de estados de pedido** | **Finalizada** | 12 estados × 13 eventos: **las 156 combinaciones** probadas (transicionan o lanzan); BFS de alcanzabilidad; sin callejones sin salida |
| T4.08 | `OrderingService.submit()` + `ord_*` con snapshot inmutable | **Finalizada** | Migración `0009_ordering.sql`; la línea copia nombre y precio (no referencia a `cat_prices`); timeline append-only verificado en BD |
| T4.09 | Idempotencia y dedupe (ADR-0010) | **Finalizada** | **Dedupe concurrente en verde**: dos `submit()` simultáneos con el mismo `external_ref` → 1 pedido (garantía del índice único, no del código) |
| **T4.10** | **Validaciones de submit (RN-ORD-09)** | **Finalizada** | Marca activa en cocina del local + disponibilidad + cobertura + mínimo, cada una con su **código estable** de Problem Details (spec 05 §9) |
| **T4.11** | **Transiciones + API de pedidos + timeline** | **Finalizada** | `PATCH /orders/:id` con `If-Match` sobre `rowVersion`; la modificación **añade líneas de ajuste y no reescribe las confirmadas** (RN-ORD-07); 409 en transición inválida; timeline reconstruible |
| **T4.12** | **Aceptación automática/manual con vencimiento y programados** | **Finalizada (falta disparador)** | Política por (marca, canal) resuelta por especificidad; el pedido con auto-aceptación **nace aceptado en la misma transacción**; aviso a los 5 min sin repetirse y auto-rechazo a los 10 con timeline y evento al canal; programado liberado a `prep_minutes + 10`. **El barrido periódico aún no lo dispara nadie**: `sweepAllTenants()` está probado pero espera al worker de BullMQ (ver nota abajo) |
| **T4.13** | **Bandeja de excepciones + `resolve-mapping`** | **Finalizada** | `POST /orders/:id/resolve-mapping` recalcula el pedido apartado con el catálogo vigente y lo devuelve al flujo; permiso `orders.review_exceptions`; resolver dos veces → 409 |
| **T4.14** | **Simulador de marketplace (spec 13)** | **Finalizada** | `ChannelConnector` + simulador **reproducible por semilla**; ack < 250 ms medido; firma HMAC sobre el cuerpo crudo; credenciales cifradas por tenant (AES-256-GCM + HKDF, tenant como AAD); cortacircuitos por conexión |
| **T4.15** | **Prueba de caos de ingesta** | **Finalizada** | **Cero pérdida verificada matando el worker con `pg_terminate_backend`** a media faena, 6 rondas: todo webhook con ack acaba en pedido o en `needs_review`, sin duplicados, sin cola de muertos y sin cerrojos zombis |
| T4.16–T4.32 | Resto del backlog | Pendiente | — |

**Próximas acciones humanas:** confirmar DP-01 (equipo ejecutor) · agendar entrevistas DP-08 · revisar diffs de `infra/migrations/*.sql` · resolver PA-01/02/03 (`docs/22-risks.md`) · **definir `CREDENTIALS_MASTER_KEY` en cada entorno** (sin ella no arranca en producción, y rotarla obliga a recifrar).
**Deuda declarada (no la des por hecha):** hay DOS procesos periódicos implementados y probados que **nadie dispara todavía** en un despliegue real — `relayOnce()` (publicación del outbox, T3.11) y `AcceptanceService.sweepAllTenants()` (vencimientos y programados, T4.12). Ambos se ejercitan desde las pruebas llamándolos a mano. Hasta que exista el worker, en producción los eventos no saldrían del outbox y ningún pedido vencería solo. Es la siguiente pieza de infraestructura, no un detalle.

**Próxima acción de Claude Code:** worker de BullMQ que dispare ambos procesos, y T4.06 (publicación versionada del catálogo).
