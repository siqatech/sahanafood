# Sahana Food — atajos de desarrollo local.
# Requiere: Docker, pnpm, Node 22+.

COMPOSE := docker compose -f infra/docker/docker-compose.yml

.PHONY: help
help: ## Muestra esta ayuda
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Instala dependencias del monorepo
	pnpm install

.PHONY: up
up: ## Levanta Postgres, Redis y Mailhog
	$(COMPOSE) up -d
	@echo "Esperando healthchecks..."
	@$(COMPOSE) ps

.PHONY: down
down: ## Detiene los servicios (conserva datos)
	$(COMPOSE) down

.PHONY: reset
reset: ## Detiene y BORRA los volúmenes (datos incluidos)
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Sigue los logs de infraestructura
	$(COMPOSE) logs -f

.PHONY: migrate
migrate: ## Aplica migraciones de BD (rol migrador)
	pnpm --filter @sahana/api migrate

.PHONY: seed
seed: ## Carga datos semilla (tenant demo)
	pnpm --filter @sahana/api seed

.PHONY: demo-tenant
demo-tenant: ## Onboarding de tenant demo (< 60 s, T3.17)
	pnpm --filter @sahana/api demo:tenant

.PHONY: lint
lint: ## ESLint en todo el repo
	pnpm lint

.PHONY: typecheck
typecheck: ## Chequeo de tipos en todos los paquetes
	pnpm typecheck

.PHONY: depcruise
depcruise: ## Verifica fronteras de módulos (dependency-cruiser)
	pnpm depcruise

.PHONY: test
test: ## Pruebas unitarias de todos los paquetes
	pnpm test

.PHONY: check
check: ## Suite completa: lint + typecheck + fronteras + pruebas
	pnpm check

.PHONY: dev
dev: up ## Levanta infra y arranca la API en modo watch
	pnpm --filter @sahana/api dev

.PHONY: worker
worker: up ## Arranca el worker de fondo (relay de outbox + vencimientos)
	pnpm --filter @sahana/api worker:dev
