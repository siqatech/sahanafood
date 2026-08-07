# Sahana Food

SaaS multi-tenant, multimarca y multisucursal para dark kitchens, cocinas virtuales y restaurantes con delivery. Orquesta pedidos de todos los canales (web, WhatsApp, POS, marketplaces), controla cocina e inventario, y mide la rentabilidad real por marca y canal.

**Estado:** Fase 3 (Fundamentos) **en ejecución**. El núcleo técnico ya existe y está verificado contra Postgres real (aislamiento multi-tenant, outbox/inbox, dominio de dinero). Ver [`docs/progress.md`](docs/progress.md).

**Para empezar con Claude Code:** abre [`PROMPT-INICIAL.md`](PROMPT-INICIAL.md) y sigue las instrucciones.

## Puesta en marcha (desarrollo)

Requisitos: Node 22+, pnpm 10+, Docker.

```bash
pnpm install                 # dependencias del monorepo
cp .env.example .env         # variables locales
make up                      # Postgres 16 + Redis + Mailhog (con healthchecks)
pnpm --filter @sahana/api migrate   # aplica infra/migrations/*.sql (rol migrador)
make demo-tenant             # onboarding de tenant demo (< 60 s)
make dev                     # API en http://localhost:3000  (GET /api/v1/health)
```

Calidad y pruebas:

```bash
pnpm check       # lint + typecheck + fronteras de módulo (dep-cruiser) + pruebas
pnpm --filter @sahana/domain test:coverage   # dinero: 100% de ramas (gate)
pnpm --filter @sahana/api test               # RLS, esquema y outbox (Postgres real)
```

### Estructura

```
apps/api          NestJS (monolito modular): RLS, outbox/inbox, /health
packages/domain   @sahana/domain: Money, IGV, máquina de estados (compartido servidor/PWA)
packages/contracts DTOs y contratos de API (zod)
infra/docker      compose local + init de roles Postgres (sin BYPASSRLS)
infra/migrations  SQL versionado (fuente de verdad del DDL y de las políticas RLS)
```

- Instrucciones para Claude Code: [`CLAUDE.md`](CLAUDE.md)
- Documentación: [`docs/`](docs/) — empieza por `docs/00-vision.md` y `docs/08-architecture.md`
- Especificaciones por módulo: [`specs/modules/`](specs/modules/)
- Fases y criterios de salida: [`specs/phases/`](specs/phases/)
- Decisiones: [`docs/adr/`](docs/adr/)
- Avance: [`docs/progress.md`](docs/progress.md)
- Convenciones de código: [`docs/29-coding-conventions.md`](docs/29-coding-conventions.md)
- **Revisión de arquitectura consolidada**: [`docs/30-arquitectura-consolidada.md`](docs/30-arquitectura-consolidada.md) — qué está verificado, inconsistencias detectadas y decisiones pendientes
- Módulos: 19 (specs/modules 01–19) · ADRs: 14 · Fases: 0–9 con gates
