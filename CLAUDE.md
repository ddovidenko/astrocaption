# CLAUDE.md

Self-hosted web app that plate-solves a finished astrophoto JPG and lets the owner build
legible, editable annotations on top of it. Full product/tech spec lives in `docs/SPEC.md`;
read it before starting any feature. This file is the short version: how we work.

## Project shape

```
backend/      FastAPI + SQLite. Solving, catalog fetch, final full-res render (Pillow).
frontend/     React + TypeScript + Vite. Canvas editor (Konva). Built into backend/static at image build.
fonts/        Bundled open-licence TTFs. Same files are used by browser (CSS @font-face) and Pillow.
docker/       Dockerfile (multi-stage), entrypoint.
compose.yml   Self-hoster entry point (repo root, mounts ./data).
docs/         SPEC.md, INSTALL.md, LOCKOUT.md, ARCHITECTURE.md
data/         (runtime, volume-mounted) sqlite db, uploads, renders, config. Never committed.
```

## Commands

```
make install      # backend venv (backend/.venv) + frontend node_modules; run by make dev/test/lint as needed
make dev          # backend on :8000 (uvicorn --reload) + vite on :5173 with proxy
make test         # pytest + vitest
make lint         # ruff + mypy + eslint + tsc --noEmit
make build        # docker build -t astrocaption:local .
make up           # docker compose up (uses ./data as volume)
make reset-password   # see docs/LOCKOUT.md
make placement-vectors   # regenerate tests/fixtures/placement/*.json from the Python placer
```

If a Makefile target doesn't exist yet, create it rather than documenting a raw command.

## Hard rules

- The user's uploaded JPG is never modified. Annotations render onto a copy at export time.
- Preview (browser canvas) and export (server Pillow) must produce the same layout. Both read
  the same annotation JSON and the same font files. Any change to one renderer requires the
  same change to the other, plus a pixel-diff test in `backend/tests/test_render_parity.py`.
- Never call nova.astrometry.net during tests. Use the recorded fixtures in `backend/tests/fixtures/nova/`.
- Secrets (nova API key, password hash, session secret) live only in `data/config.json`
  and env vars. Never in the repo, never in logs, never returned by any API endpoint.
- Public (logged-out) routes are read-only and must never expose the editor, the config,
  or unpublished images.
- One container, one process supervisor. No sidecar services. SQLite, not Postgres.
- Keep the Docker image under 400 MB. Check with `docker image ls` after `make build`.

## Coding conventions

- Python 3.13+ (dev host runs 3.14; Docker image pins python:3.13-slim), type hints everywhere, ruff defaults, pytest. Pydantic models for every request/response.
- TypeScript strict. Function components + hooks. Zustand for editor state. No Redux.
- Coordinates: annotation geometry is stored in **original image pixels**, never in screen pixels.
  The canvas applies a single view transform (zoom, pan). Convert at the edges only.
- Fonts referenced by file name (e.g. `Inter-Regular.ttf`), never by family name, so browser and Pillow agree.
- Errors from the solver are surfaced to the user in plain language with the nova job URL when one exists.
- Small PRs. One feature or fix per branch. Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).

## Working with Claude Code

- Dev environment is Ubuntu 26.04 under WSL2. Repo lives on the Linux filesystem (`~/astrocaption`), never under `/mnt/c`. Use Linux paths and tooling only; Docker is invoked from the WSL shell.
- Start each task by restating which SPEC.md section it implements and which milestone it belongs to.
- Ask before adding a dependency. Prefer the standard library and what's already installed.
- After finishing a feature: run `make lint test`, update SPEC.md if behaviour diverged from it,
  and note anything a self-hoster needs to know in `docs/INSTALL.md`.
- Don't scaffold ahead of the current milestone. Milestone order is in SPEC.md § 13.
- When unsure about UX intent, check SPEC.md § 6 (editor interactions) before guessing.
