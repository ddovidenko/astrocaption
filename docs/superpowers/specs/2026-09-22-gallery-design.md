# Milestone 5: Gallery — design

Approved 2026-09-22. Implements SPEC § 1 (point 5), § 5.5 (publish), the public routes in § 8
and the `public_gallery_enabled` config field in § 7. Milestone 5 in § 13.

## Decisions

- **Publishing needs an export.** The toggle is refused until the image is solved and has an
  export, so the gallery always has both bitmaps to swap between. Staleness is the owner's
  problem and is already shown by the card's "Export out of date" badge. A published image stays
  published across re-exports and re-solves, but the public list and routes only serve rows whose
  `solve_status` is `solved`, so an image drops out of the gallery while a re-solve runs (or after
  one fails) and returns when it is solved again; its old export is still what visitors then see
  until the owner exports again.
- **Visitors can download the annotated export.** The full-size view links to `annotated.jpg`.
  The unannotated original stays owner-only.
- **Routes.** Logged out, `/` is the gallery. `/gallery` and `/gallery/:id` work logged in and
  out, so the owner sees exactly what visitors see. `/login` is unchanged; the header shows
  "Log in" to visitors and "Gallery" to the owner.
- **Gallery can be switched off.** `public_gallery_enabled` (default true) on the Config page.
  Off: the public API answers 404 everywhere and the logged-out `/` shows the site title with a
  sign-in link.
- **Separate public router** (`backend/app/api/gallery.py`, prefix `/api/gallery`, no owner
  dependency). The owner router keeps its auth as is. The public surface is one file to audit.

## Data and config

No schema change: `images.published` exists. Config gains `public_gallery_enabled: bool`
(default true) in `config.json`, `Settings`, `ConfigOut` and `ConfigUpdate`, pinnable by
`ASTROCAPTION_PUBLIC_GALLERY` (`true`/`false`, case-insensitive; anything else is logged and
ignored) through the existing lock mechanism (`locked`, `locked_by`). `HealthOut` gains
`public_gallery_enabled` so the logged-out shell knows whether `/` is a gallery or a sign-in
prompt without an extra request.

## Owner API

`PUT /api/images/{id}/published` body `{published: bool}` → the updated `ImageOut`.

- `published: true` → 409 `Export the image before publishing it.` unless `solve_status ==
  'solved'` and `exported_at` is set and `annotated.jpg` exists on disk.
- `published: false` always succeeds.
- 404 for an unknown id. A no-op write (same value) still returns 200 and does not touch
  `updated_at`.

`DELETE /api/images/{id}` already removes the render dir, so an unpublished-by-deletion image
disappears from the gallery with it.

## Public API

All under `/api/gallery`, JSON, no cookie required. Every handler first checks the flag: when
`public_gallery_enabled` is false, every route is 404 with the same plain message as an unknown
image (`Image not found.`), so a visitor cannot tell the two apart.

- `GET /api/gallery` → `list[GalleryItem]`, published images, `created_at` descending.
- `GET /api/gallery/{id}` → `GalleryItem`; 404 if unknown or unpublished.
- `GET /api/gallery/{id}/files/{thumb|preview|annotated-preview|export}` → the file. 404 if
  unknown, unpublished, or (should never happen once published) the file is missing. `export`
  is served as an attachment named `<slug>-annotated.jpg` like the owner route. Cache header
  `public, max-age=86400`: the URLs carry `?v=<exported_at>`, so a re-export changes the URL.

```
GalleryItem
  id            str
  title         str
  width, height int      (original pixels)
  exported_at   str
  thumb_url, preview_url, annotated_preview_url, export_url   str (all /api/gallery/...)
```

Rows are read with one query (`WHERE published = 1 AND solve_status = 'solved' ORDER BY
created_at DESC`). A published row whose export files vanished (owner deleted `data/renders`
by hand) is skipped from the list with a server-log warning rather than 500.

Server paths never appear in any public payload (hard rule).

## Frontend

- `pages/GalleryPage.tsx`: responsive CSS grid (`repeat(auto-fill, minmax(260px, 1fr))`, 16 px
  gutter at phone width). Each card is a link to `/gallery/:id` holding the thumb, and the title
  under it. Hover swaps the thumb for the annotated preview (both `<img>` stacked, the top one
  toggled by opacity so nothing reflows; the annotated preview is loaded lazily). On touch, the
  first tap toggles the overlay and the second follows the link; `pointer: coarse` decides.
  Empty gallery: "Nothing published yet."
- `pages/GalleryImagePage.tsx`: the preview fit to the viewport (`max-height: calc(100vh -
  header)`, `object-fit: contain`), same hover/tap swap, the title, a "Download annotated
  image (W × H)" link to `export_url`, and a back link to the gallery. 404 from the API → "This
  image is not published." with the back link.
- `App.tsx`: `/` renders `GalleryPage` when `!authenticated` (setup still wins: `/` →
  `/setup` while `setup_required`), `ImagesPage` otherwise. `/gallery` and `/gallery/:id`
  outside `Guard`. Header nav: owner gets Gallery / Images / Config / Log out; visitor gets Log
  in. With the flag off and logged out, `/` shows the site title and the Log in link.
- `ImagesPage.tsx` card: a Publish / Unpublish button beside Export, disabled with the title
  "Export the image first" until `export_url` is set; a "Published" badge in the card header.
  Uses the existing `working`/`onChange` pattern.
- `ConfigPage.tsx`: a "Public gallery" checkbox in the existing `.field` rhythm, disabled with
  the usual lock sentence when pinned by the env var.
- `api.ts`: `GalleryItem`, `api.gallery()`, `api.galleryImage(id)`, `api.setPublished(id, bool)`.

## Errors

Plain sentences only. The public pages show `describeError` output like the rest of the app.
A failed publish shows the server's 409 text on the card. Nothing public carries paths or
tracebacks.

## Testing

- Backend (`backend/tests/test_gallery.py`): flag on/off × published/unpublished × each route;
  publish refused without an export and while a re-solve is running (the row is not `solved`); unpublish
  always allowed; unauthenticated `PUT /published` is 401; no server path in any payload
  (assert `data/` and `/home` absent from the JSON); env pin locks the config field.
- Frontend vitest: `ImageCard` button states (no export → disabled, exported → Publish, published
  → Unpublish); `GalleryCard` swap on hover and on tap under a mocked `pointer: coarse`.
- Playwright `frontend/e2e/gallery.spec.ts`: publish from the card, sign out, `/` lists the
  image, hover swaps to the annotated preview (compare the `src` of the visible layer), the full
  view's download link answers 200 with `image/jpeg`, an unpublished id is a plain 404 page, and
  the gallery is empty again after unpublishing. Restores state in a `finally` (#116).
- The parity contract is untouched: no renderer changes.

## Docs

SPEC § 5.5 (export prerequisite, download, flag), § 7 (`public_gallery_enabled` already
listed), § 8 (public routes rewritten to the `/api/gallery` shape, `PUT /published`), § 13
(milestone 5 done date). INSTALL.md: the flag and its env var in the config table.
ARCHITECTURE.md: the public router.

## PRs

1. `feat: public gallery API and publish toggle` — config flag, `gallery.py`, `PUT /published`,
   health field, backend tests.
2. `feat: gallery pages and publish button` — the four frontend files, vitest.
3. `feat: gallery e2e, docs` — Playwright spec, SPEC/INSTALL/ARCHITECTURE, review ritual
   (`/code-review high`, silent-failure pass, `/simplify`), owner smoke test.

Out of scope (later): per-image captions or descriptions, sorting other than newest first,
pagination, RSS, social preview tags, touch support in the editor (#57).
