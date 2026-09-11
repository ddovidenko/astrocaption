# AstroCaption developer entry points. See CLAUDE.md.
SHELL := /bin/bash
.DEFAULT_GOAL := help

VENV      := backend/.venv
PY        := $(VENV)/bin/python
NPM       := npm --prefix frontend

.PHONY: help install dev dev-backend dev-frontend dev-service dev-service-remove test test-backend test-frontend lint lint-backend lint-frontend format build up reset-password reset-password-dev placement-vectors names-catalog record-fixtures favicons e2e-fixture clean

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

# `make dev` at boot, for Linux/WSL hosts with systemd. Generated from this checkout and user.
define DEV_SERVICE_UNIT
[Unit]
Description=AstroCaption dev servers (uvicorn :8000 + vite :5173) in $(CURDIR)
After=network.target

[Service]
User=$(shell id -un)
WorkingDirectory=$(CURDIR)
Environment=HOME=$(HOME)
Environment=PATH=$(HOME)/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/make dev
Restart=always
RestartSec=3
KillMode=control-group

[Install]
WantedBy=multi-user.target
endef
export DEV_SERVICE_UNIT

dev-service: install ## Run `make dev` at boot via systemd (Linux/WSL with systemd; uses sudo)
	@printf '%s\n' "$$DEV_SERVICE_UNIT" | sudo tee /etc/systemd/system/astrocaption-dev.service >/dev/null
	sudo systemctl daemon-reload
	sudo systemctl enable --now astrocaption-dev
	@echo "astrocaption-dev is enabled. Logs: journalctl -u astrocaption-dev -f"
	@echo "Stop it before running make dev by hand: sudo systemctl stop astrocaption-dev"

dev-service-remove: ## Disable and remove the boot service
	-sudo systemctl disable --now astrocaption-dev
	sudo rm -f /etc/systemd/system/astrocaption-dev.service
	sudo systemctl daemon-reload

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

reset-password: ## Choose a new owner password inside the running container (docs/LOCKOUT.md)
	docker compose exec app python -m app.cli reset-password

reset-password-dev: $(VENV)/.installed ## Choose a new owner password on this checkout (make dev installs)
	cd backend && .venv/bin/python -m app.cli reset-password

placement-vectors: $(VENV)/.installed ## Regenerate tests/fixtures/placement/*.json from the Python placer
	cd backend && .venv/bin/python scripts/make_placement_vectors.py

names-catalog: $(VENV)/.installed ## Rebuild backend/app/catalog/names.json from OpenNGC (network)
	cd backend && .venv/bin/python scripts/build_names_catalog.py

favicons: $(VENV)/.installed ## Regenerate frontend/public/ icons from frontend/icon/icon-source.png
	cd backend && .venv/bin/python scripts/make_favicons.py

e2e-fixture: $(VENV)/.installed ## Regenerate frontend/e2e/fixtures/field.jpg (3000×2250, matches the nova fixtures)
	cd backend && .venv/bin/python scripts/make_e2e_fixture.py

record-fixtures: $(VENV)/.installed ## Record nova fixtures from a real solve: make record-fixtures IMAGE=path.jpg [OUT=backend/tests/fixtures/nova-narrow]
	@test -n "$(IMAGE)" || { echo "usage: make record-fixtures IMAGE=path/to/image.jpg [OUT=dir]"; exit 2; }
	cd backend && .venv/bin/python scripts/record_nova_fixtures.py "$(abspath $(IMAGE))" $(if $(OUT),"$(abspath $(OUT))",)

clean: ## Remove build artefacts (keeps data/)
	rm -rf backend/static frontend/dist backend/.pytest_cache backend/.mypy_cache backend/.ruff_cache
