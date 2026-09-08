# Architecture (milestone 1)

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
| `app/config.py` | `Settings` from env + `data/config.json`. The only reader of secrets. |
| `app/db.py` | Schema, `PRAGMA user_version` migrations, typed row mapping. One connection per call, WAL. |
| `app/models.py` | Pydantic models: `SolveObject`, `StyleConfig`, `Label`, `Annotations`, API payloads. |
| `app/storage.py` | Data-dir layout, derivative generation, solve copy. Never touches the original. |
| `app/solver/` | `Solver` protocol (`submit` / `poll_submission` / `poll_job` / `fetch_result`) and the nova client. |
| `app/worker.py` | Serialised solve queue; persists nova ids so a solve resumes after restart. |
| `app/objects.py` | nova annotations → objects in original pixels; splits star names; stable ids. |
| `app/catalog/` | OpenNGC-derived `names.json` (CC BY-SA 4.0) adding Messier/Caldwell/common names to NGC/IC designations. |
| `app/placement.py` | Deterministic auto-placer. Shared vectors in `tests/fixtures/placement/`. |
| `app/layout.py` | Default style per image size, enabled rule, placement glue, re-solve rematch. |
| `app/render.py` | Pillow text metrics and the export renderer. Its layout rules are the parity contract for the canvas. |
| `app/fonts.py` | Bundled font lookup by file name. |

## Coordinate contract

Everything stored (objects, labels, style lengths) is in **original image pixels**. The solve
copy sent to nova is smaller; `images.solve_scale` records the factor and `objects_from_nova`
applies it once, at ingest. A label's `(x, y)` is the top-left corner of its text box.

## Parity contract for milestone 3

`render.py` defines the numbers the browser canvas must reproduce: line height
`ceil(size × 1.2)`, alias line at `0.7 × size`, marker radius `max(catalogue radius,
style.marker_min_radius)`, leader from the marker edge to the closest point of the text box,
drawn automatically when that gap exceeds `12·s` (`s = max(W, H) / 1000`).
