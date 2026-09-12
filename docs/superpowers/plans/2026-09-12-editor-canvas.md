# Editor Canvas (Milestone 3, PR 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The editor page: `/images/:id` opens a solved image on a Konva stage that draws the preview, markers, leaders and labels from the stored annotations exactly as the export does, with zoom/pan, hover highlights and the `F`/`1` keys; plus `frontend/e2e/parity.spec.ts`, the pixel-level proof that the canvas and Pillow agree.

**Architecture:** One zustand store (`frontend/src/editor/store.ts`) holds the loaded document and the view transform; pure helpers (`view.ts`) do the fit/zoom arithmetic and are unit-tested. `load.ts` fetches image, objects, annotations and fonts, then awaits every needed FontFace (`fonts.ts`, strict: a font that fails to load is an error, never a silent fallback) before the first draw. `EditorCanvas.tsx` renders a `react-konva` stage whose world units are original-image pixels: one scale + offset for zoom and pan, the 2048-px preview drawn scaled to `width × height`, and per label a `Circle`, a `Line` (from `leaderSegment`) and a custom `LabelTextShape` that measures with `canvasMeasurer` and draws the halo under the fill on the alphabetic baseline at `y + ascentFor(...)`. Interactions that change the document (toggle, drag, keys other than F/1, autosave, tabs, export) are PR 5; PR 4 is read-only apart from the view. The parity spec measures every vector string on a real canvas (≤ 0.5 px from Pillow) and pixel-diffs the stage against the server's annotated preview (≤ 1 % of pixels differing by more than 48), doing the comparison in the browser so no image library is needed.

**Tech Stack:** konva, react-konva, zustand (all three approved for M3 in `milestone-3-decisions`); React 19, TypeScript strict, vitest, Playwright. Backend untouched.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 3 (editor page and canvas, label drawing, hover targets, state), § 6 (parity spec), § 8 item 4; `docs/SPEC.md` § 6.1, § 6.2, § 9; issue #62 (font fallback notice), #63 (a style font missing from `GET /fonts`), #55 (parity tests), #68 (behaviour during a re-solve: PR 4 only reads, so it shows a notice when `solve_status` is not `solved`).

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`; function components + hooks; zustand for editor state; no Redux. Python untouched (no `make format` needed, but `make lint test` still runs both sides).
- New dependencies exactly `konva`, `react-konva`, `zustand` (runtime). Nothing else. `npm install` must run with the dev unit stopped: `sudo systemctl stop astrocaption-dev`, then `cd frontend && npm install konva react-konva zustand`, then `sudo systemctl start astrocaption-dev` and confirm `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/api/health` prints 200. Never run `npm ci`/`make install` while the unit is up.
- Coordinates: annotation geometry stays in original-image pixels; the stage applies one transform (`scale`, `x`, `y`); conversion happens only at the edges (pointer events → world, world → tooltip position).
- Fonts by file name only; the CSS family is `fontFamilyFor(file)` (the file stem); every font the document needs is loaded through `document.fonts` before the first measurement. The style comes only from `GET /annotations` (#62): never from config defaults or the image record.
- Every layout number comes from `frontend/src/editor/metrics.ts` (`measureLabel`, `ascentFor`, `markerRadius`, `leaderSegment`, `leaderVisible`, `scaleUnit`, `LEADER_GAP_FACTOR`); the canvas adds no arithmetic of its own beyond the view transform. Halo: canvas stroke `2 × halo_width`, `lineJoin: 'round'`, drawn under the fill, only when `style.halo`.
- Parity tolerances (SPEC § 9): canvas width within 0.5 px of Pillow for every `texts` entry of `tests/fixtures/render/vectors.json`; at most 1 % of pixels differ by more than 48 (of 255) in any channel between the stage PNG and `annotated-preview`.
- `frontend/e2e` runs against the built bundle (`make e2e` builds first). The Playwright run is stateful and must stay single-worker.
- After frontend edits: `cd frontend && npm run lint --silent && npm test --silent`; `make lint test` at the repo root before every commit; `make e2e` in Task 4 and Task 5.
- Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N
  ```
- Branch `feat/editor-canvas` from `main` (e88c0a0 or later). Stop after `gh pr create` and `gh pr checks --watch`; the owner smoke-tests on `make dev` and merges.

## File map

| File | Responsibility |
|---|---|
| `frontend/package.json`, `package-lock.json` (modify) | konva, react-konva, zustand. |
| `frontend/src/editor/fonts.ts` (create) | `loadBundledFont(file): Promise<string>` (strict), `loadFonts(files)`; one in-flight promise per file. |
| `frontend/src/pages/LabelPreview.tsx` (modify) | Uses `loadBundledFont` with its own catch → fallback family (unchanged behaviour). |
| `frontend/src/editor/view.ts` (create) | `View`, `fitView`, `zoomAt`, `clampScale`, `toWorld`, `toScreen`. |
| `frontend/src/editor/view.test.ts` (create) | vitest for the view math. |
| `frontend/src/editor/store.ts` (create) | zustand store: document, view, selection/hover, `load`, `setView`, `select`, `hover`. |
| `frontend/src/editor/store.test.ts` (create) | vitest for the store. |
| `frontend/src/editor/load.ts` (create) | `loadEditor(id)`: the four fetches + fonts → `LoadedDocument`. |
| `frontend/src/editor/LabelTextShape.tsx` (create) | The custom Konva shape (sceneFunc/hitFunc). |
| `frontend/src/editor/EditorCanvas.tsx` (create) | Stage, layers, background image, markers, leaders, labels, hover ring + tooltip, wheel/drag/keys. |
| `frontend/src/editor/EditorPage.tsx` (create) | Route component: loading/error states, toolbar (back, title, zoom, Fit, 100 %), solve-status notice, font-fallback notice, canvas. |
| `frontend/src/App.tsx`, `frontend/src/pages/ImagesPage.tsx`, `frontend/src/styles.css` (modify) | Route `/images/:id`, full-width main for the editor, "Edit" link on solved cards, editor CSS. |
| `frontend/e2e/helpers.ts` (create) | `ensureSetUpAndSignedIn(page)`, `ensureSolvedImage(page)` shared by both specs. |
| `frontend/e2e/smoke.spec.ts` (modify) | Uses the helpers; gains "open the editor" steps. |
| `frontend/e2e/parity.spec.ts` (create) | (a) width check, (b) pixel diff, diff image on failure. |
| `frontend/playwright.config.ts` (modify) | `workers: 1`, `fullyParallel: false`. |
| `docs/SPEC.md` § 6.1 / § 9, `docs/ARCHITECTURE.md` (modify) | What the editor does in M3 PR 4; parity spec now exists. |
| `CLAUDE.md` (modify) | Hard-rule bullet: `parity.spec.ts` now exists (drop "arrives with the editor canvas"). |

---

### Task 1: Dependencies, strict font loading, view math

**Files:**
- Modify: `frontend/package.json`, `frontend/package-lock.json` (via npm)
- Create: `frontend/src/editor/fonts.ts`, `frontend/src/editor/view.ts`, `frontend/src/editor/view.test.ts`
- Modify: `frontend/src/pages/LabelPreview.tsx`

**Interfaces:**
- Produces: `fonts.loadBundledFont(file: string): Promise<string>` resolving to the CSS family, rejecting with `Error("Font <file> could not be loaded.")` on any failure (no silent fallback); `fonts.loadFonts(files: Iterable<string>): Promise<void>`; `view.View = { scale: number; x: number; y: number }`; `view.fitView(imageW, imageH, viewportW, viewportH, padding = 24): View`; `view.zoomAt(view, cursorX, cursorY, factor, min, max): View`; `view.toWorld(view, sx, sy)`, `view.toScreen(view, wx, wy)`; `view.MIN_SCALE`, `view.MAX_SCALE` (0.02 and 8).

- [ ] **Step 1: Install the dependencies (dev unit stopped)**

```bash
cd ~/astrocaption && git checkout main && git pull && git checkout -b feat/editor-canvas
sudo systemctl stop astrocaption-dev
cd frontend && npm install konva react-konva zustand
sudo systemctl start astrocaption-dev
sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/api/health
```

Expected: `package.json` gains the three under `dependencies`; the curl prints 200. Commit these two files alone: `chore: add konva, react-konva and zustand for the editor`.

- [ ] **Step 2: Write the failing view tests**

`frontend/src/editor/view.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, fitView, toScreen, toWorld, zoomAt } from './view'

describe('view', () => {
  it('fits a landscape image into the viewport with padding and centres it', () => {
    const v = fitView(3000, 2000, 1224, 600, 24)
    expect(v.scale).toBeCloseTo((600 - 48) / 2000) // height-bound
    expect(v.y).toBeCloseTo(24)
    expect(v.x).toBeCloseTo((1224 - 3000 * v.scale) / 2)
  })

  it('fits a portrait image width-bound', () => {
    const v = fitView(2000, 3000, 1000, 1000, 0)
    expect(v.scale).toBeCloseTo(0.5)
    expect(v.x).toBe(0)
    expect(v.y).toBeCloseTo((1000 - 3000 * 0.5) / 2)
  })

  it('zooms about the cursor so the world point under it stays put', () => {
    const v = { scale: 0.5, x: 100, y: 50 }
    const before = toWorld(v, 400, 300)
    const z = zoomAt(v, 400, 300, 1.25, MIN_SCALE, MAX_SCALE)
    expect(z.scale).toBeCloseTo(0.625)
    const after = toWorld(z, 400, 300)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps the scale to the allowed range', () => {
    const v = { scale: 7, x: 0, y: 0 }
    expect(zoomAt(v, 0, 0, 10, MIN_SCALE, MAX_SCALE).scale).toBe(MAX_SCALE)
    expect(zoomAt({ scale: 0.03, x: 0, y: 0 }, 0, 0, 0.1, MIN_SCALE, MAX_SCALE).scale).toBe(MIN_SCALE)
  })

  it('round-trips world and screen', () => {
    const v = { scale: 0.4, x: 12, y: -7 }
    const s = toScreen(v, 1500, 1000)
    const w = toWorld(v, s.x, s.y)
    expect(w.x).toBeCloseTo(1500)
    expect(w.y).toBeCloseTo(1000)
  })
})
```

Run: `cd frontend && npm test --silent` → fails to resolve `./view`.

- [ ] **Step 3: Implement `view.ts`**

```ts
/** The stage transform: world units are original-image pixels; `scale` is screen px per
 *  world px and (x, y) is where world (0, 0) lands on the screen (SPEC § 6.1). */
export interface View {
  scale: number
  x: number
  y: number
}

export const MIN_SCALE = 0.02
export const MAX_SCALE = 8

/** The whole image visible with `padding` screen px around it, centred. */
export function fitView(imageW: number, imageH: number, viewportW: number, viewportH: number, padding = 24): View {
  const availW = Math.max(1, viewportW - 2 * padding)
  const availH = Math.max(1, viewportH - 2 * padding)
  const scale = Math.min(availW / imageW, availH / imageH)
  return { scale, x: (viewportW - imageW * scale) / 2, y: (viewportH - imageH * scale) / 2 }
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale))
}

/** Scale by `factor` about the screen point (cx, cy): the world point under the cursor stays under it. */
export function zoomAt(view: View, cx: number, cy: number, factor: number, min = MIN_SCALE, max = MAX_SCALE): View {
  const scale = clampScale(view.scale * factor, min, max)
  const k = scale / view.scale
  return { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k }
}

export function toWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }
}

export function toScreen(view: View, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y }
}

/** One original pixel per screen pixel, keeping the current centre of the viewport in place. */
export function actualSize(view: View, viewportW: number, viewportH: number): View {
  return zoomAt(view, viewportW / 2, viewportH / 2, 1 / view.scale)
}
```

Add a test for `actualSize` (scale becomes 1 and the viewport centre maps to the same world point).

- [ ] **Step 4: Strict font loader, reused by the config-page preview**

`frontend/src/editor/fonts.ts`:

```ts
import { fontFamilyFor } from './metrics'

/** One load per file for the life of the page. Strict on purpose (#62): a font that cannot be
 *  loaded must surface as an error, because `measureText` on an unloaded family silently uses a
 *  fallback and the preview would no longer match the export. */
const loads = new Map<string, Promise<string>>()

export function loadBundledFont(file: string): Promise<string> {
  const pending = loads.get(file)
  if (pending) return pending
  const family = fontFamilyFor(file)
  const promise = (async () => {
    if (typeof FontFace === 'undefined') throw new Error(`Font ${file} could not be loaded.`)
    let face: FontFace
    try {
      // Both arguments are parsed as CSS; quote them so an odd file name cannot throw here.
      face = new FontFace(JSON.stringify(family), `url("/fonts/${encodeURIComponent(file)}")`)
    } catch {
      throw new Error(`Font ${file} could not be loaded.`)
    }
    try {
      document.fonts.add(await face.load())
    } catch {
      throw new Error(`Font ${file} could not be loaded.`)
    }
    return family
  })()
  loads.set(file, promise)
  promise.catch(() => loads.delete(file)) // a later attempt may succeed (the server came back)
  return promise
}

export async function loadFonts(files: Iterable<string>): Promise<void> {
  await Promise.all([...new Set(files)].map(loadBundledFont))
}
```

`frontend/src/pages/LabelPreview.tsx`: delete its private `fontLoads`/`loadBundledFont`, import `loadBundledFont` from `../editor/fonts`, and in `useBundledFont` use `loadBundledFont(file).then((f) => f, () => null)` so the preview keeps its lenient fallback. `labelPreview.test.ts` and `npm run lint` must stay green.

- [ ] **Step 5: Run, lint, commit**

```bash
cd frontend && npm test --silent && npm run lint --silent && cd .. && make lint test
git add frontend/src/editor/fonts.ts frontend/src/editor/view.ts frontend/src/editor/view.test.ts frontend/src/pages/LabelPreview.tsx
git commit -m "feat: editor view math and a strict bundled-font loader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 2: The store and the loader

**Files:**
- Create: `frontend/src/editor/store.ts`, `frontend/src/editor/store.test.ts`, `frontend/src/editor/load.ts`

**Interfaces:**
- Consumes: a new `api.image(id)` call (`request<ImageOut>(\`/api/images/${id}\`)`, added to `frontend/src/api.ts` in this task; the server route exists), `api.fonts` (exists) `api.objects`, `api.annotations` (PR 3), `loadFonts` (Task 1), types `ImageOut`, `ObjectOut`, `Annotations`, `FontOut`, `Label`, `StyleConfig`.
- Produces:
  ```ts
  export interface LoadedDocument { image: ImageOut; objects: ObjectOut[]; annotations: Annotations; fonts: FontOut[] }
  export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
  export interface EditorState {
    image: ImageOut | null
    objects: Map<number, ObjectOut>
    objectOrder: number[]                      // insertion order from the server
    style: StyleConfig | null
    labels: Map<number, Label>                 // by object id, insertion order kept for save
    version: number
    fonts: Map<string, FontOut>                // by file
    selectedId: number | null
    hoveredId: number | null
    view: View
    save: { status: SaveStatus; message: string | null }
    load(doc: LoadedDocument): void
    setView(view: View): void
    select(id: number | null): void
    hover(id: number | null): void
    reset(): void
  }
  export const useEditor: UseBoundStore<StoreApi<EditorState>>
  export function labelFor(state: EditorState, id: number): Label | undefined
  export function enabledLabels(state: EditorState): Label[]     // in objectOrder
  export function fontFor(state: EditorState): FontOut           // throws Error("Font <file> is not listed by the server.") when style.font_file is absent (#63)
  ```
  and `load.loadEditor(id: string): Promise<LoadedDocument>` which fetches all four in parallel, then `await loadFonts([annotations.style.font_file])` (only the document's font; per-label fonts do not exist in M3), throwing the first error unchanged (plain messages from `ApiError` or the font loader).

- [ ] **Step 1: Failing store tests**

`frontend/src/editor/store.test.ts` builds a `LoadedDocument` fixture by hand (two objects, two labels, one enabled; one `FontOut` with a 195-entry ascents array of 20s; a `StyleConfig` with `font_file: 'Inter-Regular.ttf'`) and asserts:
- after `load`, `objectOrder` is `[1, 2]`, `labels.get(1)?.enabled` is true, `version` equals the document's, `save.status` is `'saved'`, `view` is unchanged (the canvas sets it once it knows its size);
- `enabledLabels` returns only enabled labels in `objectOrder`;
- `fontFor` returns the `FontOut` for the style's file and throws the #63 message when the file is absent;
- `select`/`hover` set and clear ids; `reset` empties everything (used on unmount so a second image does not flash the first).

Run `npm test --silent` → module not found.

- [ ] **Step 2: Implement `store.ts`**

```ts
import { create } from 'zustand'
import type { Annotations, FontOut, ImageOut, Label, ObjectOut, StyleConfig } from '../api'
import type { View } from './view'

// ... interfaces from the Interfaces block ...

const initial = {
  image: null, objects: new Map<number, ObjectOut>(), objectOrder: [] as number[], style: null,
  labels: new Map<number, Label>(), version: 0, fonts: new Map<string, FontOut>(),
  selectedId: null, hoveredId: null, view: { scale: 1, x: 0, y: 0 } as View,
  save: { status: 'saved' as SaveStatus, message: null as string | null },
}

export const useEditor = create<EditorState>((set) => ({
  ...initial,
  load: (doc) =>
    set({
      image: doc.image,
      objects: new Map(doc.objects.map((o) => [o.id, o])),
      objectOrder: doc.objects.map((o) => o.id),
      style: doc.annotations.style,
      labels: new Map(doc.annotations.labels.map((l) => [l.object_id, l])),
      version: doc.annotations.version,
      fonts: new Map(doc.fonts.map((f) => [f.file, f])),
      selectedId: null,
      hoveredId: null,
      save: { status: 'saved', message: null },
    }),
  setView: (view) => set({ view }),
  select: (selectedId) => set({ selectedId }),
  hover: (hoveredId) => set({ hoveredId }),
  reset: () => set({ ...initial, objects: new Map(), labels: new Map(), fonts: new Map(), objectOrder: [] }),
}))
```

plus the three selectors. Keep `Map`s: zustand compares by reference, and `load` replaces them wholesale.

- [ ] **Step 3: `load.ts` and the `api.image` call**

```ts
import { api } from '../api'
import { loadFonts } from './fonts'
import type { LoadedDocument } from './store'

/** Everything the editor needs before its first draw (design § 3 "Data on load"). Any failure
 *  rejects with a plain message and the page shows it instead of a canvas. */
export async function loadEditor(id: string): Promise<LoadedDocument> {
  const [image, objects, annotations, fonts] = await Promise.all([
    api.image(id), api.objects(id), api.annotations(id), api.fonts(),
  ])
  if (!fonts.some((f) => f.file === annotations.style.font_file)) {
    throw new Error(`Font ${annotations.style.font_file} is not listed by the server.`) // #63
  }
  await loadFonts([annotations.style.font_file])
  return { image, objects, annotations, fonts }
}
```

No unit test for `loadEditor` (it is four fetches and a font load; the e2e covers it).

- [ ] **Step 4: Run, lint, commit**

`npm test --silent && npm run lint --silent && cd .. && make lint test`; commit `feat: editor store and document loader`.

---

### Task 3: The canvas, the page, the route

**Files:**
- Create: `frontend/src/editor/LabelTextShape.tsx`, `frontend/src/editor/EditorCanvas.tsx`, `frontend/src/editor/EditorPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/pages/ImagesPage.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: `useEditor`, `loadEditor`, `metrics.*`, `view.*`, react-konva `Stage`, `Layer`, `Image` (as `KImage`), `Circle`, `Line`, `Group`, `Rect`, `Shape`.
- Produces: route `/images/:id` (owner-only via `Guard`); `window.__astrocaptionEditor = { stage: Konva.Stage, renderAt(scale: number): string }` test hook set by `EditorCanvas` while mounted (the parity spec uses it; documented in the component); `EditorPage` props none (reads `useParams`).

- [ ] **Step 1: `LabelTextShape.tsx`**

A `Shape` whose `sceneFunc` draws one label from the store's numbers. Props: `label: Label`, `obj: ObjectOut`, `style: StyleConfig`, `font: FontOut`, `box: LabelBox`, `text: LabelLines`, `selected: boolean`.

```tsx
import { Shape } from 'react-konva'
import type Konva from 'konva'
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import { ascentFor, fontFamilyFor, type LabelBox, type LabelLines } from './metrics'

/** Text drawn the way Pillow draws it (design § 3): geometricPrecision, alphabetic baseline at
 *  y + ascent, the halo as a round-joined stroke of 2 × halo_width under the fill. The hit area
 *  is the measured text box so hover and (in PR 5) drag use the same rectangle the placer used. */
export function LabelTextShape({ label, style, font, box, text, selected }: Props) {
  const color = label.color ?? style.text_color
  const family = fontFamilyFor(style.font_file)
  const draw = (ctx: Konva.Context) => {
    const c = ctx._context
    c.textRendering = 'geometricPrecision'
    c.textBaseline = 'alphabetic'
    c.textAlign = 'left'
    c.lineJoin = 'round'
    const lines: [string, number, number][] = [[text.primary, box.primarySize, 0]]
    if (text.alias !== null) lines.push([text.alias, box.aliasSize, box.line1Height])
    for (const [str, size, dy] of lines) {
      c.font = `${size}px "${family}"`
      const y = label.y + dy + ascentFor(font, size)
      if (style.halo && style.halo_width > 0) {
        c.lineWidth = 2 * style.halo_width
        c.strokeStyle = style.halo_color
        c.strokeText(str, label.x, y)
      }
      c.fillStyle = color
      c.fillText(str, label.x, y)
    }
    if (selected) {
      c.strokeStyle = '#8ab4ff'
      c.lineWidth = 1 / (ctx.canvas.getContext().getTransform().a || 1) // one screen px
      c.strokeRect(label.x, label.y, box.width, box.height)
    }
  }
  return (
    <Shape
      sceneFunc={draw}
      hitFunc={(ctx, shape) => {
        ctx.beginPath()
        ctx.rect(label.x, label.y, box.width, box.height)
        ctx.closePath()
        ctx.fillStrokeShape(shape)
      }}
      listening
    />
  )
}
```

`ctx._context` is Konva's native 2D context (typed on `Konva.Context`); if the typing rejects `textRendering`, use `ctx.setAttr('textRendering', 'geometricPrecision')` as Konva's own API. The one-screen-pixel outline reads the current transform; if `getTransform` is awkward, pass `scale` as a prop and use `1 / scale`.

- [ ] **Step 2: `EditorCanvas.tsx`**

Responsibilities, in order of the render tree:
1. A `useRef` div fills the page area; a `ResizeObserver` reports its size into local state `viewport`; the first non-zero size calls `setView(fitView(image.width, image.height, w, h))`.
2. The preview `HTMLImageElement` loads from `image.preview_url`; until it has loaded, draw nothing but the background.
3. `<Stage width={w} height={h} scaleX={view.scale} scaleY={view.scale} x={view.x} y={view.y} onWheel onMouseDown onMouseMove onMouseUp>` with three layers: background (`KImage` with `width={image.width} height={image.height}`, `listening={false}`), annotations (markers, leaders, text), overlay (hover ring + hit circles).
4. Per enabled label (from `enabledLabels`), memoised per object id: `box = measureLabel(measurer, style, label, obj)`, `text = labelText(obj, label, style)`, `r = markerRadius(obj, style)`, `seg = leaderSegment(obj.x, obj.y, r, {left: label.x, top: label.y, right: label.x + box.width, bottom: label.y + box.height})`, `s = scaleUnit(image.width, image.height)`. Draw `Circle` (stroke `style.marker_color`, `strokeWidth={style.marker_width}`, `listening={false}`), `Line` when `seg && leaderVisible(label, seg.gap, s)` (`points=[from.x, from.y, to.x, to.y]`, stroke `style.leader_color`, `strokeWidth={style.marker_width}`), then `LabelTextShape`. When `label.collided`, a small warning glyph: a `Text` "⚠" of `box.primarySize * 0.6` at the box's top-right (this is UI chrome, so it is excluded from the parity render: see `renderAt`).
5. Hit circles for every object (enabled or not): `Circle` radius `Math.max(markerRadius, 8 / view.scale)`, `fill` transparent, `onMouseEnter → hover(id)`, `onMouseLeave → hover(null)`. Hover ring: a `Circle` at the hovered object with radius `markerRadius + 4 / view.scale`, stroke `#8ab4ff`, `strokeWidth={2 / view.scale}`, `listening={false}`. Tooltip: an absolutely positioned `<div className="editor-tooltip">` outside the stage at `toScreen(view, obj.x, obj.y)` offset by 12 px, showing `obj.primary_name`.
6. Wheel: `e.evt.preventDefault()`; `factor = Math.exp(-e.evt.deltaY * 0.0015)`; `setView(zoomAt(view, pointer.x, pointer.y, factor))` with the pointer from `stage.getPointerPosition()`.
7. Pan: mouse down on empty stage (target === stage) or middle button or while the `Space` key is held → record start; on move, `setView({...view, x, y})`; on up, stop. Cursor `grab`/`grabbing` via a class on the container.
8. Keys (on `window`, ignored when `document.activeElement` is an input/textarea/select): `f`/`F` → `fitView`, `1` → `actualSize`.
9. The measurer: one offscreen `document.createElement('canvas').getContext('2d')` created in a `useMemo`, wrapped with `canvasMeasurer`; boxes are recomputed when `style`, `labels` or `fonts` change (`useMemo` keyed on those).
10. Test hook: `useEffect` sets `window.__astrocaptionEditor = { stage, renderAt }` and deletes it on unmount. `renderAt(scale)` temporarily hides the overlay layer and the collided badges, sets the stage to `scale` with `x = y = 0` and size `ceil(image.width*scale) × ceil(image.height*scale)`, calls `stage.toDataURL({ pixelRatio: 1, mimeType: 'image/png' })`, restores everything, and returns the data URL. Declare the global in a `declare global { interface Window { __astrocaptionEditor?: EditorTestHook } }` block in the same file.

- [ ] **Step 3: `EditorPage.tsx`, route, card link, CSS**

`EditorPage`: `const { id } = useParams()`; on mount `loadEditor(id)` → `useEditor.getState().load(doc)`; on unmount `reset()`. States: loading ("Loading the editor…"), error (`<p className="error">{message}</p>` with a "Back to images" link; message from `describeError`, or `pageError` returning null on session loss), loaded → toolbar + `<EditorCanvas />`. Toolbar: `Link to="/"` "← Images", the image title, a zoom readout (`Math.round(view.scale * 100)%`), buttons "Fit" and "100 %" (call the same functions as the keys). One notice above the canvas: when `image.solve_status !== 'solved'`, "This image is being re-solved; the layout shown is the previous one and cannot be edited until it finishes." (#68; PR 5 gates saves on it). The font-fallback notice from #62 needs a server field PR 4 does not have (the resolved name is indistinguishable from a chosen default); #62 stays open.

`App.tsx`: `<Route path="/images/:id" element={<Guard health={health}><EditorPage /></Guard>} />`; `<main className={useLocation().pathname.startsWith('/images/') ? 'editor-main' : undefined}>`.

`ImagesPage.tsx`: on a solved card, next to Export, `<Link className="button" to={\`/images/${image.id}\`}>Edit</Link>` (style `.button` like a button).

`styles.css`: `.editor-main { max-width: none; padding: 0; gap: 0; height: calc(100vh - <header height>); display: grid; grid-template-rows: auto 1fr; }`, `.editor-toolbar { display: flex; gap: 1rem; align-items: center; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border); }`, `.editor-canvas { position: relative; overflow: hidden; background: #000; cursor: grab; }`, `.editor-canvas.panning { cursor: grabbing; }`, `.editor-tooltip { position: absolute; pointer-events: none; padding: 0.15rem 0.5rem; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; font-size: 0.85rem; }`, `.button { ...same as button... }`. Measure the header height from the existing CSS (padding 1rem + line height) or make the editor `main` use `flex: 1` inside a column-flex body: prefer setting `body { min-height: 100vh; display: flex; flex-direction: column }` and `.editor-main { flex: 1; }` if that does not disturb the other pages (check the config page visually).

- [ ] **Step 4: Manual check on the dev servers, then lint and commit**

Open `http://localhost:5173/`, click Edit on a solved image: the preview appears fitted, labels drawn in the right font, wheel zooms about the cursor, drag pans, hover shows the ring and tooltip, `F` and `1` work, the browser console is clean. Then:

```bash
cd frontend && npm run lint --silent && npm test --silent && cd .. && make lint test
git add frontend/src/editor frontend/src/App.tsx frontend/src/pages/ImagesPage.tsx frontend/src/styles.css frontend/src/api.ts
git commit -m "feat: editor page with the Konva canvas, zoom/pan and hover

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 4: `parity.spec.ts` and the shared e2e helpers

**Files:**
- Create: `frontend/e2e/helpers.ts`, `frontend/e2e/parity.spec.ts`
- Modify: `frontend/e2e/smoke.spec.ts`, `frontend/playwright.config.ts`

**Interfaces:**
- Produces: `helpers.PASSWORD`, `helpers.FIXTURE`, `helpers.ensureSetUpAndSignedIn(page)` (goes to `/`; if redirected to `/setup` completes setup with title "E2E sky"; then signs in if on `/login`), `helpers.ensureSolvedImage(page, title = 'Orion')` (uploads the fixture if no card with that title exists, waits for "Solved", returns the card locator), `helpers.ensureExported(page, card)` (clicks Export if the annotated image is not there yet; returns the annotated preview URL from the `img[alt$=" annotated"]` src).

- [ ] **Step 1: Config and helpers**

`playwright.config.ts`: add `fullyParallel: false, workers: 1,` to `defineConfig` (the run is stateful; two workers would both attempt first-run setup). `helpers.ts` implements the three functions from the smoke spec's existing steps; `smoke.spec.ts` uses them (same assertions as today) and gains, after the export step: click the card's "Edit" link, `await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/)`, `await expect(page.locator('canvas').first()).toBeVisible()`, `await expect(page.getByRole('button', { name: 'Fit' })).toBeVisible()`, then `page.goto('/')` to continue with the config step. Run `make e2e` — the smoke story passes as before plus the editor step.

- [ ] **Step 2: `parity.spec.ts`**

```ts
import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage } from './helpers'

const VECTORS = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'tests', 'fixtures', 'render', 'vectors.json')
const WIDTH_TOLERANCE_PX = 0.5   // SPEC § 9
const PIXEL_THRESHOLD = 48       // per channel, of 255
const PIXEL_FRACTION = 0.01      // of all pixels

interface Vectors { texts: [string, number, string, number][] }

test('the canvas measures every vector string within 0.5 px of Pillow', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const { texts } = JSON.parse(readFileSync(VECTORS, 'utf8')) as Vectors
  const files = [...new Set(texts.map(([file]) => file))]
  const widths = await page.evaluate(async ({ files, texts }) => {
    for (const file of files) {
      const face = new FontFace(JSON.stringify(file.replace(/\.ttf$/i, '')), `url("/fonts/${encodeURIComponent(file)}")`)
      document.fonts.add(await face.load())
    }
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.textRendering = 'geometricPrecision'
    return texts.map(([file, size, text]) => {
      ctx.font = `${size}px "${file.replace(/\.ttf$/i, '')}"`
      return ctx.measureText(text).width
    })
  }, { files, texts })
  const bad = texts.map(([file, size, text, pillow], i) => ({ file, size, text, pillow, canvas: widths[i]! }))
    .filter((t) => Math.abs(t.canvas - t.pillow) > WIDTH_TOLERANCE_PX)
  expect(bad, JSON.stringify(bad.slice(0, 10), null, 1)).toEqual([])
})

test('the editor stage matches the annotated preview within the pixel budget', async ({ page }, testInfo) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  const previewUrl = await ensureExported(page, card)
  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page.locator('canvas').first()).toBeVisible()
  await page.waitForFunction(() => Boolean(window.__astrocaptionEditor))
  const result = await page.evaluate(async ({ previewUrl, threshold }) => {
    const hook = window.__astrocaptionEditor!
    const server = await new Promise<HTMLImageElement>((ok, err) => {
      const im = new Image(); im.onload = () => ok(im); im.onerror = () => err(new Error('preview')); im.src = previewUrl
    })
    const stageUrl = hook.renderAt(server.naturalWidth / hook.imageWidth)
    const mine = await new Promise<HTMLImageElement>((ok, err) => {
      const im = new Image(); im.onload = () => ok(im); im.onerror = () => err(new Error('stage')); im.src = stageUrl
    })
    const w = server.naturalWidth, h = server.naturalHeight
    const draw = (im: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d')!; g.drawImage(im, 0, 0, w, h); return g.getImageData(0, 0, w, h).data }
    const a = draw(server), b = draw(mine)
    const diff = document.createElement('canvas'); diff.width = w; diff.height = h
    const g = diff.getContext('2d')!; const out = g.createImageData(w, h)
    let differing = 0
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
      if (d > threshold) { differing++; out.data[i] = 255; out.data[i + 3] = 255 } else { out.data[i + 3] = 255; out.data[i] = out.data[i + 1] = out.data[i + 2] = a[i]! >> 2 }
    }
    g.putImageData(out, 0, 0)
    return { w, h, differing, fraction: differing / (w * h), diffPng: diff.toDataURL('image/png'), stagePng: stageUrl }
  }, { previewUrl, threshold: PIXEL_THRESHOLD })
  if (result.fraction > PIXEL_FRACTION) {
    for (const [name, url] of [['diff.png', result.diffPng], ['stage.png', result.stagePng]] as const) {
      const path = testInfo.outputPath(name)
      writeFileSync(path, Buffer.from(url.split(',')[1]!, 'base64'))
      await testInfo.attach(name, { path, contentType: 'image/png' })
    }
  }
  expect(result.fraction, `${result.differing} of ${result.w * result.h} pixels differ by more than ${PIXEL_THRESHOLD}`).toBeLessThanOrEqual(PIXEL_FRACTION)
})
```

The hook therefore also exposes `imageWidth` (original width) so the spec can pick the scale that makes the stage render exactly the preview's size. Declare `window.__astrocaptionEditor` for the e2e tsconfig via a `declare global` in `helpers.ts` (`{ stage: unknown; imageWidth: number; renderAt(scale: number): string }`).

- [ ] **Step 3: Run and record the measured numbers**

`make e2e`. Record in the report the actual `differing`/`fraction` of the pixel test and the largest width delta of the first test (print them with `console.log` in the spec, or read the trace); the design says thresholds start at 48/1 % and are tightened once measured — do not tighten in this PR, report the numbers so the owner can decide.

- [ ] **Step 4: Commit**

`make lint test`; commit `test: parity spec — canvas text widths and a pixel diff against the annotated preview (#55)` with the trailers.

---

### Task 5: Docs, verification, PR

- [ ] **Step 1: Docs.** `docs/SPEC.md` § 6.1: note that M3 PR 4 delivers the canvas, zoom/pan, hover and `F`/`1`; the rest of § 6.1–6.3 arrives with PR 5. § 9: the sentence about `parity.spec.ts` drops "milestone 3" qualifiers (it exists now); ARCHITECTURE.md's parity paragraph: drop "(arriving with the editor canvas)"; CLAUDE.md hard-rule bullet: drop "arrives with the editor canvas". `docs/ARCHITECTURE.md`: add a short "Editor" paragraph naming `frontend/src/editor/` (store, load, view, fonts, metrics, canvas) and the `window.__astrocaptionEditor` test hook.
- [ ] **Step 2: `make lint test` and `make e2e` green; `sudo docker build -f docker/Dockerfile -t astrocaption:local .` succeeds and `docker image ls` shows under 400 MB (the bundle grew by konva; expect a few hundred KB).**
- [ ] **Step 3: Commit `docs: editor canvas and the parity spec`, push `feat/editor-canvas`, `gh pr create --title "feat: editor canvas (milestone 3, PR 4)"` with a body listing the above, `Part of #55`, and the measured parity numbers; `gh pr checks --watch`; stop for the owner's smoke test (open an image in the editor on `make dev`) and "merge".
