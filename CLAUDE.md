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
make dev-service  # the same at boot, as a systemd unit (Linux/WSL); stop it before running make dev by hand
make test         # pytest + vitest
make lint         # ruff + mypy + eslint + tsc --noEmit
make build        # docker build -t astrocaption:local .
make up           # docker compose up (uses ./data as volume)
make reset-password   # in the compose container; see docs/LOCKOUT.md
make reset-password-dev   # the same on a make dev checkout
make placement-vectors   # regenerate tests/fixtures/placement/*.json from the Python placer
make render-vectors      # regenerate tests/fixtures/render/vectors.json from render.py (text boxes, ascents, leaders, anchors)
make names-catalog       # rebuild backend/app/catalog/names.json from OpenNGC (network)
make fonts               # refresh fonts/*.ttf + LICENSES from Google Fonts (network); family list in backend/scripts/fetch_fonts.py
make favicons            # regenerate frontend/public/ icons from frontend/icon/icon-source.png
make record-fixtures IMAGE=path.jpg [OUT=dir]   # record nova fixtures from a real solve into backend/tests/fixtures/nova/ or OUT (network, needs the key)
make e2e          # Playwright smoke test: built frontend + uvicorn on a scratch data dir + a fake nova
make e2e-fixture  # regenerate frontend/e2e/fixtures/field.jpg
```

If a Makefile target doesn't exist yet, create it rather than documenting a raw command.

## Hard rules

- The user's uploaded JPG is never modified. Annotations render onto a copy at export time.
- Preview (browser canvas) and export (server Pillow) must produce the same layout. Both read
  the same annotation JSON and the same font files. Any change to one renderer requires the
  same change to the other and a regenerated contract: `make render-vectors`
  rewrites `tests/fixtures/render/vectors.json` from `render.py`, `backend/tests/test_render_parity.py` fails
  while it is stale, `frontend/src/editor/metrics.ts` (pinned by `metrics.test.ts`) must be changed to match,
  and the pixel diff in `frontend/e2e/parity.spec.ts` (Konva stage exported as PNG at a fixed zoom against
  the server's annotated preview, within the tolerance in SPEC § 9; arrives with the editor canvas)
  must still pass. Konva needs a browser, so the pixel diff lives in the Playwright suite, not pytest.
- Never call nova.astrometry.net during tests. Use the recorded fixtures in `backend/tests/fixtures/nova/`
  (3.9° Orion field) and `backend/tests/fixtures/nova-narrow/` (1° Pelican field with `hd` stars);
  `frontend/e2e/fake-nova.mjs` replays the Orion set for the browser test.
- Secrets (nova API key, password hash, session secret) live only in `data/config.json`
  and env vars. Never in the repo, never in logs, never returned by any API endpoint.
- Public (logged-out) routes are read-only and must never expose the editor, the config,
  or unpublished images.
- API responses and the page never carry server paths or raw exception text. Failures are
  plain language, with the nova status URL when one exists; tracebacks go to the server log.
- One container, one process supervisor. No sidecar services. SQLite, not Postgres.
- Keep the Docker image under 400 MB. Check with `docker image ls` after `make build`.

## Coding conventions

- Python 3.13+ (dev host, CI and the Docker image run 3.14 via python:3.14-slim), type hints everywhere, ruff defaults, pytest. Pydantic models for every request/response.
- TypeScript strict. Function components + hooks. Zustand for editor state. No Redux.
- Coordinates: annotation geometry is stored in **original image pixels**, never in screen pixels.
  The canvas applies a single view transform (zoom, pan). Convert at the edges only.
- Fonts referenced by file name (e.g. `Inter-Regular.ttf`), never by family name, so browser and Pillow agree.
- Errors from the solver are surfaced to the user in plain language with the nova job URL when one exists.
- Small PRs. One feature or fix per branch. Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`).
- Backlog lives in GitHub Issues, grouped by milestone (`gh issue list --milestone "Milestone 3: Editor v1"`).
  Reference issues from PRs (`Closes #12`); add new follow-ups as issues, not TODO comments.

## Working with Claude Code

- Dev environment is Ubuntu 26.04 under WSL2. Repo lives on the Linux filesystem (`~/astrocaption`), never under `/mnt/c`. Use Linux paths and tooling only; Docker is invoked from the WSL shell.
- Start each task by restating which SPEC.md section it implements and which milestone it belongs to.
- Ask before adding a dependency. Prefer the standard library and what's already installed.
- After finishing a feature: run `make lint test`, update SPEC.md if behaviour diverged from it,
  and note anything a self-hoster needs to know in `docs/INSTALL.md`.
- Don't scaffold ahead of the current milestone. Milestone order is in SPEC.md § 13.
- When unsure about UX intent, check SPEC.md § 6 (editor interactions) before guessing.
- Library docs: the Context7 MCP server covers FastAPI, Starlette, Pydantic, Pillow, httpx, React, Vite,
  Konva and similar; query it before answering API questions from memory. It has no entry for
  nova.astrometry.net: use https://astrometry.net/doc/net/api.html and the recorded fixtures instead.
- Flow: branch → `gh pr create` → `gh pr checks --watch` → `gh pr merge --squash` (the repo deletes
  the remote branch on merge; `--delete-branch` errors on the already-gone ref). Then `git checkout main && git pull`.
  `main` allows squash merges only (branch protection arrives with milestone 6). Never push to `main`.
  `gh pr edit` fails silently on this repo (GitHub's retired classic-projects API); change a PR body with
  `gh api -X PATCH repos/:owner/:repo/pulls/<n> -F body=@file` instead.
- Review ritual before a milestone PR: `/code-review high`, then a silent-failure pass
  (pr-review-toolkit agent) on the diff, then `/simplify`; fix, re-run `make lint test`, and let the
  owner smoke-test on `make dev` before committing.
- Don't switch git branches that add or remove `frontend/vite.config.ts` while `make dev` runs: Vite
  restarts without the `/api` proxy and the page goes blank. Stop the servers first (kill by port, not
  by process pattern). If `docker` needs `sudo`, the docker group hasn't taken effect in that shell yet.
