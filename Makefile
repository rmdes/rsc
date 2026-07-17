# Textcaster — common tasks. `make` (no target) lists everything.
# Two ways to run: Docker (one command) or local Node (npm workspaces).
.DEFAULT_GOAL := help
.PHONY: help up down logs install dev-core dev-web test check \
        prod-env prod-up prod-down prod-logs

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-11s\033[0m %s\n",$$1,$$2}'

## ── Docker: one command, core + web + Mailpit, live reload ──
up: ## Start the dev stack (docker compose up)
	docker compose up
down: ## Stop the dev stack
	docker compose down
logs: ## Follow dev stack logs
	docker compose logs -f

## ── Local dev: host Node, npm workspaces (two terminals) ──
install: ## npm install + seed core/.env & web/.env from examples
	npm install
	@[ -f core/.env ] || cp core/.env.example core/.env
	@[ -f web/.env ]  || cp web/.env.example  web/.env
dev-core: ## Run core in watch mode (terminal 1)
	npm run dev -w core
dev-web: ## Run web dev server (terminal 2)
	npm run dev -w web

## ── Shared ──
test: ## Run core + web test suites
	npm test -w core && npm test -w web
check: ## Typecheck core + svelte-check web
	npm run typecheck -w core && npm run check -w web

## ── Prod self-host on a VPS ──
prod-env: ## Generate .env (domain, secrets, Mailpit hash)
	./scripts/generate-env.sh
prod-up: ## Build + start the prod stack (Caddy auto-HTTPS)
	docker compose -f compose.prod.yaml up -d --build
prod-down: ## Stop the prod stack
	docker compose -f compose.prod.yaml down
prod-logs: ## Follow prod stack logs
	docker compose -f compose.prod.yaml logs -f
