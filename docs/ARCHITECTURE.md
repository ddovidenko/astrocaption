# Architecture (milestone 2)

One container, one process: uvicorn runs the FastAPI app, which serves the API, the bundled
fonts, the built React page, and an in-process solve worker.

```
frontend/src/App.tsx ──fetch──▶ /api/images ...           (backend/app/api/images.py)
                                     │
                    upload ──▶ storage.make_derivatives   preview.jpg, thumb.jpg
                                     │ enqueue
                             worker.SolveWorker (asyncio queue, one solve at a time)
                                     │ storage.make_solve_copy   solve.jpg (≤ 3000 px)
                                     │ solver.nova.NovaSolver    submit / poll / fetch
                                     │ objects.objects_from_nova  scale ×solve_scale, catalog.enrich_names
                                     │ layout.build_default_annotations
                                     │      ├ render.measure_label   (Pillow text metrics)
                                     │      └ placement.place_labels (pure geometry, SPEC § 6.4)
                                     ▼
                                db.Database (sqlite3)  images / objects / annotations
                                     │
                     export ──▶ render.render_annotated  original + annotations → annotated.jpg
```

## Modules

| Module | Responsibility |
|---|---|
| `app/main.py` | App factory: routers, the plain-language 422 handler, headless first-run setup from `ASTROCAPTION_PASSWORD`, SPA mount. |
| `app/config.py` | `Settings` from env + `data/config.json`. The only reader of secrets. |
| `app/db.py` | Schema, `PRAGMA user_version` migrations, typed row mapping. One connection per call, WAL. |
| `app/models.py` | Pydantic models: `SolveObject`, `StyleConfig`, `Label`, `Annotations`, API payloads. |
| `app/storage.py` | Data-dir layout, derivative generation, solve copy. Never touches the original. |
| `app/solver/` | `Solver` protocol (`submit` / `poll_submission` / `poll_job` / `fetch_result`) and the nova client. |
| `app/worker.py` | Serialised solve queue; persists nova ids so a solve resumes after restart. |
| `app/objects.py` | nova annotations → objects in original pixels; splits star names; stable ids. |
| `app/catalog/` | OpenNGC-derived `names.json` (CC BY-SA 4.0) adding Messier/Caldwell/common names to NGC/IC designations, and OpenNGC's object types, folded into the kind (galaxy / nebula / cluster) that `ObjectOut.kind` reports. |
| `app/placement.py` | Deterministic auto-placer. Shared vectors in `tests/fixtures/placement/`. |
| `app/layout.py` | Default style per image size, enabled rule, placement glue, re-solve rematch. |
| `app/render.py` | Pillow text metrics and the export renderer. Its layout rules are the parity contract for the canvas. |
| `app/fonts.py` | Bundled font lookup by file name. |
| `app/auth.py` | scrypt password hashes, stateless HMAC session tokens, login cooldown, first-run setup writer. Standard library only. |
| `app/api/images.py` | Upload (size-guarded before the body is read), list/get/delete, re-solve, objects, annotations, export, file serving. |
| `app/api/health.py`, `app/api/fonts.py` | Public health for the Docker healthcheck; the bundled font list. |
| `app/api/errors.py` | The plain sentences shared by every route that writes `config.json`. |
| `app/api/deps.py` | Request-scoped dependencies; `require_owner` gates every owner router on the session cookie. |
| `app/api/auth.py` | `/api/setup`, `/api/login`, `/api/logout`. |
| `app/api/config.py` | Owner settings: `GET`, and `PUT` with locked-field and style validation, serialised through the atomic writer. |
| `app/api/docs.py` | Owner-only Swagger UI and OpenAPI document (`/api/docs`, `/api/openapi.json`). |
| `app/cli.py` | `python -m app.cli reset-password`: rewrites the password hash (or completes setup) through the same writer as the API. |

Every router except health and the setup/login/logout router carries the require_owner
dependency; the cookie is validated per request against the secret and password hash in
config.json, so a password reset logs everyone out. `/api/docs` and `/api/openapi.json` are
mounted on their own gated router, so the API schema and Swagger UI are owner-only too.

## Coordinate contract

Everything stored (objects, labels, style lengths) is in **original image pixels**. The solve
copy sent to nova is smaller; `images.solve_scale` records the factor and `objects_from_nova`
applies it once, at ingest. A label's `(x, y)` is the top-left corner of its text box.

## Parity contract for milestone 3

`render.py` defines the numbers the browser canvas must reproduce: line height
`ceil(size × 1.2)`, alias line at `0.7 × size`, marker radius `max(catalogue radius,
style.marker_min_radius)`, leader from the marker edge to the closest point of the text box,
drawn automatically when that gap exceeds `12·s` (`s = max(W, H) / 1000`).

`backend/scripts/make_render_vectors.py` (`make render-vectors`) writes those numbers, for the real
label strings of both nova fixtures in every bundled font, to `tests/fixtures/render/vectors.json`.
Three tests hold the contract (CLAUDE.md): `backend/tests/test_render_parity.py` rebuilds the file
from `render.py` and fails when it is stale; `frontend/src/editor/metrics.test.ts` replays it against
the TypeScript port `frontend/src/editor/metrics.ts` with Pillow's widths standing in for the canvas;
and `frontend/e2e/parity.spec.ts` measures the same strings on a real
canvas and pixel-diffs the Konva stage against the server's annotated preview within a tolerance
(SPEC § 9). The pixel diff runs under Playwright because Konva needs a browser. `GET /api/fonts`
carries Pillow's ascent per size, because the browser draws on the alphabetic baseline and Pillow on
the ascender line. Marker rings: Pillow's outline grows inward, so the canvas draws the circle at
`r − width/2`.

A second, smaller contract covers the name ranking and alias-line policy: `make names-vectors`
writes `tests/fixtures/names/vectors.json` from `models.py`, replayed by
`backend/tests/test_names_vectors.py` (fails when the file is stale) and
`frontend/src/editor/names.test.ts` (the TypeScript port).

## Editor

`frontend/src/editor/` holds the canvas: `store.ts` (zustand document state), `load.ts` (fetches
an image's objects/annotations and builds the editor document), `fonts.ts` (strict bundled-font
loader), `view.ts` (zoom/pan view-transform math), `metrics.ts` (the TypeScript port of the parity
contract above), `placement.ts` (the TypeScript port of the auto-placer, SPEC § 6.4, pinned by the
same vectors as `backend/app/placement.py`), `editing.ts` (whether the document is editable, the
shared measuring context, and `toggleWithPlacement`), `autosave.ts` (debounces document changes
into `PUT annotations`, tracks the toolbar's save state, and exposes `flushSave`/`retrySave` for
actions that must not race a pending save), `LabelTextShape.tsx` (the Konva text node for a label)
and `EditorCanvas.tsx` (the Konva stage: preview image, markers, leaders, labels, hover ring and
tooltip, wheel zoom about the cursor, drag/middle-mouse/space pan, `F` fit and `1` 100 %, click to
toggle or select a label, left-drag to move one), mounted by `EditorPage.tsx` at `/images/:id`
alongside `SidePanel.tsx` (the Objects/Layout/Image tabs, SPEC § 6.3). The canvas exposes
`window.__astrocaptionEditor = { stage, imageWidth, labelCount, labelPositions(), renderAt(scale) }`
— published only once the preview bitmap has loaded — so `frontend/e2e/parity.spec.ts` can force a
render at a fixed scale for the pixel diff and read how many labels were drawn (the width test
measures on its own canvas), and `frontend/e2e/smoke.spec.ts` can locate a label on screen to drag it.

## Browser tests

`frontend/e2e/` runs under Playwright against the built frontend served by uvicorn (`make e2e`) or
the Docker image (CI), with `frontend/e2e/fake-nova.mjs` standing in for nova.astrometry.net: one
worker, one data dir, and the spec files run in alphabetical order as one story —
`parity.spec.ts` (the pixel diff above), `smoke.spec.ts` (setup, solve, export, edit, config, sign
out) and `solve-failure.spec.ts` last, so the Orion image already exists by then. That spec's three
steps are "nova reports failure", "re-solve times out" and "Check again resumes": a solve nova
reports as failed, a Re-solve that never finishes and times out, and Check again resuming that
stored job back to Solved without a second upload. It needs the fake to misbehave on demand
(`POST /_fake/mode` with `success`, `failure` or `timeout`; `GET /_fake/state` reports the mode and
the upload count) and needs the app's solve deadline to be seconds rather than 15 minutes, so
uvicorn and the CI container both take their environment from `frontend/e2e/app.env`.

Every spec imports `test`/`expect` from `frontend/e2e/fixtures.ts` rather than from Playwright:
two automatic fixtures there fail a test on any uncaught page error and reset the fake nova's mode
after each one, so mode leakage is not part of the file order. `frontend/e2e/dev-proxy.dev.spec.ts`
is the exception to "against the built frontend": the `dev-proxy` project (opt-in, `E2E_DEV_PROXY=1`,
set by `make e2e` and the CI step) starts Vite on :5799 pointed at the same app through
`ASTROCAPTION_DEV_PROXY_TARGET`, and checks `/api` and `/fonts` really reach the backend through the
proxy — the blank page (#11, #52) a lost proxy causes. `*.dev.spec.ts` is what the other project
ignores.
