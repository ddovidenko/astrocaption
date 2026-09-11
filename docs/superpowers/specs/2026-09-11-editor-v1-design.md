# Editor v1 (milestone 3) — design

Implements SPEC.md § 6 (editor interactions, the M3 subset), § 7/§ 8 (annotations API), § 9 (fonts) and
the milestone-3 issues (#1 #9 #10 #12 #37 #43 #45 #52 #53 #55). Approved section by section on
2026-09-11. Scope decisions recorded before this design (M3 scope line, parity in Playwright,
konva/react-konva/zustand approved, #9 and #37 rulings) are taken as given.

## 1. Findings that shape the design (text-measurement spike, 2026-09-11)

Measured: 43 label strings from both nova fixtures, all bundled fonts, sizes 8–100, Pillow 12.3 with the
raqm layout engine against headless Chromium canvas.

- Default canvas text is hinted: `measureText` widths are whole pixels and drift from Pillow's
  `getlength` by up to 27 % at 8 px and 1 % at 100 px, and the drift depends on the viewer's OS.
  With `ctx.textRendering = 'geometricPrecision'` widths agree within 0.34 px at every size.
- Pillow's `draw.text((x, y))` puts `y` on the ascender line. Canvas text drawn with
  `textBaseline = 'alphabetic'` at `y + ascent`, where `ascent = font.getmetrics()[0]`, lands within
  1 px of Pillow's ink (2 px on one right edge). The ascent is FreeType fixed-point arithmetic;
  `ceil(hhea.ascender × size / upem)` is off by one at a few sizes, so the browser must not derive it.
- Lato, Montserrat, Nunito, Poppins and Raleway have no Greek glyphs. Pillow draws a box, the browser
  substitutes a system font, and Bayer names (θ1 Ori C) differ by 20–34 px between preview and export.
- The halo rule holds: a canvas stroke of `2 × halo_width` under the fill equals Pillow's
  `stroke_width`.

Decisions: the canvas measures widths itself with `geometricPrecision`; the server publishes Pillow's
ascent per integer size; the five Greek-less families leave the bundle.

## 2. Font bundle (SPEC § 9)

Out: Lato, Montserrat, Nunito, Poppins, Raleway. In: Ubuntu, Manrope, Roboto Condensed, Play,
Source Serif 4 (Regular + Bold static TTFs from the Google Fonts CSS API, `latin, latin-ext, greek,
cyrillic` subsets, verified to contain θ ι υ λ μ, the middle dot and the curly apostrophe). Twelve
families remain. All are OFL except Ubuntu (Ubuntu Font Licence); `fonts/LICENSES/` and
`fonts/README.md` say so and SPEC § 9 is reworded.

`GET /api/fonts` entries gain `ascents: list[int]`, index `size − 6` for sizes 6–200
(`MIN_FONT_SIZE`–`MAX_FONT_SIZE`), computed from `load_font(...).getmetrics()[0]` on first request and
cached per fonts directory. A pytest asserts the table equals the renderer's metrics for every font and
size.

## 3. Editor page and canvas (SPEC § 6.1, § 6.2)

**Route.** `/images/:id`, owner-only, entered from an "Edit" button on each solved image card.
Full-viewport layout: slim top bar (site title, "Images" back link, save status, Export button), canvas
filling the rest, 320 px side panel on the right that collapses to a strip.

**Data on load.** `GET /images/{id}`, `/objects`, `/annotations`, `/fonts`. Fonts load via the
`FontFace` API from `/fonts/<file>` before the first draw; the CSS family name is the file stem
(`fontFamilyFor` in `labelPreview.ts`). The page shows a plain error and no canvas if any of the four
fails.

**One world, one transform.** Stage world units are original image pixels. The 2048-px preview is drawn
scaled to `width × height`, so markers, labels and leaders use stored coordinates directly. Zoom and
pan are one stage scale + offset. Wheel zooms about the cursor; drag on empty canvas, middle button,
or space+drag pans. `F` fits, `1` is one original pixel per screen pixel (the preview looks soft past
its own resolution; accepted).

**Label drawing** per enabled label:

- marker: `Konva.Circle`, radius `max(catalogue radius, style.marker_min_radius)`, stroke
  `marker_color` at `marker_width`;
- leader: `Konva.Line` from the marker edge to the closest point of the text box (`leader_segment`),
  drawn when `leader_visible` says so (`auto`: gap > `12·s`, `s = max(W, H) / 1000`);
- text: a custom `Konva.Shape` (`LabelTextShape`), not `Konva.Text`. Its `sceneFunc` sets
  `textRendering = 'geometricPrecision'`, `textBaseline = 'alphabetic'`, `font = "<size>px <stem>"`;
  strokes the halo (`lineWidth = 2 × halo_width`, `lineJoin = 'round'`, `strokeStyle = halo_color`) under
  the fill; draws the primary line at `(x, y + ascent(size))` and the alias line at
  `(x, y + line1_height + ascent(alias_size))`. Its `hitFunc` fills the text box rectangle. Colour is
  `label.color ?? style.text_color`.
- collided badge: a small warning glyph at the box's top-right when `label.collided`.

**Shared metrics module** `frontend/src/editor/metrics.ts`, pure functions mirroring
`backend/app/render.py`: `aliasFontSize`, `lineHeight`, `markerRadius`, `labelText` (name
preference, override, aliases joined by ` · `), `measureLabel(ctx, fonts, style, label, obj)` →
`{width, height, primarySize, aliasSize, line1Height, line2Height}`, `leaderSegment`,
`leaderVisible`, plus the placer's `anchorBox` for client-side first placement. Widths come from a
shared offscreen 2D context with `geometricPrecision`; ascents from the font list. The module is the
only place the canvas and the tests read layout numbers from.

**Hover targets.** Every object, enabled or not, has an invisible hit circle (radius
`max(marker radius, 8 / zoom)` in world units). Hover draws a subtle ring and a name tooltip
(HTML overlay positioned from stage coordinates); hovering a row in the object list highlights the
same way.

**State.** One zustand store (`frontend/src/editor/store.ts`): `image`, `objects` (by id), `style`,
`labels` (by object id, insertion order kept for save), `version`, `selectedId`, `hoveredId`,
`view {scale, x, y}`, `save {status: 'saved' | 'dirty' | 'saving' | 'error' | 'conflict', message}`.
Actions: `load`, `toggleObject`, `moveLabel`, `select`, `hover`, `setView`, `applyLabels` (from
autoarrange / reset), `markSaved`, `markConflict`. Canvas nodes subscribe per label.

## 4. API and persistence (SPEC § 7, § 8)

- `PUT /api/images/{id}/annotations` body = the `Annotations` document the editor holds (style, labels,
  `version` as loaded). Server: image must be solved; every `label.object_id` must be one of the
  image's objects and appear once; `style.font_file` must be bundled. Stored with `version + 1` and
  a fresh `updated_at`; the stored document is the response. If the stored version differs from the
  submitted one: 409, `detail: "This image was changed elsewhere. Reload to continue editing."`, nothing
  written.
- `POST /api/images/{id}/autoarrange` body = the same document; runs `autoplace` on every enabled
  label with no fixed labels; returns the placed document (same version, not stored). The editor
  applies it and autosaves. "Reset positions" is the client putting every enabled label at its object's
  `(x, y)` with `collided = false`, then calling autoarrange: the initial layout, reproduced.
- Export from the editor: flush the pending save (await the PUT), then `POST /export` as today; the
  Image tab shows the result and the download link.
- 422 handler (#45): messages are built from `error["type"]` through a table for the types the models
  use (`missing`, `string_too_long`, `int_parsing`, `greater_than_equal`, `less_than_equal`,
  `literal_error`, `value_error` → a generic sentence, …), never from `msg`; a test plants a validator
  that raises `ValueError(f"bad {value}")` on a throwaway model and asserts the value is absent from
  the response.
- Radius-0 rule (#9): `default_enabled` returns true for non-stellar types with `radius == 0` (nova
  reports no size, not "tiny"); the `≥ 0.4 % of width` rule applies only when a radius is known.
- No schema change. The annotations table already holds style, labels, version.

## 5. Interactions and side panel (SPEC § 6.1–§ 6.3, M3 subset)

- **Toggle by click** on an object's hit circle. Enabling a label with no stored position (or one
  disabled at its object position) places it client-side with the placer's anchor search against the
  current enabled boxes, so it appears at once; the autosave persists it. Disabling keeps the
  position, so re-enabling restores it.
- **Select and drag.** Click a label to select (thin outline around the text box). Left-drag moves it
  freely in original pixels; leader and badge update live; the store's `collided` is cleared on the
  first move (the owner has placed it). Dragging past the frame is allowed (Pillow clips identically).
- **Keys** (ignored while an input has focus): `Esc` deselect, `Delete`/`Backspace` disable the
  selected label, `F` fit, `1` 100 %.
- **Autosave.** Any change sets `dirty` and schedules a PUT 500 ms after the last change; a save in
  flight defers the next one until it returns. Status in the top bar: "Saved", "Saving…", or the
  failure sentence with Retry. 409 → `conflict`: "This image was changed elsewhere" with a Reload
  button; editing continues locally but no further saves are attempted until reload.
  `beforeunload` warns while dirty or saving.
- **Objects tab.** Search box; type filter chips (galaxy, nebula, cluster, star, other, hd) with `hd`
  off by default (#37; both HD-twin rows stay); list rows: checkbox, primary name, type, radius in px.
  Bulk: "Enable shown", "Disable shown". Row hover highlights on canvas; clicking the name pans to the
  object. Tested against `nova-narrow` (8 objects, 5 `hd`, 3 enabled by default).
- **Layout tab.** "Auto-arrange" (all enabled labels) and "Reset positions" (confirm, then the reset
  flow above). Shows the count of collided labels.
- **Image tab** (read-only in M3): field centre, size, rotation from `calibration`; nova status link
  (#1); export button result with download link. Publish, re-solve and delete stay on the image card.
- **Deferred to M4**: Style tab, per-label toolbar, double-click text edit, multi-select,
  wheel-to-resize, undo/redo.

## 6. Parity and other tests (CLAUDE.md hard rule, #55)

- `tests/fixtures/render/vectors.json`, generated by `make render-vectors` from Python
  (`backend/scripts/make_render_vectors.py`): for a grid of fonts × sizes × real strings the text box,
  line heights, alias size, ascents; for a set of (marker, box) pairs the leader segment and its
  visibility; for a few labels the anchor boxes. `backend/tests/test_render_parity.py` pins
  `render.py` to the file; `frontend/src/editor/metrics.test.ts` pins the TypeScript module for
  everything that needs no browser.
- `frontend/e2e/parity.spec.ts`: (a) measures every vector string on a canvas with
  `geometricPrecision` and asserts `|width − pillow| ≤ 0.5 px`; (b) opens the editor on the solved
  e2e fixture, fits, exports the stage to PNG at the annotated preview's size, fetches
  `annotated-preview` from the server, and counts pixels whose max channel difference exceeds a
  threshold; passes when the differing fraction is below a limit; writes the diff image as a test
  artifact on failure. Thresholds start at 48/1 % and are tightened once measured.
- Store and interaction logic in vitest (toggle, move, autosave scheduling, 409, filter/search).
- Smoke spec gains: open the editor, toggle an object, drag a label, export. #52 (dev-proxy project)
  and #53 (fake-nova failure mode) ride in the same suite.

## 7. The rest of milestone 3

- **Image card actions.** #1 nova submission link + "AstroCaption cannot delete it for you."; #10
  "Check again" on a failed row with stored nova ids (row → `solving`, worker resumes polling, no
  upload); #12 upload progress bar (XHR upload events, no dependency) and in-page delete confirmation.
- **Password change** (#43): config page form (current, new, new again); `POST /api/password`
  verifies the current password, writes through `set_owner_password`, re-issues the session cookie in
  the response; shared `validate_new_password`; CLI remains the lockout path.
- **e2e** #52, #53 as above.

## 8. PR order

1. `chore: font bundle` — swap, licences, README, SPEC § 9.
2. `feat: render contract` — ascents in `/fonts`, render vectors + `make render-vectors`,
   `metrics.ts` + vitest, `test_render_parity.py`, #45, #9.
3. `feat: annotations API` — PUT with version conflict, autoarrange, tests.
4. `feat: editor canvas` — route, store, font loading, stage, `LabelTextShape`, zoom/pan,
   `parity.spec.ts`.
5. `feat: editor interactions` — toggle, select, drag, keys, autosave, tabs, export, smoke step, #37.
6. `feat: image card actions` — #1, #10, #12.
7. `feat: password change` — #43.
8. `test: e2e extensions` — #52, #53.

PRs 6–8 are independent of the editor and may be reordered. Each PR: `make lint test`, the review
ritual (`/code-review high`, silent-failure pass, `/simplify`), owner smoke test on `make dev`, explicit
"merge" from the owner.

## 9. Out of scope

Touch input, Style tab and every M4 item, custom labels, constellation lines, gallery changes.
