# AstroCaption — Product & Technical Spec

Version 0.2 of this document (milestone 1 implemented 2026-09-07; deviations from 0.1 are marked *M1 note*). Repo: github.com/ddovidenko/astrocaption

## 1. What it is

A self-hosted web app, distributed as a single Docker image, that:

1. Plate-solves a **finished, colour-graded JPG** (not linear FITS) using nova.astrometry.net.
2. Returns every catalogued object nova found in the field.
3. Lets the owner build a clean annotation overlay: pick which objects show, drag labels
   call-out style, resize text, choose font and colours.
4. Exports a full-resolution, high-quality JPG with the overlay burned in.
5. When nobody is logged in, shows a public gallery of the latest annotated images with a
   hover-to-reveal overlay.

Why it exists: nova's own annotation overlay is unreadable (fixed tiny font, overlapping labels,
no control). Desktop tools (Siril, ASTAP) either can't solve processed JPGs reliably or throw
away the colour grade. Nothing lets you annotate the image you actually finished.

## 2. Users

- **Owner** — the single admin. Installs the container, sets a password on first run, uploads
  images, edits annotations, exports. There is exactly one owner account.
- **Visitor** — anyone hitting the URL logged out. Read-only gallery.

No multi-user, no roles, no invites in v1.

## 3. Non-goals for v1

- Local/offline plate solving (ASTAP, solve-field). Nova only. Solver is behind an interface so this can be added later.
- Linear FITS input, stretching, or any image processing.
- Email, password reset by email, OAuth.
- Multiple owners or per-image permissions.
- Mobile-first editor. Gallery must work on phones; the editor may assume a mouse.

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Python 3.13+, FastAPI, uvicorn | Pillow and the nova API client are Python; FastAPI gives typed schemas and OpenAPI for free. |
| Storage | SQLite (stdlib `sqlite3`, explicit SQL, `PRAGMA user_version` migrations) + filesystem | One container, one volume. Nothing to administer. *M1 note:* no ORM; three tables did not justify the dependency. |
| Frontend | React 19 + TypeScript + Vite, react-router | Interactive canvas editor needs real state management. |
| Canvas | react-konva (Konva.js) | Draggable text, hit-testing, zoom/pan, and export-parity math are all easier than raw Canvas 2D. |
| State | Zustand | Small, no boilerplate. |
| Export render | Pillow (server) | Guarantees full-res output regardless of client GPU/memory. |
| Auth | Stateless HMAC session cookie, `hashlib.scrypt` password (§ 10) | Standard library only; a password reset re-keys every session. |
| Container | Multi-stage Dockerfile, `python:3.14-slim` final | Node only in build stage. |
| CI | GitHub Actions → GHCR | Public image `ghcr.io/ddovidenko/astrocaption`. |

## 5. Core flows

### 5.1 First run (install)

1. Owner runs `docker compose up`. Container starts, finds no `data/config.json`.
2. Every route redirects to `/setup`.
3. Setup page (one screen, WordPress-style): choose password (twice), paste nova API key
   (optional here, can be set later), site title. Submit.
4. App writes `config.json` (password hash, random session secret, key, title) and redirects to login.
5. `/setup` returns 404 forever after.
6. Headless installs set `ASTROCAPTION_PASSWORD` instead: at startup, when `config.json` has no
   password hash, the app performs step 4 with that password. The variable is read once and never stored.
7. A `config.json` that exists but cannot be parsed is **not** "not set up": setup stays closed
   (`POST /setup` answers 409), login is refused, and `/api/health` carries `config_error` so the owner can
   fix or delete the file. `config_error` is a fixed plain sentence ("config.json is not valid JSON; fix
   it, or remove it and run setup again (removing it resets the owner password)"); the parser's reason and
   the file's path go to the server log only.
8. A `config.json` holding only one of `password_hash`/`session_secret` cannot authenticate anybody, so it
   reopens setup; setup writes both halves fresh and merges them into whatever else the file holds.
   Concurrent setup submissions are serialised: the first wins, the rest get the 404 of step 5.

### 5.2 Upload & solve

1. Owner uploads a JPG (also accept PNG/TIFF; convert to RGB internally). Max size configurable, default 60 MB.
   The page shows upload progress (bytes sent) and then "Processing…" while the server writes the derivatives.
2. Backend stores the original untouched at `data/uploads/<id>/original.<ext>`, generates a
   2048-px preview JPG and a 400-px thumbnail.
3. Backend submits to nova (async job). Status page polls. Typical 30–120 s.
   *M1 note:* what is uploaded is `solve.jpg`, a ≤ 3000 px JPEG copy; nova's pixel coordinates and radii
   are multiplied by `solve_scale = original_width / copy_width` at ingest so everything stored is in
   original pixels. Solves run one at a time through an in-process queue. A row stays `pending` (previous
   nova ids and links intact) until nova accepts the upload, then becomes `solving` with the new ids, so a
   restart resumes exactly the in-flight submission and never re-uploads it; transient nova errors while
   polling are retried until the 15-minute deadline (configurable, `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS`); scale hints are stored on the row; deleting an image
   mid-solve drops the job. Uploads whose `Content-Length` exceeds the limit are refused before the body is read (chunked
   uploads hit the same cap while streaming). Uploads are capped at 300 megapixels regardless of file size, 16-bit greyscale
   PNG/TIFF is rescaled rather than clipped, and JPEGs with a multi-picture (MPO) segment are accepted.
   Every solve uploads a copy to the owner's own nova account (never publicly listed) and only the latest
   one is linked from the card; copies can be deleted on nova only, which the card says in one sentence (#1).
4. On success: store WCS header (`wcs.fits` text), the nova job ID, and nova's annotation
   list (`/api/jobs/<id>/annotations/`) as `nova_annotations.json`. Every object gets a stable local ID
   (assigned by descending radius, then name). *M1 note:* nova returns one designation per deep-sky
   object (`NGC 1976`) and `"ι Ori / 44 Ori"` plus a proper name for bright stars. The app splits the
   star names and appends aliases from a bundled OpenNGC-derived table (`backend/app/catalog/names.json`:
   Messier, Caldwell, common names and a few more catalogues). Entries are never merged: nova places
   NGC 1980 and ι Ori at the same pixel and they are different objects. The label's primary line is
   chosen by the style's *name preference* (§ 6.3).
5. Owner lands in the editor with all objects present but **only objects above a size
   threshold enabled** (default: radius ≥ 0.4 % of image width, plus all named bright stars, plus
   non-stellar objects nova returns with radius 0: there the radius means "no size known", not
   "small", so NGC 206 in M 31 is enabled like any other NGC entry. Decided 2026-09-11, #9).
   `hd`-type stars have radius 0 and are therefore hidden by default (see § 14).
6. On failure: show nova's job log link and let the owner retry, optionally with scale hints
   (focal length / pixel size passed as nova's `scale_units` etc.). **Check again** is offered only
   after a timeout ("Timed out after…"): it resumes polling the submission and job the row still
   holds, without uploading anything again (#10), and ignores the scale hints — a resume never
   builds a new request, so hints apply to Re-solve. It is never offered after nova reported a
   failure (that job is finished and unsolvable) or after a re-submit failed (the row then still
   carries an *earlier* attempt's ids, which resuming would silently adopt) or after an unexpected
   server error; the row records which of the three it was in `solve_failure` and the API reports
   the verdict as `check_available`. The worker's restart-resume path serves Check again too.

Optional resolve later: "Re-solve" button re-runs step 3 without deleting the annotation layout;
objects are re-matched by catalogue name.

Delete asks for confirmation in the page, not in a browser dialog; so does the editor's
"Reset positions" (§ 6).

### 5.3 Edit (see § 6)

### 5.4 Export

1. Owner clicks Export. Chooses the JPEG encoding and optionally a scale (100 %, 50 %). The default,
   **match original**, reuses the uploaded JPEG's own quantisation tables and chroma subsampling
   (progressive, Huffman-optimised): the export lands at about the input's size with the smallest
   possible generational loss (measured 56 dB PSNR on a Lightroom q100 export, versus 48 dB at q95 and
   a 60 % larger file at q100). A quality of 50–100 can be forced instead (4:4:4 chroma); PNG/TIFF
   sources default to quality 95.
2. Server renders with Pillow from `original` + `annotations.json` + font file. Never from the preview.
   The original's ICC profile is copied to the export.
3. Result stored at `data/renders/<id>/annotated.jpg` and served as a download. Re-export overwrites.
   *M1 note:* `POST /export` is synchronous (returns when the file is written; a few seconds for a
   60 MB source) and also writes `annotated_preview.jpg` (≤ 2048 px) for the gallery and the M1 page.

### 5.5 Publish

- Each image has `published: bool`. Default false.
- Gallery shows published images only, newest first. Hover (or tap on touch) swaps the preview
  to the annotated preview. Click opens a full-size view with the same hover behaviour.

## 6. Editor — interactions

The editor is a full-viewport canvas with a collapsible side panel.

### 6.1 Canvas

Milestone 3 PR 4 delivered the canvas itself: preview, markers, leaders, labels, zoom/pan,
hover, and the `F`/`1` keyboard shortcuts below. PR 5 (this milestone) adds click-to-toggle,
select/drag, the autosave and the side panel (§ 6.3).

- Shows the 2048-px preview scaled to fit. All geometry stored in original-image pixel coordinates.
- **Mouse wheel**: zoom, centred on cursor. **Drag on empty canvas / middle mouse / space+drag**: pan.
- Hovering an object's position highlights it (subtle ring + name tooltip), whether or not it is enabled.
- **Click** a hovered object: toggles it enabled. Its label appears at its default position.
- **Click** a label: selects it (shows a selection outline). Clicking empty canvas deselects.
- Keyboard: `Esc` deselect, `Delete`/`Backspace` disable the selected label, `F` fit to view, `1` 100 %.
- `Ctrl+Z` undo, `Ctrl+Y` / `Ctrl+Shift+Z` redo (`Cmd` on macOS), also as toolbar buttons. The history is per editing session (lost on reload and cleared by a conflict), capped at 100 entries; a drag is one entry, a bulk enable is one entry, an auto-arrange is one entry. Keys are ignored while a form field has the focus.

### 6.2 Labels (call-outs)

Every enabled object has:

- A **marker** at the object's position: circle sized to the catalogue radius (min 4 px), or a small ring for stars.
- A **label** (text block): primary name, optional secondary line with aliases. The stored `x, y` is the
  **top-left of the text box**; line height is `ceil(size × 1.2)`; the alias line is set at `0.7 × size`
  (min 6 px) and aliases are joined with ` · `.
- A **leader line** from marker edge to label, drawn only when the label is farther than a gap threshold
  (`auto`: gap between marker edge and the closest point of the text box > 12·s). Owner can force it always/never.

Interactions:

- **Left-drag** a label: moves it. Snaps nothing; free placement.
- **Mouse wheel while holding left button on a label**: changes that label's font size (± 1 px per notch, clamped 6–200 px in original-pixel units). Wheel does *not* zoom during this.
- **Double-click** a label: edit its text inline (override name). Blank resets to catalogue name.
- Selected label shows a small toolbar: font size, colour override, hide aliases, reset position.
- Shift-click to multi-select; dragging moves the group; panel edits apply to all.

*M3 note:* this milestone ships single select (click) and left-drag move only. Wheel-to-resize,
double-click text edit, the per-label toolbar and shift-click multi-select arrive with milestone 4
(§ 13), alongside per-label overrides.

### 6.3 Side panel

Milestone 3 PR 5 delivers three of the four tabs below — **Style** ships with milestone 4. Edits
are held locally and flushed to `PUT annotations` on a debounce (autosave); the toolbar's status
reads `Saving…` while a save is in flight, `Saved` once it lands, and `Unsaved changes` for an edit
still waiting out the debounce. A failed save reads the server's sentence, or "The last change
could not be saved." when there is none, with a Retry button; a 409 from someone else's more recent
save reads "This image was changed elsewhere. Reload to continue editing." with a Reload button —
editing itself stays live, only saving stops (design § 5). Closing or reloading the tab prompts for
confirmation while the document is dirty, saving or in error; a conflict does not prompt, because
those edits cannot be saved at all and Reload is the documented way out. Leaving the editor inside
the app instead flushes the pending save first. While a solve is running (`pending` or `solving`)
the toolbar reads "Read-only while solving" and the panel's actions are disabled; a *failed*
re-solve leaves the previous layout editable (§ 5), and the page says so above the canvas.

Tabs:

1. **Objects** — searchable list of every object nova returned. Columns: checkbox (enabled), name, type, radius. Hovering a row highlights on canvas; clicking pans to it. Bulk actions are "Enable shown" / "Disable shown" (both act on the rows the search and type filter currently show).
Each is one change: the labels being enabled are placed one after another, each around the ones before it, and applied together, so a batch is one undo entry and one save.
*M3 note:* the type filter uses nova's own annotation types — `NGC`, `IC`, `Bright stars`, `HD stars`, `Other` — rather than the galaxy/nebula/cluster/star buckets above; the richer OpenNGC types arrive in milestone 4. `HD stars` starts unchecked (#37): a narrow field can return dozens of duplicate HD rows, most of them a brighter object's twin. The min-size slider is not built.
2. **Style** — global defaults: font (dropdown of bundled fonts, live preview), font size, text colour, marker colour, leader colour, halo (stroke) on/off + colour, marker line width, alias line on/off, **name preference** (`popular`: Messier/Caldwell/Sharpless/Barnard, then NGC, then IC, then other catalogues, then common names; `ngc_ic`: NGC/IC designations first; stars: proper name, then Bayer, then Flamsteed). Per-label overrides win over globals. `config.default_style` seeds these for new images.
3. **Layout** — "Auto-arrange" button: flushes any pending save, then runs the collision-avoidance placer on all enabled labels (same algorithm as the initial placement); "Reset positions" asks for confirmation, then does the same. In M3 no label is pinned, so the two differ only by the confirmation — M4's pinned labels will make Reset discard pins. Neither touches the document until the placed labels come back; both then mark it dirty for the autosave to pick up. A 409 shows as the toolbar's Reload state, with one line in the tab saying the layout was not arranged; a label dragged while the request was in flight drops the answer rather than undoing the drag.
4. **Image** — read-only solve facts (nova job link, field centre/size/rotation, pixel scale, image size) and the **Export** button (full resolution, matching the original JPEG's encoding). *M3 note:* re-solve, publish toggle and delete stay on the image card, not this tab.

### 6.4 Auto-placement algorithm (initial and on demand)

Deterministic, identical in TS and Python (shared test vectors in `tests/fixtures/placement/`).
The TypeScript port ships in `frontend/src/editor/placement.ts`: toggling a label on (§ 6.1) calls
it in the browser for an immediate placement, ahead of the next autosave; the Layout tab's
"Auto-arrange" and "Reset positions" instead call `POST autoarrange` and place server-side, since
they re-place every enabled label at once (the placer ignores the current position of every label
it places, so neither needs to move anything first). The same vectors that pin `backend/app/placement.py`
pin this port (`placement.test.ts`), so the two cannot drift:

1. Sort enabled objects by radius descending.
2. For each: try anchors right, left, below, above, then four diagonals, at gap `g = 6·s` where `s = max(W,H)/1000`.
3. Accept first anchor whose text box is inside the image and does not overlap any accepted box (padding `4·s`) or cross the marker ring of a larger object. *M1 note:* only the drawn ring line blocks, not the circle's interior; otherwise a nebula such as M 42 (1500 px radius on a full-frame image) would leave no legal slot for the Trapezium stars inside it.
4. If none fit, step all anchors outward by `40·s` and retry, up to 4 rings; then fall back to "right"
   (ring 0) and mark the label as `collided` so the UI can show a warning badge.

Details fixed by the M1 implementation (`backend/app/placement.py`):

- Sort ties break on object id ascending. Marker radius used here is `max(catalogue radius, style.marker_min_radius)`.
- Diagonal anchors put the box corner at `offset / √2` on both axes; "inside the image" is inclusive of the edges.
- Boxes overlap when their gap is smaller than the padding on any side; a box "crosses a ring" when its nearest point is closer than `r + pad` and its farthest corner farther than `r − pad` from the centre.
- The placer accepts *fixed* boxes and circles as obstacles it must avoid but never moves; re-solve uses this to keep the owner's layout and place only new objects.
- An object whose own circle spills past the frame (M 31 filling the field: radius larger than the distance to every edge) gets no slot outside its ring, so after the normal search fails it is labelled as a point at its centre using the same anchors and rings. Only objects whose ring is fully inside the frame fall through to the `collided` fallback.
- Text boxes are measured by the caller (Pillow on the server, canvas metrics in the browser); the placer itself has no font dependency. Vectors in `tests/fixtures/placement/` pin the Python output and are regenerated with `make placement-vectors`.

## 7. Data model

```
images
  id            uuid
  created_at
  title         text (default: filename)
  original_name text  (upload file name)
  original_path, preview_path, thumb_path   (relative to the data dir)
  width, height int
  solve_status  enum(pending|solving|solved|failed)
  solve_error   text?  (plain-language message shown to the owner)
  solve_failure text?  (why a failed row failed: timeout|failed|error; NULL unless failed. Only
                        'timeout' is resumable — see § 5.2 step 6)
  solve_scale   real   (original px per solve-copy px, default 1.0)
  nova_submission_id, nova_job_id  int?
  wcs_text      text?
  calibration   json?  (nova's ra, dec, radius, pixscale, orientation, parity)
  solve_hints   json?  (focal length / pixel size from the last Re-solve; kept so a restart reuses them)
  published     bool
  exported_at   text?
  updated_at

objects (per image, from nova; immutable after solve)
  id            local int
  image_id
  catalog_names json  ["NGC 1976","M 42","Orion Nebula"]
  type          text  (nova's `type`: ngc|ic|messier|bright|hd|...)
  x, y          float  (original pixels)
  radius        float

annotations (per image; the editable layout)
  image_id
  style         json  (global StyleConfig)
  labels        json  [{object_id, enabled, x, y, font_size?, text_override?, color?, show_aliases?, leader: auto|on|off, collided}]
  version       int   (bumped on every save; the editor's conflict check)
```

Config (`data/config.json`, never in DB): `password_hash`, `session_secret`, `nova_api_key`,
`site_title`, `max_upload_mb`, `default_style`, `public_gallery_enabled`.

## 8. API (all JSON, `/api/...`)

Public:
- `GET /gallery` → published images (thumb, preview, annotated preview, title)
- `GET /images/{id}/public` → same for one image, 404 if unpublished

Owner (cookie session):
- `POST /setup` {password, nova_api_key?, site_title?} → 404 once set up; `POST /login` {password} → sets the
  cookie, 401 on a wrong password, 429 with `Retry-After` during the cooldown; `POST /logout` clears it.
  Logged-out calls to any owner route get 401 with a plain message.
- `POST /password` {current_password, new_password} → 204 with a fresh cookie; 403 on a wrong current
  password; 429 with `Retry-After` during the cooldown (shared with `POST /login`); 422 on a rule violation
  (new password out of the 8–1024 range, or the same as the current one); 409 when `config.json` cannot be
  read or no longer holds a usable password; 500 when the new password was written but the file could not
  be read back afterwards (the password did change; the browser is not re-signed-in).
- `GET/PUT /config` → {site_title, max_upload_mb, nova_api_key_set, default_style, style_defaults, locked,
  locked_by}. `PUT` is partial: absent fields are kept, `nova_api_key: null` clears the key, and
  `default_style` replaces the owner's whole override set — a save from the page therefore stores exactly the
  fields it shows filled in, and every field left blank goes back to the built-in default (derived from the
  image size for `font_size`, `halo_width`, `marker_width` and `marker_min_radius`). It is validated against
  the style model and the bundled fonts. `default_style` read from `config.json` is normalised through the
  same model, field by field: what `GET` reports is always something `PUT` accepts, and anything the model
  cannot represent is dropped at load with a server-log warning naming the field (never its value). `locked`
  lists the fields pinned by environment variables and `locked_by` maps each of them to the variable that set
  it (`nova_api_key` may be pinned by `NOVA_API_KEY` or `ASTROMETRY_API_KEY`); a `PUT` that touches one is
  rejected with a plain message naming that variable. `style_defaults` carries the built-in font, colours,
  booleans and name preference for fields without an override. Writes go through the atomic config.json
  writer under a lock, the running app re-reads the file immediately, and a `PUT` with nothing to change
  never rewrites it.
- `POST /images` (multipart) → id, starts solve
- `GET /images`, `GET /images/{id}`, `DELETE /images/{id}`
- `POST /images/{id}/solve` (re-solve, optional scale hints)
- `POST /images/{id}/check` (check again: resume polling the stored nova job without uploading, #10).
  409 unless the row's `check_available` is true (a failed solve that timed out and still holds a
  submission id); `ImageOut.check_available` is what the card draws the button from.
- `GET /images/{id}/objects`
- `GET/PUT /images/{id}/annotations`. `PUT` is the editor's autosave (debounced 500 ms): body = {style, labels,
  version as loaded}; `labels` must list every one of the image's objects exactly once (disable a label, never drop
  it), `style.font_file` must be bundled, colours are `#RRGGBB`, else a plain 422. Stored as `version + 1` with a
  fresh `updated_at`, and the stored document is the response. If the stored version differs from the submitted one:
  409 `This image was changed elsewhere. Reload to continue editing.` and nothing is written (a compare-and-swap in
  the database, so two editors cannot both win). 404 before the first solve, 409 while a solve is running. A failed
  re-solve leaves the previous layout editable. A stored style whose font is no longer bundled is served by GET with
  the built-in default (§ 9), so the editor's next autosave stores the resolved name.
- `POST /images/{id}/autoarrange` → the same document with every enabled label re-placed by the placer (§ 6.4, no
  fixed labels), same version, not stored; the editor applies it and autosaves. Validated like `PUT`, including the
  version check (409).
- `POST /images/{id}/export` {quality: int|null, scale} → {export_url, annotated_preview_url, width, height, bytes, exported_at, encoding};
  `quality: null` (the default) reuses the source JPEG's quantisation tables (§ 5.4). `GET /images/{id}/export` → file
- `GET /images/{id}/files/{original|preview|thumb|annotated-preview}` → the file itself
- `GET /fonts` → list of bundled fonts {file, family, weight, sample, ascents}; `ascents` is Pillow's ascent at
  every allowed size (index `size − 6`, sizes 6–200), which the editor adds to a label's `y` to draw on the
  canvas baseline where the export draws (§ 9). The files are served at `/fonts/<file>`
- `GET /health` (public, used by the Docker healthcheck) → {status, version, site_title, setup_required,
  authenticated, config_error, locked}; `config_error` is a fixed plain sentence about an unreadable
  `config.json` (details in the server log) and `locked` lists the field names pinned by environment
  variables, never their values, so the setup page can disable those inputs. Everything owner-facing
  (`nova_api_key_set`) lives in `GET /config`. Image payloads carry `original_format` (JPEG/PNG/TIFF) and the
  nova status/job-log URLs.

Public besides the two gallery routes: `/api/health`, the font files under `/fonts/`, and the SPA shell.

*M1 note:* `PUT annotations` and `autoarrange` arrive with the editor in milestone 3.

## 9. Fonts

Bundle 12 open-licence families as static TTFs in `fonts/`, checked into the repo with licences:
Inter, Roboto, Open Sans, Source Sans 3, Fira Sans, IBM Plex Sans, JetBrains Mono, Ubuntu, Manrope,
Roboto Condensed, Play, Source Serif 4. Regular + Bold weights; all OFL except Ubuntu (Ubuntu Font
Licence). Every family must cover Greek (Bayer letters), the middle dot and the apostrophe; a test
renders those glyphs in every file. `make fonts` refreshes the bundle from Google Fonts. Frontend loads
them via `@font-face` from `/fonts/`; server loads the same files with `ImageFont.truetype`.
Pillow lays text out with its raqm engine (kerning); the Docker image installs libfribidi for
it, and the parity test asserts the engine is present. The
render contract is pinned by `tests/fixtures/render/vectors.json` (`make render-vectors`): text boxes,
line heights, alias sizes, ascents, leader segments and anchor boxes that `render.py` computes for real
label strings from the nova fixtures, in every bundled font. `backend/tests/test_render_parity.py` and
`frontend/src/editor/metrics.test.ts` replay it exactly. The browser measures text with
`textRendering: geometricPrecision` and must return every vector string's width within 0.5 px of
Pillow's; the editor's rendering of the e2e field may differ from the server's annotated preview in at
most 1 % of pixels by more than 48 (of 255) in any channel (`frontend/e2e/parity.spec.ts`).
Box widths are rounded up to whole pixels, so a difference under 0.5 px can still move a box edge, and
with it a leader endpoint, by one pixel; the pixel budget allows for it.
A stored per-image
style whose `font_file` is no longer bundled renders, places and is served by `GET /annotations`
with the built-in default and a server-log warning naming the file; the stored row is left alone
until the editor next saves it.

## 10. Auth & lockout

- Single owner. Password hashed with the standard library's `hashlib.scrypt` (n=2^15, r=8, p=1, random
  32-byte salt), stored in `config.json` as `scrypt$n$r$p$salt$digest`; no bcrypt dependency.
- Session cookie `astrocaption_session`: HttpOnly, SameSite=Lax, Secure when behind HTTPS (`TRUST_PROXY=1`),
  30 days. The value is a stateless HMAC-SHA256 token (keyed by `session_secret` from `config.json`) over
  the issue time and a fingerprint of the password hash, so a password reset invalidates every session
  without a session table. SameSite=Lax plus JSON request bodies is the CSRF protection; there is no token.
- Rate limit login: 5 failures → 60 s cooldown, in-memory and global (one owner; per-IP is meaningless
  behind a proxy). A failed sign-in and the start of a cooldown are logged (never the password). The
  cooldown is shared with the password change, so a captured session can hold sign-in in cooldown;
  restarting the app (or the CLI reset) clears it. That is the trade for throttling both with one counter.
- `POST /logout` is client-side only: the design is stateless, so it clears the cookie and nothing more.
  It clears it only for a request that carries a valid session (a cross-site POST cannot, under
  SameSite=Lax, so a third-party page cannot force a logout); otherwise it is a 204 with no `Set-Cookie`.
  A token captured before logout stays valid until it expires (30 days) or the password changes, which
  re-keys every token. That is the trade for having no session table.
- Lockout recovery (`docs/LOCKOUT.md`): `docker compose exec app python -m app.cli reset-password`
  prompts for a new password and rewrites the hash in `config.json`. Also documents deleting
  `config.json` to re-run setup while keeping images (images are not tied to the password).
- Setup route is only reachable when `config.json` has no password hash (absent file, or a file with only
  a key/title). The password is changed from the config page (`POST /password`: current password checked
  through the sign-in limiter, new one through the same 8–1024 rule, every other session re-keyed, the
  changing session's cookie re-issued); the CLI is the lockout path.
- A new password is 8 to 1024 characters wherever it is chosen (setup page, `ASTROCAPTION_PASSWORD`,
  CLI, config page); the CLI refuses to write a `config.json` owned by another user and says which command to run
  as whom, so a reset can never leave the app unable to read its own config.

## 11. Docker & distribution

- Image: `ghcr.io/ddovidenko/astrocaption:<tag>` and `:latest`. Multi-arch (amd64, arm64) so it runs on a Pi/NAS.
- `compose.yml` in repo root:
  ```yaml
  services:
    app:
      image: ghcr.io/ddovidenko/astrocaption:latest
      ports: ["8080:8000"]
      volumes: ["./data:/data"]
      environment:
        - TRUST_PROXY=0
      restart: unless-stopped
  ```
- Env vars override config for headless installs: `ASTROCAPTION_PASSWORD` (setup only), `NOVA_API_KEY`,
  `ASTROCAPTION_MAX_UPLOAD_MB`, `ASTROCAPTION_SITE_TITLE`, `ASTROCAPTION_DATA_DIR` (default `/data`).
- `NOVA_API_KEY` also accepts the alias `ASTROMETRY_API_KEY`. `compose.yml` lives in the repo root and carries a
  `build:` block so a clone can `docker compose up --build`; the release workflow (milestone 6) attaches it as-is.
- Healthcheck on `/api/health`. Non-root user in container.
- `docs/INSTALL.md`: three commands to a running instance; reverse-proxy examples for Caddy and nginx.

## 12. GitHub repo & CI

Public repo. Using GitHub Pro where useful:

- **Branch protection on `main`**: PR required, CI green required, linear history.
  *Current state:* the repository allows squash merges only, so history is linear already; the PR-required
  and CI-green rules are switched on in milestone 6.
- **Actions**:
  - `ci.yml` on PR: lint, backend tests, frontend tests, docker build (no push), and a browser
    smoke test against the built image with a fake nova.
  - `release.yml` on tag `v*`: build multi-arch image, push to GHCR, attach `compose.yml` and a
    changelog to the GitHub Release. Uses `docker/build-push-action` with layer cache.
  - `dependabot.yml`: weekly pip, npm, actions, docker updates.
- **Codespaces** devcontainer (`.devcontainer/`) so contributors get `make dev` with zero setup. Pro includes monthly hours.
- **Issues** templates: bug, solve-failure (asks for nova job URL), feature.
- **Discussions** enabled for self-hoster Q&A. Wiki off; docs live in `docs/`.
- Releases: semver tags. `main` is always deployable; `latest` image tracks the newest tag, not `main`.
- Licence: MIT for the code; fonts carry their own OFL/Apache notices in `fonts/LICENSES/`.

## 13. Milestones

Build in this order; each is shippable.

1. **Solve & render (CLI parity)** — backend upload, nova solve, objects stored, Pillow export with auto-placement. No editor yet; a plain page shows the export. Docker image builds. *Proves the core.* **Done 2026-09-07.**
2. **Setup & auth** — first-run setup, login, config page, lockout CLI, INSTALL.md, browser smoke test in CI. *Design approved 2026-09-08.*
3. **Editor v1** — canvas with zoom/pan, object list with checkboxes, hover/click to enable, drag labels, autosave, export button. Parity test between Konva and Pillow.
4. **Styling** — fonts, colours, halo, per-label overrides, wheel-to-resize while dragging, undo/redo.
5. **Gallery** — publish toggle, public gallery with hover overlay, responsive.
6. **Release** — GHCR multi-arch, release workflow, Codespaces, issue templates, README with screenshots.

Later (not v1): local ASTAP solver option, custom object entries (user-added labels at arbitrary RA/Dec or pixels), constellation lines, SVG/PNG-with-alpha export, multiple owners.

## 14. Open questions

- Nova rate limits: undocumented; we serialise solves (one at a time) and cache job results forever. Confirm behaviour under a burst of 5 uploads. (#56)
- Object list size: wide fields can return 500+ HD stars. Decided 2026-09-11 (#37): `hd` entries are hidden by default and shown by the object list's type filter; a bright star that nova lists twice, as `bright` and as `hd` at the same pixel, keeps both rows (flagging the twin is post-v1 polish). The filter is tested against `tests/fixtures/nova-narrow/`: 8 objects, 5 `hd`, 3 labels enabled. (nova adds `hd` entries only to fields of about 1° radius or less: the 2.4° Orion recording has none.)
- Touch support in the editor: out of scope for v1, but Konva makes pinch-zoom cheap. Revisit after milestone 5 (#57).
