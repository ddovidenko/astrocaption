# Milestone 4 PR 3: Style Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The editor gets a Style tab that edits the image's global style live (one undo entry per change, autosaved), built from the same form the config page uses; a style whose font is no longer bundled renders with the default and tells the owner; the preview's font-size control visibly scales the text.

**Architecture:** The config page's style form, colour field and preview move to `frontend/src/style/` and become `StyleForm` with two modes: `overrides` (blank = default, the config page) and `values` (every field concrete, the editor). The store already commits style patches through `setStyle`; the Style tab keeps a string-form draft, validates each field against the API bounds, awaits the font load before committing a font, and commits colours on picker close. Server side, one predicate decides which fonts are usable (`list_fonts`), `GET /annotations` names the stored font it replaced, and a new `GET /images/{id}/default-style` computes the size-relative site defaults for one image.

**Tech Stack:** FastAPI + pydantic + pytest; React 19 + TypeScript strict + Zustand + react-colorful; vitest; Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md` § B "Fonts in the editor" and § C "Style tab"; issues #62, #63, #93. SPEC.md § 6.3 (Style tab), § 9 (font fallback).

## Global Constraints

- Preview and export must produce the same layout. This PR changes no geometry, metrics or renderer code; the render and names vectors stay untouched. The canvas re-measures automatically when the store's `style` object changes (`entryCache` in `EditorCanvas.tsx` is keyed on style identity).
- The canvas never builds `@font-face` or `ctx.font` from any style source but the store's resolved style (#62). A font is committed to the store only after `loadBundledFont` resolved; the select is disabled while loading; a load failure keeps the previous font and shows the loader's sentence.
- One server predicate for usable fonts: `fonts.resolve_font_file` resolves against `{f.file for f in list_fonts(fonts_dir)}` (#63). `GET /annotations` returns a listed font always; when it replaced the stored one it says which in `font_fallback`.
- Fallback wording (both tabs): "This image was set up with {stored}, which is no longer bundled; labels use {used} until you pick a font. The next save keeps {used}."
- Style tab field order: font, font size, primary name, alias line, aliases shown (max), text colour, marker colour, leader colour, halo, halo colour, halo width, marker line width, marker min radius. Bounds: font size 6–200, halo width 0–40, marker width 1–40, marker min radius 1–400, max aliases 0–5.
- Every Style-tab edit is one `setStyle` commit (one undo entry); a colour drag commits on picker close, not per frame. Edits are refused while the document is not editable (the store's gate), and the tab's controls are disabled then.
- Settled UI patterns: 680 px column, `.field` rhythm, `ColorField` (react-colorful, never the OS dialog), `LabelPreview`; no restyling beyond what the tab needs.
- Preview (#93): text size = `PREVIEW_SIZE × fontSize / ASSUMED_FONT_SIZE`, clamped to 12–40 px; halo and marker widths keep their ratio to the *drawn* size; the ring radius stays fixed.
- API responses and the page never carry raw exception text; pydantic models for every response; `extra="forbid"` stays.
- No new dependencies. Conventional one-line commit subjects; end every commit message with the attribution trailer the session reminder gives.
- Never run `npm ci`/`npm install`/`make install FORCE=1`; never touch `data/`; never restart the dev unit. `make lint test` and `make e2e` are the gates.

---

## File structure

| File | Responsibility after this PR |
|---|---|
| `backend/app/fonts.py` | `resolve_font_file` resolves against `list_fonts` |
| `backend/app/models.py` | `Annotations.font_fallback`, `AnnotationsUpdate.font_fallback` (accepted, never read) |
| `backend/app/api/images.py` | GET annotations sets `font_fallback`; new `GET /{image_id}/default-style` |
| `backend/tests/test_fonts.py`, `test_api.py` | predicate unification, fallback field, default-style route |
| `frontend/src/api.ts` | `Annotations.font_fallback`, `api.imageDefaultStyle(id)` |
| `frontend/src/editor/fonts.ts` | `DEFAULT_FONT_FILE` mirror |
| `frontend/src/editor/load.ts` | resolves an unlisted font to the default instead of throwing; carries `fontFallback` |
| `frontend/src/editor/store.ts` | `fontFallback` state, cleared by `markSaved` and by a font change |
| `frontend/src/style/styleForm.ts` | `StyleForm` type, converters (from overrides, from a `StyleConfig`), `PREFERENCE_LABELS`, `otherPreference`, `normalizeHex`, `BOUNDS`, `parseField` (moved from `pages/configForm.ts`) |
| `frontend/src/style/ColorField.tsx`, `LabelPreview.tsx`, `labelPreview.ts` | moved from `pages/`; `ColorField` gains `allowDefault` and `onCommit`; preview scales text (#93) |
| `frontend/src/style/StyleForm.tsx` | the shared form, two modes |
| `frontend/src/pages/configForm.ts`, `ConfigPage.tsx` | config-only logic (`buildUpdate`, `sameOverrides`); the page renders `StyleForm mode="overrides"` |
| `frontend/src/editor/StyleTab.tsx` | the editor tab: draft, validation, font await, reset to site defaults, fallback notice |
| `frontend/src/editor/SidePanel.tsx`, `ImageTab.tsx` | Style tab registered; fallback notice in the Image tab |
| `frontend/e2e/styling.spec.ts` | Style tab change → autosave → Ctrl+Z |
| `docs/SPEC.md` | § 6.3 Style, § 8 API, § 9 fallback |

---

### Task 1: Server — one font predicate, `font_fallback`, the per-image default style

**Files:**
- Modify: `backend/app/fonts.py:37-52` (`resolve_font_file`)
- Modify: `backend/app/models.py` (`Annotations`, `AnnotationsUpdate`)
- Modify: `backend/app/api/images.py:345-351` (`get_annotations`), new route after it
- Test: `backend/tests/test_fonts.py`, `backend/tests/test_api.py`

**Interfaces:**
- Produces: `Annotations.font_fallback: str | None = None` — the stored `font_file` when the served style's font replaced it, else `None`. `AnnotationsUpdate.font_fallback: str | None = None` (accepted so a GET body can be sent back; never read).
- Produces: `GET /api/images/{image_id}/default-style` → `StyleConfig` = `layout.default_style(rec.width, rec.height, settings.fonts_dir, settings.default_style)`; 404 with the existing not-found sentence for an unknown image. Owner-only like the other image routes (same router).
- `resolve_font_file(fonts_dir, file)` returns `file` iff `file in {f.file for f in list_fonts(fonts_dir)}`, else `DEFAULT_FONT_FILE` with the existing warning.

- [ ] **Step 1: Failing tests**

`backend/tests/test_fonts.py` — add (see how the existing tests build a fonts dir; `tmp_path` with copies of the bundled files is the pattern used by `test_resolve_font_file_logs_when_the_default_itself_is_missing`):

```python
def test_resolve_font_file_uses_the_font_list_as_the_one_predicate(tmp_path: Path) -> None:
    """A file that exists but that list_fonts skips (unreadable) resolves to the default (#63)."""
    fonts_dir = tmp_path / "fonts"
    fonts_dir.mkdir()
    shutil.copy(FONTS_DIR / DEFAULT_FONT_FILE, fonts_dir / DEFAULT_FONT_FILE)
    (fonts_dir / "Broken-Regular.ttf").write_bytes(b"not a font")
    list_fonts.cache_clear()
    resolve_font_file.cache_clear()
    assert [f.file for f in list_fonts(fonts_dir)] == [DEFAULT_FONT_FILE]
    assert resolve_font_file(fonts_dir, "Broken-Regular.ttf") == DEFAULT_FONT_FILE
    assert resolve_font_file(fonts_dir, DEFAULT_FONT_FILE) == DEFAULT_FONT_FILE
```

(`FONTS_DIR` is the repo's `fonts/`; import `shutil`, `list_fonts`, `resolve_font_file`, `DEFAULT_FONT_FILE` as the file already does or add them.)

`backend/tests/test_api.py` — extend the existing test around line 333 that stores `Lato-Regular.ttf` (read it first; it already asserts the GET serves the default). Add to it:

```python
    served = client.get(f"/api/images/{image_id}/annotations").json()
    assert served["style"]["font_file"] == "Inter-Regular.ttf"
    assert served["font_fallback"] == "Lato-Regular.ttf"
    # A GET body goes straight back: the server ignores font_fallback and stores the resolved font.
    saved = client.put(f"/api/images/{image_id}/annotations", json=served)
    assert saved.status_code == 200, saved.text
    assert saved.json()["font_fallback"] is None
    assert db.get_annotations(image_id).style.font_file == "Inter-Regular.ttf"
    assert client.get(f"/api/images/{image_id}/annotations").json()["font_fallback"] is None
```

and a new test:

```python
def test_default_style_for_an_image_is_size_relative_with_the_site_overrides(
    tmp_path: Path, sample_jpeg: Path
) -> None:
    # Use test_api.py's existing solved-image setup (the same one the Lato test above uses) and set
    # the site defaults through the API so no settings reload is needed:
    with solved_client(tmp_path, sample_jpeg) as (client, image_id, settings):
        assert client.put("/api/config", json={"default_style": {"text_color": "#ff8800", "max_aliases": 4}}).status_code == 200
        body = client.get(f"/api/images/{image_id}/default-style").json()
        rec = client.get(f"/api/images/{image_id}").json()
        expected = layout.default_style(rec["width"], rec["height"], settings.fonts_dir, {"text_color": "#ff8800", "max_aliases": 4})
        assert body == expected.model_dump()
        assert client.get("/api/images/nope/default-style").status_code == 404
```

`solved_client` stands for whatever `test_api.py` already uses to get a solved image with an authenticated client (read the Lato test and reuse its setup verbatim; do not invent a new fixture). Keep the assertion that the body equals `layout.default_style(...)` for the image's real width and height with the site overrides applied.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_fonts.py tests/test_api.py -q -k "predicate or default_style_for_an_image or Lato"`
Expected: FAIL — `font_fallback` missing, route 404/405, the broken font resolves to itself.

- [ ] **Step 3: Implement**

`fonts.py` `resolve_font_file`:

```python
@lru_cache(maxsize=512)
def resolve_font_file(fonts_dir: Path, file: str) -> str:
    """``file`` if it is a usable bundled font, else the built-in default with a warning.

    One predicate decides usability — ``list_fonts`` (readable at every size, so the ascent
    table exists) — for rendering, placement and the API alike (#63). Stored styles outlive
    the bundle; the warning names the file so the owner can pick another. Cached so a stored
    style with a gone font logs once per process.
    """
    usable = {f.file for f in list_fonts(fonts_dir)}
    if file in usable:
        return file
    log.warning("font %r is not bundled; using %s", file, DEFAULT_FONT_FILE)
    if DEFAULT_FONT_FILE not in usable:
        log.error("default font %s is missing from the fonts directory", DEFAULT_FONT_FILE)
    return DEFAULT_FONT_FILE
```

`models.py`: on `Annotations` add `font_fallback: str | None = None` with a comment "the stored font_file when `style.font_file` had to be replaced by the default (GET only)". On `AnnotationsUpdate` add `font_fallback: str | None = None  # the server's; accepted so a GET body can be sent back, never read`.

`api/images.py` `get_annotations`:

```python
    resolved = resolved_style(settings.fonts_dir, ann.style)
    fallback = ann.style.font_file if resolved.font_file != ann.style.font_file else None
    return ann.model_copy(update={"style": resolved, "font_fallback": fallback})
```

New route (after `get_annotations`):

```python
@router.get("/{image_id}/default-style")
async def image_default_style(image_id: str, settings: SettingsDep, db: DbDep) -> StyleConfig:
    """The style a fresh solve of this image would get: size-relative built-ins with the site's
    ``default_style`` on top. The Style tab's "Reset to site defaults" (SPEC § 6.3)."""
    rec = _get_or_404(db, image_id)
    return default_style(rec.width, rec.height, settings.fonts_dir, settings.default_style)
```

(import `default_style` from `..layout` and `StyleConfig` from `..models` if not already imported). Check `_get_or_404` returns the record; adapt if it only raises.

- [ ] **Step 4: Run the backend suite**

Run: `cd backend && .venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy app scripts tests`
Expected: all green. `test_render_parity.py` is unaffected (no renderer change).

- [ ] **Step 5: Commit**

```bash
git add backend/app/fonts.py backend/app/models.py backend/app/api/images.py backend/tests/test_fonts.py backend/tests/test_api.py
git commit -m "feat(api): one font predicate, font_fallback on GET annotations, per-image default style"
```

---

### Task 2: Editor load and store — resolve an unlisted font, carry the fallback

**Files:**
- Modify: `frontend/src/api.ts` (`Annotations`, `api.imageDefaultStyle`)
- Modify: `frontend/src/editor/fonts.ts` (`DEFAULT_FONT_FILE`)
- Modify: `frontend/src/editor/load.ts:24-31`
- Modify: `frontend/src/editor/store.ts` (`LoadedDocument`, state, `load`, `reset`, `markSaved`, `setStyle`)
- Modify: `frontend/src/editor/testDoc.ts`
- Test: `frontend/src/editor/load.test.ts`, `store.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_FONT_FILE = 'Inter-Regular.ttf'` in `fonts.ts` (mirror of `StyleConfig().font_file`; a vitest pins it against the render vectors' font list).
- Produces: `LoadedDocument.fontFallback: FontFallback | null` with `export interface FontFallback { stored: string; used: string }`; `EditorState.fontFallback: FontFallback | null`; `Annotations.font_fallback: string | null` in `api.ts`; `api.imageDefaultStyle(id: string): Promise<StyleConfig>`.
- Behaviour: `loadEditor` resolves in this order — server `font_fallback` (stored = it, used = `annotations.style.font_file`); else if `annotations.style.font_file` is not in the fonts list and `DEFAULT_FONT_FILE` is, the style's font becomes the default and fallback = `{ stored, used: DEFAULT_FONT_FILE }`; else (neither listed) the existing throw. `store.load` copies the fallback; `markSaved` clears it; `setStyle` with a `font_file` clears it.

- [ ] **Step 1: Failing tests**

`load.test.ts` — add, mocking `api` the way the file or `autosave.test.ts` does (`vi.mock('../api', ...)` returning `image`, `objects`, `annotations`, `fonts` from `makeDoc()`; stub `CanvasRenderingContext2D.prototype.textRendering = ''` and `loadFonts` via `vi.mock('./fonts', ...)` so no FontFace is needed):

```ts
  it('resolves an unlisted style font to the default and reports the fallback', async () => {
    const doc = makeDoc()
    mockApi({ ...doc, annotations: { ...doc.annotations, style: { ...doc.annotations.style, font_file: 'Gone.ttf' } } })
    const loaded = await loadEditor('img-1')
    expect(loaded.annotations.style.font_file).toBe('Inter-Regular.ttf')
    expect(loaded.fontFallback).toEqual({ stored: 'Gone.ttf', used: 'Inter-Regular.ttf' })
  })
  it('passes the server-reported fallback through', async () => {
    const doc = makeDoc()
    mockApi({ ...doc, annotations: { ...doc.annotations, font_fallback: 'Lato-Regular.ttf' } })
    expect((await loadEditor('img-1')).fontFallback).toEqual({ stored: 'Lato-Regular.ttf', used: 'Inter-Regular.ttf' })
  })
  it('still rejects when neither the style font nor the default is listed', async () => {
    const doc = makeDoc()
    mockApi({ ...doc, fonts: [{ ...doc.fonts[0]!, file: 'Other.ttf' }], annotations: { ...doc.annotations, style: { ...doc.annotations.style, font_file: 'Gone.ttf' } } })
    await expect(loadEditor('img-1')).rejects.toThrow('is not listed by the server')
  })
```

Write `mockApi(doc)` once at the top of the file with `vi.mock('../api', () => ({ api: { image: vi.fn(), objects: vi.fn(), annotations: vi.fn(), fonts: vi.fn() } }))` and set the resolved values per test; `vi.mock('./fonts', () => ({ loadFonts: vi.fn().mockResolvedValue(undefined), DEFAULT_FONT_FILE: 'Inter-Regular.ttf' }))`.

`store.test.ts` — add:

```ts
  it('carries the font fallback and clears it on save or on a font change', () => {
    const s = useEditor.getState()
    s.load({ ...doc, fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' } })
    expect(useEditor.getState().fontFallback).toEqual({ stored: 'Gone.ttf', used: 'Inter-Regular.ttf' })
    s.markSaving()
    s.markSaved(2, 't')
    expect(useEditor.getState().fontFallback).toBeNull()
    useEditor.getState().load({ ...doc, fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' } })
    useEditor.getState().setStyle({ font_size: 30 })
    expect(useEditor.getState().fontFallback).not.toBeNull()
    useEditor.getState().setStyle({ font_file: 'Inter-Regular.ttf' })
    expect(useEditor.getState().fontFallback).toBeNull()
  })
```

Add `fontFallback: null` to `makeDoc()`'s returned document and a vitest in `metrics.test.ts` or `store.test.ts`: `expect(vectors.fonts.some((f) => f.file === DEFAULT_FONT_FILE)).toBe(true)` (the render vectors already list every bundled font).

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/editor/load.test.ts src/editor/store.test.ts`
Expected: FAIL — `fontFallback` unknown, `loadEditor` throws for `Gone.ttf`.

- [ ] **Step 3: Implement**

`api.ts`: `Annotations` gains `font_fallback: string | null`; `AnnotationsUpdate` stays `Pick<Annotations, 'style' | 'labels' | 'version'>`; add `imageDefaultStyle: (id: string) => request<StyleConfig>(`/api/images/${id}/default-style`)` to `api`.

`fonts.ts`: `export const DEFAULT_FONT_FILE = 'Inter-Regular.ttf' // StyleConfig().font_file; pinned against the render vectors' font list in the tests`.

`load.ts` replace the `if (!fonts.some(...)) throw` block with:

```ts
  // A stored font the server no longer bundles: GET already swapped in the default and named
  // the stored one (#62); if the list and the style still disagree (#63), do the same here.
  const listed = (file: string) => fonts.some((f) => f.file === file)
  let annotations = raw
  let fontFallback: FontFallback | null = raw.font_fallback
    ? { stored: raw.font_fallback, used: raw.style.font_file }
    : null
  if (!listed(annotations.style.font_file)) {
    if (!listed(DEFAULT_FONT_FILE)) {
      throw new Error(
        `Font ${annotations.style.font_file} is not listed by the server.` +
          ' Open Config and save the label style to pick a bundled font.',
      )
    }
    fontFallback = { stored: annotations.style.font_file, used: DEFAULT_FONT_FILE }
    annotations = { ...annotations, style: { ...annotations.style, font_file: DEFAULT_FONT_FILE } }
  }
  await loadFonts([annotations.style.font_file])
  return { image, objects, annotations, fonts, fontFallback }
```

(rename the destructured `annotations` from `Promise.all` to `raw`; import `DEFAULT_FONT_FILE` from `./fonts` and `FontFallback` from `./store`).

`store.ts`: `export interface FontFallback { stored: string; used: string }`; `LoadedDocument.fontFallback: FontFallback | null`; `EditorState.fontFallback: FontFallback | null` (initial `null`); `load` sets `fontFallback: doc.fontFallback`; `markSaved` adds `fontFallback: null` to its patch; `setStyle`: after computing the patch, if `'font_file' in patch` add `fontFallback: null` (spread into the returned object; keep the `?? {}` shape).

- [ ] **Step 4: Run tests, types, lint**

Run: `cd frontend && npx vitest run && npx tsc --noEmit && npx eslint src`
Expected: PASS, clean. The `fontFor` "#63 message" test stays (the store still refuses a font its map lacks; resolution happens in `load`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.ts frontend/src/editor/fonts.ts frontend/src/editor/load.ts frontend/src/editor/store.ts frontend/src/editor/testDoc.ts frontend/src/editor/load.test.ts frontend/src/editor/store.test.ts
git commit -m "feat(editor): resolve a stored font the server no longer bundles and remember the fallback"
```

---

### Task 3: Extract the shared `StyleForm` (no behaviour change on the config page)

**Files:**
- Create: `frontend/src/style/styleForm.ts`, `frontend/src/style/StyleForm.tsx`
- Move (git mv): `frontend/src/pages/ColorField.tsx` → `frontend/src/style/ColorField.tsx`; `pages/LabelPreview.tsx` → `style/LabelPreview.tsx`; `pages/labelPreview.ts` → `style/labelPreview.ts`; `pages/labelPreview.test.ts` → `style/labelPreview.test.ts`
- Modify: `frontend/src/pages/configForm.ts` (keeps `ConfigForm`, `buildUpdate`, `sameOverrides`; imports the rest), `frontend/src/pages/configForm.test.ts`, `frontend/src/pages/ConfigPage.tsx`, `frontend/src/styles.css` (only if a selector moves; `.grid3`, `.field`, `.color-field`, `.preview` stay global)
- Test: `frontend/src/style/styleForm.test.ts` (new, the moved converter tests plus the new ones)

**Interfaces:**
- `styleForm.ts` produces: `type Tri`, `interface StyleForm` (unchanged shape), `styleFormFromOverrides(o: StyleOverrides): StyleForm`, `overridesFromStyleForm(f: StyleForm): StyleOverrides`, `styleFormFromConfig(c: StyleConfig): StyleForm` (every field as a string; `halo`/`show_aliases` as `'on' | 'off'`), `PREFERENCE_LABELS`, `otherPreference`, `normalizeHex`, `NUMBER_BOUNDS: Record<NumberKey, [number, number]>` = `{ font_size: [6, 200], halo_width: [0, 40], marker_width: [1, 40], marker_min_radius: [1, 400], max_aliases: [0, 5] }`, `type NumberKey`, `type ColorKey`, `type TriKey = 'halo' | 'show_aliases'`, and `parseNumberField(key: NumberKey, raw: string): number | null` (integer within bounds, else `null`).
- `StyleForm.tsx` produces:

```ts
// In StyleForm.tsx import the form-state type as `StyleFormValues` (`import { type StyleForm as
// StyleFormValues } from './styleForm'`): the component is also called StyleForm.
export interface StyleFormProps {
  mode: 'overrides' | 'values'
  values: StyleFormValues
  /** Built-ins shown for blank fields (overrides mode) and the preview's fallbacks. */
  defaults: StyleDefaults
  /** null: the font list could not be loaded. */
  fonts: FontOut[] | null
  disabled?: boolean
  /** Shown under the font select (a fallback notice, "Loading…", or a load error). */
  fontNote?: string | null
  onChange: <K extends keyof StyleFormValues>(key: K, value: StyleFormValues[K]) => void
  /** values mode only: a colour picker closed or a hex was typed — commit the current value. */
  onColorCommit?: (key: ColorKey) => void
  /** Rendered above the grid, after the preview (the config page's note; the Style tab's reset button). */
  children?: ReactNode
}
export default function StyleForm(props: StyleFormProps): JSX.Element
```

  Rendering rules by mode: `overrides` = today's config page exactly (Default entries, `placeholder`, tri-state selects, ColorField with the default chip and "Use default"). `values` = font select lists only the bundled fonts (plus the current value marked "(not installed)" if absent, so the select is never blank); number inputs `required`, no placeholder; tri selects offer On/Off only; name preference lists both values by name; `ColorField` gets `allowDefault={false}` (no chip, no "Use default") and `onCommit`.
- `ColorField` gains props `allowDefault?: boolean` (default `true`) and `onCommit?: () => void` (called from `close()`, from the click-away/blur paths, and after a typed hex).

- [ ] **Step 1: Move files and split the module**

`git mv` the four files. Create `styleForm.ts` by moving from `pages/configForm.ts`: `Tri`, `StyleForm`, `tri`/`str` helpers, `styleFormFromOverrides`, `num`/`bool`/`text`/`hex`, `overridesFromStyleForm`, `PREFERENCE_LABELS`, `otherPreference`, `normalizeHex`. Leave `ConfigForm`, `buildUpdate`, `sameOverrides` in `pages/configForm.ts`, importing what they need from `../style/styleForm`. Add to `styleForm.ts`:

```ts
export type NumberKey = 'font_size' | 'halo_width' | 'marker_width' | 'marker_min_radius' | 'max_aliases'
export type ColorKey = 'text_color' | 'marker_color' | 'leader_color' | 'halo_color'
export type TriKey = 'halo' | 'show_aliases'

/** The API's bounds (models.py), so the form never offers a value the server refuses. */
export const NUMBER_BOUNDS: Record<NumberKey, [number, number]> = {
  font_size: [6, 200],
  halo_width: [0, 40],
  marker_width: [1, 40],
  marker_min_radius: [1, 400],
  max_aliases: [0, MAX_ALIASES],
}

/** An integer inside the field's bounds, or null while the text is not one. */
export function parseNumberField(key: NumberKey, raw: string): number | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n)) return null
  const [lo, hi] = NUMBER_BOUNDS[key]
  return n >= lo && n <= hi ? n : null
}

/** A concrete style as the form holds it (the editor's Style tab). */
export function styleFormFromConfig(c: StyleConfig): StyleForm {
  return {
    font_file: c.font_file,
    font_size: String(c.font_size),
    text_color: c.text_color,
    marker_color: c.marker_color,
    leader_color: c.leader_color,
    halo: c.halo ? 'on' : 'off',
    halo_color: c.halo_color,
    halo_width: String(c.halo_width),
    marker_width: String(c.marker_width),
    marker_min_radius: String(c.marker_min_radius),
    show_aliases: c.show_aliases ? 'on' : 'off',
    name_preference: c.name_preference,
    max_aliases: String(c.max_aliases),
  }
}
```

Move the converter tests from `configForm.test.ts` into `style/styleForm.test.ts` (keep `buildUpdate`/`sameOverrides` tests in `configForm.test.ts`), and add:

```ts
describe('values mode helpers', () => {
  it('styleFormFromConfig renders every field as text', () => {
    expect(styleFormFromConfig(makeDoc().annotations.style)).toMatchObject({ font_size: '24', halo: 'on', show_aliases: 'off', max_aliases: '2' })
  })
  it('parseNumberField accepts integers inside the bounds only', () => {
    expect(parseNumberField('font_size', '24')).toBe(24)
    expect(parseNumberField('font_size', '5')).toBeNull()
    expect(parseNumberField('font_size', '201')).toBeNull()
    expect(parseNumberField('font_size', '2.5')).toBeNull()
    expect(parseNumberField('font_size', '')).toBeNull()
    expect(parseNumberField('halo_width', '0')).toBe(0)
    expect(parseNumberField('max_aliases', '6')).toBeNull()
  })
})
```

(`makeDoc` from `../editor/testDoc`.)

- [ ] **Step 2: `ColorField` props**

Add `allowDefault = true` and `onCommit` to the props. Hide the `swatch-note` "default" text and the "Use default" button when `!allowDefault`. Call `onCommit?.()` inside `close()`, in the click-away handler after `setOpen(false)`, in the `onBlur` branch after `setOpen(false)`, and in `pick` when it came from `HexColorInput` (wrap: `const typed = (hex: string) => { pick(hex); onCommit?.() }` and pass `typed` to `HexColorInput`; the picker's drag keeps calling `pick` only).

- [ ] **Step 3: `StyleForm.tsx`**

Lift `sizeField`, `triField`, `colorField`, the font select and the name-preference select out of `ConfigPage.tsx` into `StyleForm.tsx` verbatim, parameterised by `mode`:

```tsx
export default function StyleForm({ mode, values, defaults: d, fonts, disabled = false, fontNote = null, onChange, onColorCommit, children }: StyleFormProps) {
  const overrides = mode === 'overrides'
  const fontList = fonts ?? []
  const fontsLoaded = fonts !== null
  const numberField = (label: string, key: NumberKey, placeholder = 'auto') => {
    const [min, max] = NUMBER_BOUNDS[key]
    return (
      <label className="field" key={key}>
        <span className="field-label">{label}</span>
        <input type="number" min={min} max={max} step={1} required={!overrides} placeholder={overrides ? placeholder : undefined} disabled={disabled} value={values[key]} onChange={(e) => onChange(key, e.target.value)} />
      </label>
    )
  }
  const triField = (label: string, key: TriKey) => (
    <label className="field" key={key}>
      <span className="field-label">{label}</span>
      <select value={values[key]} disabled={disabled} onChange={(e) => onChange(key, e.target.value as Tri)}>
        {overrides && <option value="">Default ({d[key] ? 'on' : 'off'})</option>}
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  )
  const colorField = (label: string, key: ColorKey) => (
    <ColorField key={key} label={label} value={values[key]} fallback={d[key]} allowDefault={overrides} disabled={disabled} onChange={(hex) => onChange(key, hex)} onCommit={() => onColorCommit?.(key)} />
  )
  const fontMissing = values.font_file !== '' && !fontList.some((f) => f.file === values.font_file)
  return (
    <>
      <LabelPreview style={values} defaults={d} />
      {children}
      <div className="grid3">
        <label className="field span2">
          <span className="field-label">Font</span>
          <select value={values.font_file} disabled={disabled || !fontsLoaded} onChange={(e) => onChange('font_file', e.target.value)}>
            {overrides && <option value="">Default ({d.font_file})</option>}
            {fontMissing && <option value={values.font_file}>{fontsLoaded ? `${values.font_file} (not installed)` : values.font_file}</option>}
            {fontList.map((f) => <option key={f.file} value={f.file}>{f.family} {f.weight}</option>)}
          </select>
          {!fontsLoaded && <span className="field-note">{FONTS_UNAVAILABLE}</span>}
          {fontNote && <span className="field-note">{fontNote}</span>}
        </label>
        {numberField('Font size (px)', 'font_size')}
        <label className="field span2">
          <span className="field-label">Primary name</span>
          <select value={values.name_preference} disabled={disabled} onChange={(e) => onChange('name_preference', e.target.value as StyleFormValues['name_preference'])}>
            {overrides ? (
              <>
                <option value="">Default ({PREFERENCE_LABELS[d.name_preference]})</option>
                {values.name_preference === d.name_preference && <option value={values.name_preference}>{PREFERENCE_LABELS[values.name_preference]} (same as default)</option>}
                <option value={otherPreference(d.name_preference)}>{PREFERENCE_LABELS[otherPreference(d.name_preference)]}</option>
              </>
            ) : (
              <>
                <option value="popular">{PREFERENCE_LABELS.popular}</option>
                <option value="ngc_ic">{PREFERENCE_LABELS.ngc_ic}</option>
              </>
            )}
          </select>
        </label>
        {triField('Alias line', 'show_aliases')}
        {numberField('Aliases shown (max)', 'max_aliases', `Default (${d.max_aliases})`)}
        {colorField('Text colour', 'text_color')}
        {colorField('Marker colour', 'marker_color')}
        {colorField('Leader colour', 'leader_color')}
        {triField('Halo', 'halo')}
        {colorField('Halo colour', 'halo_color')}
        {numberField('Halo width (px)', 'halo_width')}
        {numberField('Marker line width (px)', 'marker_width')}
        {numberField('Marker min radius (px)', 'marker_min_radius')}
      </div>
    </>
  )
}
```

`FONTS_UNAVAILABLE` moves here from `ConfigPage.tsx`. `ColorField` needs a `disabled` prop too (disable the swatch button). Note the order: the spec's field order puts halo before the marker widths; the config page used a different order — adopt the spec order in both (a visible but harmless change; say so in the PR).

- [ ] **Step 4: `ConfigPage.tsx` uses it**

Replace the "Default label style" section's body with:

```tsx
        <StyleForm mode="overrides" values={style} defaults={d} fonts={fonts} onChange={setField}>
          <p className="field-note">
            Applies to newly solved images. Blank fields keep the built-in defaults; the four sizes then scale with each image.
            The preview draws the text near its real size and every width in proportion to it.
          </p>
        </StyleForm>
```

Delete the lifted helpers, `ColorKey`/`NumberKey` types and `FONTS_UNAVAILABLE` from the page. Fix imports (`../style/StyleForm`, `../style/styleForm`).

- [ ] **Step 5: Run everything**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run`
Expected: clean; `configForm.test.ts` + `styleForm.test.ts` + `labelPreview.test.ts` pass at their new paths. Then `make e2e` once: `smoke.spec.ts` exercises the config page? (check: `ensureSetUpAndSignedIn` and the config flows in `smoke.spec.ts`) — the page must render and save exactly as before.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/style frontend/src/pages
git commit -m "refactor(style): shared StyleForm with overrides and values modes; colour field can commit"
```

---

### Task 4: Preview scales the text with the font size (#93)

**Files:**
- Modify: `frontend/src/style/labelPreview.ts` (`previewGeometry`, new `previewTextSize`), `frontend/src/style/LabelPreview.tsx`
- Test: `frontend/src/style/labelPreview.test.ts`

**Interfaces:**
- Produces: `export function previewTextSize(fontSizeRaw: string, fallback: number): number` = `clamp(PREVIEW_SIZE * size / ASSUMED_FONT_SIZE, 12, 40)` where `size` is the parsed font size or `fallback` (blank/non-finite). `PreviewGeometry` gains `textSize: number`; `haloWidth`, `markerWidth`, `aliasSize`, `aliasOffset` are computed from `textSize` instead of `PREVIEW_SIZE`.
- `previewGeometry(style, defaults)` uses `defaults` for the blank font size only through `ASSUMED_FONT_SIZE` (sizes are per image, so `StyleDefaults` has no font size).

- [ ] **Step 1: Failing tests** (replace the geometry test in `labelPreview.test.ts`):

```ts
  it('scales the drawn text with the font size inside a readable band', () => {
    expect(previewTextSize('', 24)).toBeCloseTo(22)
    expect(previewTextSize('48', 24)).toBeCloseTo(40) // 44 clamped
    expect(previewTextSize('12', 24)).toBeCloseTo(12) // 11 clamped
    expect(previewTextSize('36', 24)).toBeCloseTo(33)
    expect(previewTextSize('abc', 24)).toBeCloseTo(22)
  })
  it('keeps widths in proportion to the drawn text and doubles the halo for an outward stroke', () => {
    const base = previewGeometry(styleFormFromOverrides({}), defaults)
    expect(base.textSize).toBeCloseTo(22)
    expect(base.markerWidth).toBeCloseTo((2 * 22) / 24)
    expect(base.haloWidth).toBeCloseTo(((2 * 22) / 24) * 2)
    expect(base.aliasSize).toBeCloseTo(22 * 0.7)
    expect(base.aliasOffset).toBeCloseTo(22 * 1.2)
    const bigger = previewGeometry(styleFormFromOverrides({ font_size: 36, marker_width: 3 }), defaults)
    expect(bigger.textSize).toBeCloseTo(33)
    expect(bigger.markerWidth).toBeCloseTo((3 * 33) / 36) // same ratio to the text as 3 px to 36 px
    expect(previewGeometry(styleFormFromOverrides({ halo: false }), defaults).haloWidth).toBe(0)
  })
```

- [ ] **Step 2: Run to verify they fail** — `cd frontend && npx vitest run src/style/labelPreview.test.ts` → FAIL (`previewTextSize` missing, `textSize` undefined).

- [ ] **Step 3: Implement**

```ts
/** Drawn text size: follows the font size relative to the default, inside a readable band, so a
 *  larger font looks larger (#93). The ring radius stays fixed: it depends on each object's
 *  catalogue radius, not on the style. */
export function previewTextSize(fontSizeRaw: string, fallback: number): number {
  const n = Number(fontSizeRaw)
  const size = fontSizeRaw.trim() === '' || !Number.isFinite(n) || n <= 0 ? fallback : n
  return Math.min(40, Math.max(12, (PREVIEW_SIZE * size) / ASSUMED_FONT_SIZE))
}

export function previewGeometry(style: StyleForm, defaults: StyleDefaults): PreviewGeometry {
  const fontSize = Number(style.font_size) || ASSUMED_FONT_SIZE
  const textSize = previewTextSize(style.font_size, ASSUMED_FONT_SIZE)
  const scale = textSize / fontSize
  const px = (v: string, fallback: number) => Math.max(0.5, (Number(v) || fallback) * scale)
  const haloOn = style.halo === '' ? defaults.halo : style.halo === 'on'
  return {
    textSize,
    haloWidth: haloOn ? px(style.halo_width, 2) * 2 : 0,
    markerWidth: px(style.marker_width, 2),
    aliasSize: textSize * ALIAS_SCALE,
    aliasOffset: textSize * LINE_HEIGHT,
  }
}
```

`LabelPreview.tsx`: use `g.textSize` for the primary `fontSize`; keep the y positions (`62`/`70`, `62 + g.aliasOffset`); the 130 px viewBox has room for 40 px text plus a 28 px alias line.

- [ ] **Step 4: Run** — `cd frontend && npx vitest run src/style && npx tsc --noEmit && npx eslint src/style` → PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/style
git commit -m "feat(style): preview text scales with the font size (#93)"
```

---

### Task 5: The Style tab

**Files:**
- Create: `frontend/src/editor/StyleTab.tsx`, `frontend/src/editor/styleTab.ts` (pure helpers), `frontend/src/editor/styleTab.test.ts`
- Modify: `frontend/src/editor/SidePanel.tsx` (tab list), `frontend/src/editor/ImageTab.tsx` (fallback notice), `frontend/src/styles.css` (only `.tab-body .grid3` spacing if needed)

**Interfaces:**
- `styleTab.ts` produces:
  - `export function fallbackSentence(f: FontFallback): string` → `This image was set up with ${f.stored}, which is no longer bundled; labels use ${f.used} until you pick a font. The next save keeps ${f.used}.`
  - `export function patchForField<K extends keyof StyleForm>(key: K, value: StyleForm[K]): Partial<StyleConfig> | null` — numbers through `parseNumberField` (null while invalid); tri keys → boolean; `name_preference` → itself; colours → `normalizeHex(value)` only if it matches `/^#[0-9a-f]{6}$/i` else null; `font_file` → `{ font_file: value }`.
- `StyleTab` behaviour:
  - `draft: StyleForm` state, initialised from `styleFormFromConfig(style)` and re-derived whenever the store's `style` object changes (undo/redo, reset, another commit) via `useEffect` on `style`.
  - `onChange(key, value)`: set the draft; for `font_file` do nothing else (see below); for colours do nothing else (commit on `onColorCommit`); for everything else `const patch = patchForField(key, value); if (patch) setStyle(patch)`.
  - `onColorCommit(key)`: `const patch = patchForField(key, draft[key]); if (patch) setStyle(patch)`.
  - Font: `onChange('font_file', file)` sets `fontLoading = file`, awaits `loadBundledFont(file)`; on success `setStyle({ font_file: file })`, on failure keep the previous font (`setDraft` back to the store's) and show the loader's message in `fontNote`; `fontLoading` disables the select via `disabled`.
  - `fontNote`: the fallback sentence while `fontFallback` is set; "Loading {file}…" while loading; the load error after a failure.
  - "Reset to site defaults": button in `children`; `api.imageDefaultStyle(image.id)` → `await loadBundledFont(def.font_file)` → `setStyle(def)` (one commit); errors via `pageError` into a `.error` line in the tab.
  - `disabled = !editable || fontLoading !== null`.
  - Selectors: `style`, `fonts` (as an array, memoised from the map), `image?.id`, `fontFallback`, `isEditable`.
- `SidePanel`: `TABS` becomes Objects, Style, Layout, Image; `tab === 'style' && <StyleTab />`.
- `ImageTab`: above the facts, `{fallback && <p className="notice">{fallbackSentence(fallback)}</p>}`.

- [ ] **Step 1: Failing unit tests** (`styleTab.test.ts`):

```ts
describe('patchForField', () => {
  it('parses numbers within bounds and refuses the rest', () => {
    expect(patchForField('font_size', '30')).toEqual({ font_size: 30 })
    expect(patchForField('font_size', '3')).toBeNull()
    expect(patchForField('max_aliases', '0')).toEqual({ max_aliases: 0 })
  })
  it('maps tri fields, preference, colours and the font', () => {
    expect(patchForField('halo', 'off')).toEqual({ halo: false })
    expect(patchForField('show_aliases', 'on')).toEqual({ show_aliases: true })
    expect(patchForField('name_preference', 'ngc_ic')).toEqual({ name_preference: 'ngc_ic' })
    expect(patchForField('text_color', '#abc')).toEqual({ text_color: '#aabbcc' })
    expect(patchForField('text_color', 'red')).toBeNull()
    expect(patchForField('font_file', 'Roboto-Bold.ttf')).toEqual({ font_file: 'Roboto-Bold.ttf' })
  })
})
describe('fallbackSentence', () => {
  it('names both fonts', () => {
    expect(fallbackSentence({ stored: 'Lato-Regular.ttf', used: 'Inter-Regular.ttf' })).toBe(
      'This image was set up with Lato-Regular.ttf, which is no longer bundled; labels use Inter-Regular.ttf until you pick a font. The next save keeps Inter-Regular.ttf.',
    )
  })
})
```

- [ ] **Step 2: Run to verify they fail** — `cd frontend && npx vitest run src/editor/styleTab.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `styleTab.ts`**

```ts
import type { StyleConfig } from '../api'
import type { FontFallback } from './store'
import { normalizeHex, parseNumberField, type NumberKey, type StyleForm } from '../style/styleForm'

const NUMBER_KEYS: readonly NumberKey[] = ['font_size', 'halo_width', 'marker_width', 'marker_min_radius', 'max_aliases']

export function fallbackSentence(f: FontFallback): string {
  return `This image was set up with ${f.stored}, which is no longer bundled; labels use ${f.used} until you pick a font. The next save keeps ${f.used}.`
}

/** The store patch for one edited field, or null while the text is not a value the API accepts. */
export function patchForField<K extends keyof StyleForm>(key: K, value: StyleForm[K]): Partial<StyleConfig> | null {
  if ((NUMBER_KEYS as readonly string[]).includes(key)) {
    const n = parseNumberField(key as NumberKey, value as string)
    return n === null ? null : { [key]: n }
  }
  switch (key) {
    case 'halo':
    case 'show_aliases':
      return value === '' ? null : { [key]: value === 'on' }
    case 'name_preference':
      return value === '' ? null : { name_preference: value as StyleConfig['name_preference'] }
    case 'font_file':
      return value === '' ? null : { font_file: value as string }
    default: {
      const hex = normalizeHex(value as string)
      return /^#[0-9a-f]{6}$/i.test(hex) ? { [key]: hex } : null
    }
  }
}
```

- [ ] **Step 4: Implement `StyleTab.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'
import { api, pageError, type FontOut } from '../api'
import StyleForm from '../style/StyleForm'
import { styleFormFromConfig, type ColorKey, type StyleForm as StyleFormValues } from '../style/styleForm'
import { loadBundledFont } from './fonts'
import { isEditable, useEditor } from './store'
import { fallbackSentence, patchForField } from './styleTab'

/** The image's global style, edited live (SPEC § 6.3). Each committed field is one undo entry;
 *  a font is committed only once the browser has loaded it, so the canvas never measures an
 *  unloaded family (#62); colours commit when their picker closes. */
export default function StyleTab() {
  const style = useEditor((s) => s.style)
  const fontsMap = useEditor((s) => s.fonts)
  const imageId = useEditor((s) => s.image?.id ?? null)
  const fallback = useEditor((s) => s.fontFallback)
  const editable = useEditor(isEditable)
  const setStyle = useEditor((s) => s.setStyle)
  const fonts = useMemo<FontOut[]>(() => [...fontsMap.values()], [fontsMap])

  const [draft, setDraft] = useState<StyleFormValues | null>(style ? styleFormFromConfig(style) : null)
  const [fontLoading, setFontLoading] = useState<string | null>(null)
  const [fontError, setFontError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The store is the source of truth: undo/redo, a reset and every commit re-derive the draft.
  useEffect(() => {
    setDraft(style ? styleFormFromConfig(style) : null)
  }, [style])

  if (!style || !draft) return null

  // StyleDefaults-shaped fallbacks for the preview; in values mode every field is set, so
  // they are never shown.
  const defaults = {
    font_file: style.font_file, text_color: style.text_color, marker_color: style.marker_color,
    leader_color: style.leader_color, halo: style.halo, halo_color: style.halo_color,
    show_aliases: style.show_aliases, name_preference: style.name_preference, max_aliases: style.max_aliases,
  }

  const onChange = <K extends keyof StyleFormValues>(key: K, value: StyleFormValues[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    if (key === 'font_file') {
      void changeFont(value as string)
      return
    }
    if (key === 'text_color' || key === 'marker_color' || key === 'leader_color' || key === 'halo_color') return
    const patch = patchForField(key, value)
    if (patch) setStyle(patch)
  }

  const onColorCommit = (key: ColorKey) => {
    const patch = patchForField(key, draft[key])
    if (patch) setStyle(patch)
  }

  async function changeFont(file: string): Promise<void> {
    if (!file || file === style?.font_file) return
    setFontLoading(file)
    setFontError(null)
    try {
      await loadBundledFont(file)
      useEditor.getState().setStyle({ font_file: file })
    } catch (err) {
      setFontError(pageError(err))
      const current = useEditor.getState().style
      if (current) setDraft(styleFormFromConfig(current))
    } finally {
      setFontLoading(null)
    }
  }

  async function resetToSiteDefaults(): Promise<void> {
    if (!imageId) return
    setBusy(true)
    setError(null)
    try {
      const def = await api.imageDefaultStyle(imageId)
      await loadBundledFont(def.font_file)
      useEditor.getState().setStyle(def)
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  const fontNote = fontLoading ? `Loading ${fontLoading}…` : (fontError ?? (fallback ? fallbackSentence(fallback) : null))

  return (
    <div className="tab-body">
      <StyleForm mode="values" values={draft} defaults={defaults} fonts={fonts} disabled={!editable || fontLoading !== null} fontNote={fontNote} onChange={onChange} onColorCommit={onColorCommit}>
        <div className="tab-actions">
          <button className="secondary" disabled={!editable || busy} onMouseDown={(e) => e.preventDefault()} onClick={() => void resetToSiteDefaults()}>
            {busy ? 'Resetting…' : 'Reset to site defaults'}
          </button>
        </div>
      </StyleForm>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
```

Number inputs must keep the canvas shortcuts sane: the key handler already ignores keys while an input has focus. `onMouseDown={(e) => e.preventDefault()}` only on the button (inputs need focus).

`SidePanel.tsx`: add `{ id: 'style', label: 'Style' }` after Objects; render `<StyleTab />`. `ImageTab.tsx`: select `fontFallback` and render the notice above `<dl className="facts">`.

CSS: the side panel is narrower than 680 px; add `.side-panel .grid3 { grid-template-columns: 1fr 1fr; }` and `.side-panel .grid3 .span2 { grid-column: span 2; }` so the form stacks in two columns there (the existing `@media` rule already does this at narrow widths; this makes it unconditional inside the panel).

- [ ] **Step 5: Run** — `cd frontend && npx vitest run && npx tsc --noEmit && npx eslint src` → PASS, clean.

- [ ] **Step 6: Manual check on the dev unit** (owner's, at the end; note in the report): Style tab present; changing the font size re-lays labels at once and one Ctrl+Z reverts it; picking a font swaps every label after a brief "Loading…"; a colour drag updates the preview live and one Ctrl+Z after closing the picker reverts it; Reset to site defaults restores the size-relative values; the toolbar reads Saving… then Saved.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/editor/StyleTab.tsx frontend/src/editor/styleTab.ts frontend/src/editor/styleTab.test.ts frontend/src/editor/SidePanel.tsx frontend/src/editor/ImageTab.tsx frontend/src/styles.css
git commit -m "feat(editor): Style tab edits the image's style live, one undo entry per change"
```

---

### Task 6: Browser test — Style tab change, autosave, undo

**Files:**
- Create: `frontend/e2e/styling.spec.ts`

- [ ] **Step 1: Write the spec** (model on `smoke.spec.ts`'s helpers: `ensureSetUpAndSignedIn`, `ensureSolvedImage`, opening the editor, `stored()` reading `/api/images/{id}/annotations` through `page.request`):

```ts
import { expect, test } from './fixtures'
import { ensureSetUpAndSignedIn, ensureSolvedImage } from './helpers'

test('the Style tab changes the font size live, autosaves it, and Ctrl+Z takes it back', async ({ page, request }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click() // adapt to how smoke.spec.ts opens the editor
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const id = page.url().split('/').pop()!
  const stored = async () => (await request.get(`/api/images/${id}/annotations`)).json() as Promise<{ style: { font_size: number; font_file: string }; version: number }>
  const before = await stored()

  await page.getByRole('tab', { name: 'Style' }).click()
  const size = page.getByLabel('Font size (px)')
  await expect(size).toHaveValue(String(before.style.font_size))
  const target = before.style.font_size === 40 ? 44 : 40
  await size.fill(String(target))
  await expect.poll(async () => (await stored()).style.font_size, { timeout: 5_000 }).toBe(target)
  await expect(page.locator('.save-status')).toHaveText('Saved')

  // Undo from the canvas: focus must leave the input first (the key handler ignores fields).
  await page.locator('.editor-canvas').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await stored()).style.font_size, { timeout: 5_000 }).toBe(before.style.font_size)

  // Picking another bundled font swaps it after the browser loaded the face.
  const font = page.getByLabel('Font')
  const other = (await font.locator('option').allTextContents()).find((t) => t.includes('Roboto') && !t.includes('Condensed'))
  expect(other).toBeTruthy()
  await font.selectOption({ label: other! })
  await expect.poll(async () => (await stored()).style.font_file, { timeout: 10_000 }).toMatch(/^Roboto-/)
  await expect(page.locator('.side-panel .error')).toHaveCount(0)
})
```

Adjust the editor-opening step and label names to the real DOM (read `smoke.spec.ts`); the `fill` on a number input triggers one `onChange` with the whole value, so exactly one commit.

- [ ] **Step 2: Run** — `make e2e` → all specs pass including the new one and `parity.spec.ts` (unchanged inputs).

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/styling.spec.ts
git commit -m "test(e2e): Style tab font size and font swap autosave and undo"
```

---

### Task 7: SPEC.md

**Files:**
- Modify: `docs/SPEC.md` § 6.3 (Style item and the "Milestone 3 PR 5 delivers three of the four tabs" sentence), § 8 (annotations GET, new default-style route), § 9 (fallback paragraph)

- [ ] **Step 1:** § 6.3: change "Milestone 3 PR 5 delivers three of the four tabs below — **Style** ships with milestone 4." to "The four tabs below; **Style** arrived with milestone 4." Rewrite the Style item's end: "Every edit is one change (one undo entry, autosaved); a font is applied once the browser has loaded it; colours apply when the picker closes. 'Reset to site defaults' applies the size-relative built-ins with `config.default_style` on top (`GET /images/{id}/default-style`). When the stored font is no longer bundled, the tab and the Image tab say so and the default is used until a font is picked."
- [ ] **Step 2:** § 8: under the annotations GET line add "`font_fallback`: the stored `font_file` when the served style's font was replaced by the default, else null"; add `GET /images/{id}/default-style → StyleConfig`.
- [ ] **Step 3:** § 9: replace the last paragraph's "the stored row is left alone until the editor next saves it" with "`GET /annotations` names the stored file in `font_fallback`; the editor shows it and the next save stores the resolved font. `resolve_font_file` and `GET /fonts` use the same predicate (`list_fonts`)."
- [ ] **Step 4:** `make lint test`; commit `docs: Style tab, font fallback and the per-image default style in SPEC § 6, 8, 9`.

---

### Task 8: Review ritual and PR

- [ ] Whole-branch review (most capable model), silent-failure pass, `/simplify`; `make lint test` and `make e2e`.
- [ ] Owner's smoke test on the dev unit (Task 5 Step 6 list, plus the config page still saving and the preview's font size scaling per #93).
- [ ] `gh pr create` — title `feat: Style tab, font fallback notice and preview scaling (milestone 4, PR 3)`; body: `Closes #62`, `Closes #63`, `Closes #93`; note the config page's field order now follows SPEC § 6.3. `gh pr checks --watch`. Do not merge without the owner's go.
