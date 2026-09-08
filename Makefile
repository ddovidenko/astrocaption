# AstroCaption developer entry points. See CLAUDE.md.
SHELL := /bin/bash
.DEFAULT_GOAL := help

VENV      := backend/.venv
PY        := $(VENV)/bin/python
NPM       := npm --prefix frontend

.PHONY: help install dev dev-backend dev-frontend test test-backend test-frontend lint lint-backend lint-frontend format build up placement-vectors clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: $(VENV)/.installed frontend/node_modules ## Create the backend venv and install frontend packages

$(VENV)/.installed: backend/pyproject.toml
	test -d $(VENV) || python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet -e "backend[dev]"
	touch $@

frontend/node_modules: frontend/package.json frontend/package-lock.json
	$(NPM) ci --no-audit --no-fund
	touch $@

dev: install ## Backend on :8000 (uvicorn --reload) + Vite on :5173 with proxy
	$(MAKE) -j2 dev-backend dev-frontend

dev-backend:
	cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000

dev-frontend:
	$(NPM) run dev

test: test-backend test-frontend ## pytest + vitest

test-backend: $(VENV)/.installed
	cd backend && .venv/bin/pytest -q

test-frontend: frontend/node_modules
	$(NPM) test --silent

lint: lint-backend lint-frontend ## ruff + mypy + eslint + tsc --noEmit

lint-backend: $(VENV)/.installed
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy

lint-frontend: frontend/node_modules
	$(NPM) run lint --silent

format: $(VENV)/.installed ## Apply ruff formatting
	cd backend && .venv/bin/ruff format . && .venv/bin/ruff check --fix .

build: ## docker build -t astrocaption:local .
	docker build -f docker/Dockerfile -t astrocaption:local .
	docker image ls astrocaption:local

up: ## docker compose up --build (uses ./data as the volume)
	docker compose up --build

placement-vectors: $(VENV)/.installed ## Regenerate tests/fixtures/placement/*.json from the Python placer
	cd backend && .venv/bin/python scripts/make_placement_vectors.py

clean: ## Remove build artefacts (keeps data/)
	rm -rf backend/static frontend/dist backend/.pytest_cache backend/.mypy_cache backend/.ruff_cache
