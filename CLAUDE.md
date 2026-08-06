# CLAUDE.md — Instrucciones para Claude Code

Este repositorio contiene la planificación completa de **Sahana Food**, un SaaS multi-tenant, multimarca y multisucursal para dark kitchens y restaurantes con delivery. Tu trabajo es implementarlo **por fases y por módulos**, sin perder contexto, siguiendo estas reglas.

## Cómo trabajar

1. **Lee siempre en este orden** antes de tocar código de un módulo:
   `docs/08-architecture.md` → `docs/09-multi-tenancy.md` → `specs/modules/<módulo>.md` → los ADR referenciados en la spec. Si el módulo tiene interfaz de usuario, lee también `docs/25-ux-and-design-system.md` y la spec de `specs/ux/` correspondiente.
2. **La spec del módulo es el contrato.** Si algo no está en la spec, no lo inventes: agrégalo a `docs/22-risks.md` como pregunta abierta y pregunta al usuario.
3. **No avances de fase** sin cumplir los criterios de salida de `specs/phases/<fase>.md`. Actualiza `docs/progress.md` al terminar cada tarea con estado: Pendiente / En análisis / Propuesta / Aprobada / En ejecución / Bloqueada / Finalizada.
4. **Toda decisión de arquitectura nueva → ADR.** Copia `docs/adr/ADR-0000-plantilla.md`, numera secuencialmente, estado inicial `Propuesto`.
5. **Commits pequeños y descriptivos** en español. Un módulo = una rama = un PR conceptual.

## Reglas técnicas innegociables

- **Stack:** TypeScript estricto + NestJS + Drizzle ORM + PostgreSQL 16 (RLS) + Redis + BullMQ + Next.js. Ver ADR-0006. No introduzcas otras bibliotecas centrales sin ADR.
- **Dinero:** NUNCA `number`. Usar el value object `Money` de `@sahana/domain` (enteros en céntimos). Regla ESLint activa: `no-restricted-types` sobre campos monetarios. En BD: `NUMERIC(14,4)`.
- **Multi-tenant:** toda tabla de negocio lleva `tenant_id NOT NULL`. RLS activo en toda tabla. El `tenant_id` se deriva del token, jamás del payload. Conexiones con `SET LOCAL app.tenant_id` dentro de transacción (pool en modo transacción). Ver ADR-0002 y `docs/09-multi-tenancy.md`.
- **Módulos:** cada módulo NestJS expone su API pública en `src/modules/<x>/index.ts`. Prohibido importar internals de otro módulo. `dependency-cruiser` corre en CI y falla el build ante violaciones.
- **Eventos:** todo evento de dominio se escribe en la tabla `outbox` EN LA MISMA transacción que el cambio de estado. Un relay lo publica a BullMQ. Consumidores idempotentes vía tabla `inbox`. Ver ADR-0007. Nunca publiques directo a Redis desde un handler HTTP.
- **Idempotencia:** clave única `(tenant_id, channel, external_id)` para pedidos externos; `Idempotency-Key` header para POST de clientes propios; IDs cliente = ULID. Ver ADR-0010.
- **Cálculo de totales:** SOLO en `@sahana/domain` (paquete compartido servidor/PWA). Prohibido duplicar lógica de precios/IGV en controladores o frontend.
- **Auditoría:** las acciones listadas en `docs/14-security.md#auditoria` escriben en `audit_log` (append-only, sin UPDATE/DELETE concedidos al rol de app).
- **API:** REST versionada `/api/v1`, convenciones en `docs/11-api-guidelines.md`. Errores con formato Problem Details (RFC 9457).
- **Pruebas mínimas por módulo:** unitarias de dominio, integración con Postgres real (testcontainers), y la **prueba de aislamiento de tenant** obligatoria para cada endpoint nuevo (fixture de 2 tenants, verificar 404/vacío cruzado).

## Prohibiciones

- No copiar código de Odoo, ERPNext, URY, Floreant ni de ningún repositorio GPL/LGPL/AGPL. Solo referencia conceptual. Ver ADR-0009.
- No usar Kubernetes, microservicios, Kafka ni motor de búsqueda dedicado en fases 3–6.
- No usar n8n ni automatizadores como núcleo transaccional. El motor de reglas interno (docs/27 §3) es tipado y acotado: no construir un workflow builder genérico.
- IA: jerarquía determinista-primero de ADR-0011; el LLM nunca redacta precios/stock/zonas de memoria (solo vía herramientas); toda respuesta IA deja traza. RAG siempre filtrado por tenant_id.
- No integrar marketplaces reales en el MVP: implementar contra el **simulador** de `specs/modules/13-integrations-platform.md`.
- No almacenar datos de tarjeta. Tokenización de pasarela siempre.

## Estructura objetivo del código

```
apps/
  api/          → NestJS (monolito modular)
  web/          → Next.js (panel + tienda)
  pos/          → PWA React (POS + KDS, offline-first)
  print-agent/  → agente local de impresión (Node, ESC/POS)
packages/
  domain/       → @sahana/domain: Money, cálculo de totales, máquina de estados, tipos
  contracts/    → DTOs y tipos de API compartidos
infra/
  docker/       → compose local, Dockerfiles
  migrations/   → SQL versionado (Drizzle Kit)
```

## Flujo de trabajo por tarea
Cada fase tiene un backlog numerado en `specs/phases/` (F3 ya lo trae; las demás se generan al abrirse con la tarea TX.00). Trabaja UNA tarea por vez: leer specs → implementar → pruebas verdes → actualizar `docs/progress.md` → commit `modulo: qué (TX.YY)`. Definition of Done y plantilla de módulo: `docs/29-coding-conventions.md`.

## Fase actual
Ver `docs/progress.md`. Empieza SIEMPRE leyendo ese archivo. Primera sesión: sigue `PROMPT-INICIAL.md`.
