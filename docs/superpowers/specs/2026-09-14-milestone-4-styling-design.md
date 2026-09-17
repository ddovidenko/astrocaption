# Milestone 4: Styling — design

Approved 2026-09-14. Implements SPEC.md § 13 item 4 ("fonts, colours, halo, per-label overrides,
wheel-to-resize while dragging, undo/redo") plus the § 6.2 / § 6.3 items deferred from milestone 3
(per-label toolbar, double-click text edit, shift-click multi-select, pinned labels, OpenNGC types) and
issues #13 #14 #62 #63 #64 #73 #75 #76 #77 #78.

## Scope

In: Style tab, per-label overrides with a floating toolbar, wheel-to-resize, double-click text edit,
undo/redo, shift-click multi-select, pinned labels, OpenNGC kinds in the Objects tab, alias policy,
leader avoidance, the deferred editor issues above.

Out (unchanged): server-side history, touch support (#57), Firefox fallback (#72), the gallery (M5).

## Decisions

1. **Name ranking is ported to TypeScript** and pinned with vectors generated from the Python module,
   rather than re-fetching objects on a preference change. Both renderers need the same ranking for
   the alias policy anyway.
2. **Undo history holds document snapshots** (labels map + style), not inverse commands. The
   document is small and the store already builds new immutable maps.
3. **Per-label controls live in a floating toolbar over the canvas**, as SPEC § 6.2 says, not in the
   Style tab.
4. **Undo/redo is in-browser, per editing session.** Nothing on the server. SPEC § 7's remark about
   `version` naming undo history files is dropped.

## A. Editor state, undo, per-label editing

### Document changes

`store.ts`'s `changed(s, labels)` becomes `changedDoc(s, patch, { commit })`, where `patch` may
carry `labels` and/or `style`. Every document mutation goes through it. It refuses (returns `{}`)
while the document is not editable: a solve in `pending`/`solving`. A conflict does not stop editing, only saving (SPEC § 6.3); it does clear the history. The
`isEditable` predicate moves into `store.ts`.

`commit: false` is used only by drag-move frames: the labels map is replaced so the canvas
follows the pointer, but `changeSeq`, `pendingChanges`, the dirty flag and the history are
untouched. Drag-end, toolbar edits, style edits, toggles, bulk enable, undo/redo and auto-arrange
results commit.

### Undo/redo

State gains `undo: Snapshot[]` and `redo: Snapshot[]`, `Snapshot = { labels, style }`, capped at 100
entries (oldest dropped). A commit pushes the pre-change snapshot onto `undo` and clears `redo`.
`undoLast()` / `redoLast()` move one snapshot across and commit the restored document, so autosave
sees it as an ordinary change. Selection and view are not part of history. `load()` and
`markConflict()` clear both stacks.

Keys: `Ctrl+Z` undo, `Ctrl+Y` and `Ctrl+Shift+Z` redo (`Cmd` on macOS). Ignored while an input,
textarea or select has focus. The toolbar shows Undo/Redo buttons with tooltips and disabled states.

### Selection

`selectedId: number | null` becomes `selectedIds: Set<number>`. Click selects one; shift-click
toggles membership; clicking empty canvas or `Esc` clears. Dragging any selected label moves every
selected label by the same delta and commits once on drag-end. `Delete`/`Backspace` disables every
selected label in one commit.

### Per-label toolbar

An HTML overlay inside the canvas container, positioned above the union bounding box of the selected
labels (converted to screen space through the view transform, re-positioned on view change, kept
inside the viewport). Controls, left to right:

- font size stepper (6–200, blank when mixed; clearing returns the label to the global size),
- text colour (ColorField from the config page; a "use global" entry clears the override),
- aliases: inherit / on / off,
- leader: auto / on / off,
- pin toggle,
- Reset position: re-places the label with the browser placer (fixed obstacles = every other
  enabled label and every marker) and unpins it,
- Clear overrides: size, colour, aliases, leader, text override.

With several labels selected each control applies to all; a control whose values differ shows blank
(stepper) or "mixed" (selects). Every control commits one history entry per interaction.

Wheel with the left button held on a label changes that label's `font_size` by ±1 per notch,
clamped 6–200, live on the canvas, committed once when the button is released. The stage does not
zoom during this.

Double-click a label opens an inline text input over it (same font, size and screen scale). Enter
commits the trimmed text as `text_override`; blank clears it; `Esc` cancels.

### Pinned labels

`Label.pinned: bool = False` (server model, `extra="forbid"` stays). Set by drag-end and by any
toolbar edit that moves the label; cleared by Reset position and by Reset positions. Server
`POST autoarrange` treats pinned labels as fixed obstacles (existing `fixed_boxes`/`fixed_circles`
path) and places only the rest; `reset=true` (the Layout tab's "Reset positions") clears every pin
first and places all. Initial placement and re-solve are unchanged (nothing is pinned yet, and
re-solve already keeps the owner's layout). The Layout tab explains the difference in one line.

### Store hygiene (#75, #78)

- "Enable shown" computes every new placement against a growing obstacle set
  (`placeNewLabel` takes explicit fixed boxes/circles) and applies once with `applyLabels`: one
  commit, one undo entry, no half-applied document on a thrown measurement.
- Space-held pan becomes render state; label shapes get `draggable={editable && !spacePan}` so Konva
  never starts a drag during a pan. `suppressDragRef` and the label's `cancelBubble` go away.
- `applyLabels` throws on an id the editor does not hold.
- `autosave.ts` keeps its single controller (one editor per page); noted, not changed.

## B. Shared render contract

### Name ranking in TypeScript (#64)

`frontend/src/editor/names.ts` ports `name_category`, `primary_name` and the two rankings from
`backend/app/models.py` verbatim (same regexes, same tie rule: nova's original order).

`make names-vectors` (new; `backend/scripts/make_names_vectors.py`) writes
`tests/fixtures/names/vectors.json`: for every `catalog_names` list in both nova fixtures plus a
hand-written edge set (Greek Bayer letters, Flamsteed numbers, HD/HIP twins, unknown prefixes,
multi-word common names, leading/trailing spaces), the category of each name and the primary and
alias lists under both preferences and every `max_aliases` value 0–5. `names.test.ts` and
`backend/tests/test_names_vectors.py` replay it and fail while stale.

`metrics.ts`'s `labelText` takes the store's `style.name_preference` and `max_aliases` and the
object's raw `catalog_names`; `ObjectOut.primary_name` stays for the Objects tab list only and is
ranked under the stored preference as today.

### Alias policy (#13)

Both renderers, identically:

1. Aliases are the object's names minus the primary.
2. Names in the `star` category (HD, HIP, SAO, …) and the `designation` category (unknown
   abbreviations) are dropped when at least one alias of any other category exists.
3. A `common` name whose text is contained in another `common` name of the same object
   (case-insensitive, whole string) is dropped: "Orion Nebula" inside "Great Orion Nebula".
4. Order: `common` names first, in nova's order; then every other category in the primary-name
   ranking order for the current preference, ties in nova's order.
5. The first `style.max_aliases` survive. `max_aliases: int = Field(2, ge=0, le=5)` joins
   `StyleConfig`, the config page's `default_style` and the Style tab; `show_aliases=False` or
   `max_aliases=0` both mean no alias line.

M 42 under `popular` therefore reads "M 42" over "Great Orion Nebula · NGC 1976"; M 45 reads
"M 45" over "Pleiades · Mel 22". Decided 2026-09-14: the primary line already carries a catalogue
id, so the common name is worth more on the alias line than the NGC cross-reference. Render vectors
are regenerated and `test_render_parity.py` / `metrics.test.ts` / `parity.spec.ts` pin it.

### Name preference on the config page (#73)

The explicit "Messier, Caldwell, Sharpless, Barnard first" entry duplicates "Default (…)" when the
built-in is `popular`. The config dropdown shows "Default (…)" plus only the value that differs from
the default, matching the tri-state pattern of the halo and alias fields. The Style tab lists both
values by name.

### Leader avoidance (#14)

Today the leader runs from the marker edge to the nearest point of the text box. New rule, both
renderers, pinned by render vectors:

1. Candidate endpoints on the text box, in order: nearest point (today's), the four edge midpoints
   (top, right, bottom, left), the four corners (top-left, top-right, bottom-right, bottom-left).
2. A candidate is rejected if the segment from the marker edge to it passes within `r + pad` of
   the centre of any *other* enabled object, where `r = max(catalogue radius, marker_min_radius)`
   (the drawn ring) and `pad` is the placer's `4·s`. Only rings block, as in the placer; text
   boxes do not.
3. The first accepted candidate wins; if none is accepted the nearest point is used.
4. `leader_visible` (the `auto` gap rule) is evaluated on the chosen segment.

Vectors gain a crowded-core case (Trapezium region of the Orion fixture) where the nearest point is
rejected.

### Fonts in the editor (#62, #63)

- `fonts.resolve_font_file` on the server resolves against `{f.file for f in list_fonts()}` so one
  predicate is authoritative; `list_fonts`' skip log then covers the diverging case.
- The store resolves `style.font_file` against the fonts map from `GET /fonts` at load and on every
  style change. A file not in the map renders with the built-in default and sets
  `fontFallback: { stored: string; used: string }`; the Image tab and the Style tab show
  "This image was set up with X, which is no longer bundled; labels use Y until you pick a font."
  The first save writes the resolved name and clears the notice.
- The canvas never builds `@font-face` or `ctx.font` from any source other than the store's
  resolved style; `metrics.ts` says so in its header comment.
- Picking a font in the Style tab awaits `loadBundledFont` before `changedDoc` commits; while
  loading the select is disabled and the preview shows the previous font. A load failure keeps the
  previous font and shows the loader's sentence under the field.

## C. Style tab, Objects tab, notices

### Style tab

`frontend/src/style/StyleForm.tsx` (moved out of `ConfigPage.tsx`, with `ColorField`,
`LabelPreview` and `configForm.ts`) renders the form in two modes:

- `overrides` (config page): each field has a "Default (…)" entry and the value may be empty.
- `values` (editor): every field holds a concrete value; no default entries.

Fields in order: font, font size, primary name preference, alias line, max aliases, text colour,
marker colour, leader colour, halo, halo colour, halo width, marker width, marker minimum radius.
The live LabelPreview sits above the fields as on the config page.

In the editor every field change calls `setStyle(patch)` → `changedDoc` with `commit: true`; a
colour drag in ColorField commits on pointer-up, not per frame. The canvas re-measures when
font, size, name preference, alias line or max aliases change. A "Reset to site defaults" button
applies `config.default_style` merged over the built-ins (fetched once on tab open) as one commit.

### Objects tab

- `build_names_catalog.py` also writes a `kinds` map (`{"NGC 1976": "nebula", …}`) from OpenNGC's
  Type column: galaxy (G, GPair, GTrpl, GGroup), nebula (Neb, EmN, RfN, HII, PN, SNR, DrkN,
  Cl+N (a cluster with nebulosity: M 42, the Cocoon; decided 2026-09-17 during PR 5)),
  cluster (OCl, GCl), other (everything else, including `*`, `**`, `*Ass`, `Nova`, `NonEx`).
  `names.json` becomes `{"aliases": [...], "kinds": {...}}`; `catalog/__init__.py` gains
  `kind_for(names) -> Kind | None`.
- `ObjectOut.kind: Literal["galaxy","nebula","cluster","star","other"]`, computed at read time: `star`
  for nova `bright`/`hd` rows, the catalogue kind for rows with an NGC/IC name, else `other`. No
  migration.
- The type filter becomes galaxy / nebula / cluster / star / other checkboxes plus the existing
  "HD stars" toggle (unchecked by default, #37) that gates `hd` rows inside `star`.
- `ObjectRow` is memoised with per-row selectors (`labels.get(id)?.enabled`, `hoveredId === id`,
  `selectedIds.has(id)`); `bulk()` reads `getState()` at click time.
- Keyboard focus on a row highlights the row and its marker like hover.
- Tablist: arrow-key roving focus, the panel is focusable, `aria-controls` is omitted while
  collapsed. Tab bodies stay mounted (hidden with `hidden`) so an in-flight export survives a tab
  switch.
- While a solve is running the marker hit circles use a `not-allowed` cursor.

### Notices (#77)

- Canvas size error: "The editor could not size its canvas. Reload the page, or widen the window."
- Preview load error: a 401 says "Your session has expired. Log in again."; anything else says
  "The preview could not be loaded. Reload the page; if it keeps failing, re-upload the image."
- Label draw errors: count them, name the first object, say "the export may differ from this preview".
- Non-409 4xx on save: "This image's objects changed; reload the editor." with Reload.
- `placeNewLabel` no longer returns null; the fallback path marks the label `collided`.

## Data model and API changes

- `StyleConfig.max_aliases: int` (0–5, default 2).
- `Label.pinned: bool` (default false).
- `ObjectOut.kind`.
- `POST autoarrange` body gains `reset: bool = False` (clear pins first).
- `config.default_style` accepts `max_aliases`.
- Stored rows without the new fields load with the defaults (pydantic defaults; #69's tolerant
  loading stays in M6).

## Testing

- Unit (vitest): store history and commit semantics (drag coalescing, cap, clear on load/conflict),
  multi-select drag, toolbar mixed values, names port, alias policy, leader candidates, StyleForm
  in both modes, kind filter.
- Contract: `make placement-vectors`, `make render-vectors` (alias policy, leaders), new
  `make names-vectors`; replayed by pytest and vitest.
- Playwright: `parity.spec.ts` gains a document with a per-label size and colour override, a text
  override, a pinned label and a stored fallback font; new `styling.spec.ts`: Style tab change →
  canvas re-measures → Ctrl+Z restores → autosave lands.
- Pytest: pinned autoarrange (pinned label untouched, others placed around it; `reset` clears),
  `max_aliases` bounds, `kind` mapping, config default-style round trip with the new field,
  `resolve_font_file` against `list_fonts`.

## PR order

1. **Store groundwork** — `changedDoc`, commit/preview split, editable gate, undo/redo + keys +
   toolbar buttons, bulk enable as one transaction, Space-pan as state (#75 part, #78).
2. **Names and aliases** — TS port, names vectors, alias policy on both renderers, `max_aliases`,
   config dropdown change, regenerated render vectors (#13, #64, #73).
3. **Style tab** — shared StyleForm, editor mode, font swap with load await, fallback notice, server
   `resolve_font_file` change (#62, #63).
4. **Per-label editing** — multi-select, floating toolbar, wheel-to-resize, double-click text edit,
   pinned labels with the server autoarrange change, parity spec additions.
5. **Objects tab and notices** — OpenNGC kinds, filter, per-row selectors, accessibility, tab
   bodies kept mounted, wording (#75 rest, #76, #77).
6. **Leader avoidance** — both renderers, vectors, crowded-core case (#14).

Each PR: `make lint test`, `make e2e` where the browser is touched, SPEC.md updated, the owner's
smoke test on `make dev` before commit, and the review ritual from CLAUDE.md before the PR.

## SPEC.md updates (done per PR)

§ 6.2 and § 6.3 lose their M3 notes; § 6.2 gains the toolbar list, pinning, the alias policy and
the leader rule; § 6.3 gains the Style tab's field list, `max_aliases`, the kind filter and the
Layout tab's pin behaviour; § 7 gains `pinned`, `max_aliases`, drops the undo-history remark;
§ 8 gains `kind` and `reset`; § 13 marks milestone 4 in progress, then done.
