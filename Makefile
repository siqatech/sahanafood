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

# ---------------------------------------------------------------------------
# Pruebas de carga (T4.30). El perfil sale de docs/06: 2 000 pedidos/hora
# sostenidos, pico 10× durante 15 min, p95 de submit < 500 ms.
#
# k6 corre en contenedor para no obligar a instalarlo: una prueba que exige
# instalar un binario a mano se ejecuta una vez y nunca más.
# ---------------------------------------------------------------------------
K6_IMAGE ?= grafana/k6:0.49.0
BASE_URL ?= http://localhost:3000
PEAK_DURATION ?= 15m
# El mismo del compose local (infra/docker/init/01-roles.sql). Se pone por
# defecto para que `make load-verify` funcione recién clonado el repo: una
# verificación que exige exportar una variable a mano se salta.
DATABASE_URL ?= postgres://sahana_app:sahana_app_dev@localhost:5432/sahana
# Tiene que ser LA MISMA con la que corre la API: el secreto de firma del
# webhook se guarda cifrado con una clave derivada de esta. Si no coinciden, la
# ingesta devuelve 500 al descifrar y el motivo no se ve desde fuera.
CREDENTIALS_MASTER_KEY ?= dev-only-credentials-master-key-change-me

.PHONY: load-seed
load-seed: ## Siembra el escenario de carga y deja su JSON en tests/load/results/
	@mkdir -p tests/load/results
	@DATABASE_URL="$(DATABASE_URL)" \
	 CREDENTIALS_MASTER_KEY="$(CREDENTIALS_MASTER_KEY)" \
	 pnpm --silent --filter @sahana/api seed:load > tests/load/results/scenario.json
	@echo "Escenario listo en tests/load/results/scenario.json"

.PHONY: load-peak
load-peak: ## Pico 10× durante 15 min contra la API (requiere API y worker vivos)
	@test -f tests/load/results/scenario.json || (echo "Ejecuta antes: make load-seed"; exit 1)
	docker run --rm --network host \
		--user "$(shell id -u):$(shell id -g)" \
		-v "$(PWD)/tests/load:/scripts" \
		-e BASE_URL="$(BASE_URL)" \
		-e PEAK_DURATION="$(PEAK_DURATION)" \
		-e SCENARIO="$$(cat tests/load/results/scenario.json)" \
		-w /scripts $(K6_IMAGE) run submit-orders.js

.PHONY: load-ingest
load-ingest: ## Ingesta de marketplace bajo carga (webhooks firmados, ack < 250 ms)
	@test -f tests/load/results/scenario.json || (echo "Ejecuta antes: make load-seed"; exit 1)
	docker run --rm --network host \
		--user "$(shell id -u):$(shell id -g)" \
		-v "$(PWD)/tests/load:/scripts" \
		-e BASE_URL="$(BASE_URL)" \
		-e PEAK_DURATION="$(PEAK_DURATION)" \
		-e SCENARIO="$$(cat tests/load/results/scenario.json)" \
		-w /scripts $(K6_IMAGE) run ingest-webhooks.js

.PHONY: load-verify
load-verify: ## Comprueba la CERO PÉRDIDA contra la base tras la carga
	DATABASE_URL="$(DATABASE_URL)" node tests/load/verify-zero-loss.mjs

.PHONY: load
load: load-seed load-peak load-verify ## Prueba de carga completa + verificación

.PHONY: e2e-web
e2e-web: ## Pruebas de navegador de la tienda (ADR-0018). Requiere docker up + migrate.
	@echo "Sembrando la tienda demo…"
	pnpm --filter @sahana/api seed:shop
	@echo "Levanta la API en otra terminal (make api) y vuelve a ejecutar si falla."
	pnpm --filter @sahana/web build
	pnpm --filter @sahana/web test:browser

.PHONY: images
images: ## Construye las imágenes de producción (api/worker y tienda)
	DOCKER_BUILDKIT=1 docker build -f infra/docker/Dockerfile.api -t sahana/api:local .
	DOCKER_BUILDKIT=1 docker build -f infra/docker/Dockerfile.web -t sahana/web:local .

.PHONY: prod-up
prod-up: ## Levanta el stack de producción en esta máquina (necesita .env)
	docker compose -f infra/docker/docker-compose.prod.yml --env-file .env up -d

.PHONY: prod-down
prod-down: ## Detiene el stack de producción (conserva los datos)
	docker compose -f infra/docker/docker-compose.prod.yml --env-file .env down

.PHONY: prod-logs
prod-logs: ## Sigue los logs del stack de producción
	docker compose -f infra/docker/docker-compose.prod.yml --env-file .env logs -f

.PHONY: provision
provision: ## Da de alta un cliente. Ej: make provision NOMBRE="Pollería" EMAIL=d@p.pe DUENO="Rosa Quispe"
	docker compose -f infra/docker/docker-compose.prod.yml --env-file .env run --rm api \
		node dist/database/provision.js --nombre "$(NOMBRE)" --email "$(EMAIL)" --nombre-dueno "$(DUENO)"
