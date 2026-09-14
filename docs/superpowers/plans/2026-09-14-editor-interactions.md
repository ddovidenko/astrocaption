# Editor Interactions (Milestone 3, PR 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor editable: click an object to toggle its label (placed client-side by the same placer the server uses), drag labels, `Esc`/`Delete`, a debounced autosave with conflict handling, the side panel (Objects with search and type filter, Layout with auto-arrange and reset, Image with calibration and export), and the smoke-test steps that drive it.

**Architecture:** The zustand store grows document actions (`toggleObject`, `moveLabel`, `applyLabels`) and a save state machine (`dirty → saving → saved | error | conflict`); `autosave.ts` subscribes to the store, waits 500 ms after the last change, sends `api.saveAnnotations`, defers a change made while a save is in flight, stops on 409 and warns on `beforeunload`. `placement.ts` is the TypeScript port of `backend/app/placement.py`, pinned to the shared vectors in `tests/fixtures/placement/` so a label toggled on appears where the server would put it. The viewport moves into the store so `fit`/`actual`/`panTo` are store actions callable from the canvas, the toolbar and the side panel. The canvas turns hit-testing back on for labels: a draggable Konva `Group` per label whose position is the label's `(x, y)` in original pixels. The side panel is three small components reading the store; `objectsFilter.ts` holds the pure search/type filter logic (tested against a nova-narrow-shaped list, #37).

**Tech Stack:** React 19, zustand, react-konva/Konva, TypeScript strict, vitest (fake timers for the autosave), Playwright. Backend untouched except one test-only fixture reuse. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 3 (state), § 4 (PUT/autoarrange/export/reset semantics), § 5 (interactions and side panel), § 6 (smoke additions), § 8 item 5; `docs/SPEC.md` § 6.1–6.4; issues #37, #55, #68, #1 (nova link, shown in the Image tab; the card keeps its own).

Deviations from the design text, decided here: (1) the type chips are nova's types (`ngc`, `ic`, `bright`, `hd`, other) rather than galaxy/nebula/cluster/star, because the catalogue data has no morphological type yet (OpenNGC types can come with M4's names catalog); `hd` is off by default per #37. (2) Export from the Image tab uses the card's defaults (match original JPEG, 100 %); the quality/scale options stay on the card in M3.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess`; function components + hooks; zustand; no Redux. Backend untouched (no `make format`), `make lint test` still runs both sides. No new dependencies.
- Geometry in original pixels; one stage transform; a dragged label's new position is read from its Konva `Group` in layer coordinates, which are original pixels.
- Every layout number from `frontend/src/editor/metrics.ts`; placement arithmetic from `frontend/src/editor/placement.ts`, which must reproduce `tests/fixtures/placement/*.json` exactly (SPEC § 6.4, "identical in TS and Python").
- Save document = `{ style, labels, version }` with `labels` in `objectOrder`, every object present exactly once (the server rejects anything else, PR 3), including orphaned/disabled labels unchanged.
- Autosave (design § 5): any change → `dirty`, PUT 500 ms after the last change; a save in flight defers the next one; 409 → `conflict` with the server's sentence and a Reload button, no further saves until reload; other failure → `error` with the sentence and Retry; `beforeunload` warns while dirty or saving. No saves at all while `image.solve_status !== 'solved'` (#68).
- Toggling on a label whose stored position is its object's `(x, y)` (never placed) runs the client placer against the current enabled boxes; toggling off keeps the position; toggling on again restores it. Dragging clears `collided` on the first move.
- Keys ignored while an input/textarea/select has focus: `Esc` deselect, `Delete`/`Backspace` disable the selected label, `F` fit, `1` 100 %.
- The parity render (`renderAt`) must still exclude chrome (selection outline, hover ring, badges); `frontend/e2e/parity.spec.ts` keeps passing unchanged.
- Fonts by file name; style only from `GET /annotations`.
- After frontend edits: `cd frontend && npm run lint --silent && npm test --silent`; `make lint test` before every commit; `make e2e` in Task 6.
- Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N
  ```
- Branch `feat/editor-interactions` from `main` (71672b8 or later). Stop after `gh pr create` and `gh pr checks --watch`; the owner smoke-tests and merges.

## File map

| File | Responsibility |
|---|---|
| `frontend/src/editor/store.ts` (modify) | Viewport + `fit`/`actual`/`panTo`; document actions; save state machine; `documentForSave`. |
| `frontend/src/editor/store.test.ts` (modify) | Tests for the above. |
| `frontend/src/editor/placement.ts` (create) | Port of `placement.py`: `placeLabels`, `boxesOverlap`, `boxCrossesRing`, `boxInside`, `ringInsideFrame`; `placeNewLabel` (toggle-on placement against the current enabled boxes). |
| `frontend/src/editor/placement.test.ts` (create) | Replays `tests/fixtures/placement/*.json`; `placeNewLabel` cases. |
| `frontend/src/editor/autosave.ts` (create) | `startAutosave(deps)`: store subscription, debounce, deferral, 409/error handling, `beforeunload`. |
| `frontend/src/editor/autosave.test.ts` (create) | Fake timers + fake api. |
| `frontend/src/editor/EditorCanvas.tsx` (modify) | Viewport from the store; hit circles toggle on click; draggable label groups with select; `Esc`/`Delete`; row-hover highlight already works via `hoveredId`. |
| `frontend/src/editor/LabelTextShape.tsx` (modify) | Draws at the group origin (0, 0) instead of absolute `label.x/y`. |
| `frontend/src/editor/EditorPage.tsx` (modify) | Save status + Retry/Reload in the toolbar; starts the autosave; panel toggle; layout grid with the panel. |
| `frontend/src/editor/objectsFilter.ts` (create) | `TYPE_CHIPS`, `chipFor(type)`, `filterObjects(objects, query, chips)`. |
| `frontend/src/editor/objectsFilter.test.ts` (create) | #37: nova-narrow-shaped list, `hd` hidden by default. |
| `frontend/src/editor/SidePanel.tsx`, `ObjectsTab.tsx`, `LayoutTab.tsx`, `ImageTab.tsx` (create) | The panel and its three tabs. |
| `frontend/src/styles.css` (modify) | Panel layout, tabs, rows, chips, save status. |
| `frontend/e2e/smoke.spec.ts` (modify) | Toggle an object, drag a label, auto-arrange, export from the editor. |
| `docs/SPEC.md` § 6.1–6.3, `docs/ARCHITECTURE.md` (modify) | What M3 delivers; type chips deviation; placement port. |

---

### Task 1: Store — viewport, document actions, save state

**Files:**
- Modify: `frontend/src/editor/store.ts`, `frontend/src/editor/store.test.ts`
- Modify: `frontend/src/editor/EditorCanvas.tsx` (viewport + fit/actual from the store; `CanvasControls` removed), `frontend/src/editor/EditorPage.tsx` (toolbar calls store actions)

**Interfaces:**
- Produces (added to `EditorState`):
  ```ts
  viewport: { w: number; h: number }
  setViewport(w: number, h: number): void        // stores; if nothing has been fitted yet and an image is loaded, fits
  fit(): void                                     // fitView(image, viewport)
  actual(): void                                  // actualSize(view, viewport)
  panTo(objectId: number): void                   // keeps the scale, centres the object in the viewport
  toggleObject(id: number, placed?: { x: number; y: number }): void
      // enabled → disabled (position kept); disabled → enabled at `placed` when given (the canvas passes the placer's result), else at the stored position; marks dirty
  moveLabel(id: number, x: number, y: number): void   // sets x/y, clears collided, marks dirty
  applyLabels(labels: Label[]): void              // replaces every label found by object_id (autoarrange/reset result); marks dirty
  markDirty(): void; markSaving(): void
  markSaved(version: number, updatedAt: string): void   // save.status 'saved' unless changes arrived meanwhile (a `pendingChanges` counter): then 'dirty'
  markSaveError(message: string): void; markConflict(message: string): void
  changeSeq: number                               // increments on every document change; autosave keys on it
  ```
  and `documentForSave(state): AnnotationsUpdate` (labels in `objectOrder`, every stored label included, `version`).
  `EditorCanvas` no longer takes `controlsRef`; `CanvasControls` is deleted.

- [ ] **Step 1: Failing store tests**

Append to `store.test.ts` (reuse the file's existing `LoadedDocument` fixture, which has objects 1 and 2 and a label per object; make sure label 2 is disabled at its object's position and label 1 enabled elsewhere):

```ts
describe('viewport and view actions', () => {
  it('fits on the first viewport size and keeps the view on later resizes', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.setViewport(1000, 500)
    const first = useEditor.getState().view
    expect(first.scale).toBeGreaterThan(0)
    useEditor.getState().setView({ scale: 2, x: 5, y: 5 })
    useEditor.getState().setViewport(1200, 500)
    expect(useEditor.getState().view).toEqual({ scale: 2, x: 5, y: 5 })
  })
  it('panTo centres the object without changing the scale', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.setViewport(1000, 500)
    s.setView({ scale: 0.5, x: 0, y: 0 })
    s.panTo(2)
    const v = useEditor.getState().view
    const obj = doc.objects[1]!
    expect(v.scale).toBe(0.5)
    expect(v.x + obj.x * 0.5).toBeCloseTo(500)
    expect(v.y + obj.y * 0.5).toBeCloseTo(250)
  })
})

describe('document actions', () => {
  it('toggleObject disables and re-enables keeping the position, and marks dirty', () => {
    const s = useEditor.getState()
    s.load(doc)
    const before = s.labels.get(1)!
    s.toggleObject(1)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ enabled: false, x: before.x, y: before.y })
    expect(useEditor.getState().save.status).toBe('dirty')
    useEditor.getState().toggleObject(1)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ enabled: true, x: before.x, y: before.y })
  })
  it('toggleObject enables at the placed position when one is given', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 123, y: 456 })
    expect(useEditor.getState().labels.get(2)).toMatchObject({ enabled: true, x: 123, y: 456, collided: false })
  })
  it('moveLabel sets the position and clears collided', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.applyLabels([{ ...s.labels.get(1)!, collided: true }])
    s.moveLabel(1, 10, 20)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: 10, y: 20, collided: false })
  })
  it('documentForSave lists every label in object order with the loaded version', () => {
    const s = useEditor.getState()
    s.load(doc)
    const out = documentForSave(useEditor.getState())
    expect(out.labels.map((l) => l.object_id)).toEqual(doc.objects.map((o) => o.id))
    expect(out.version).toBe(doc.annotations.version)
    expect(out.style).toEqual(doc.annotations.style)
  })
  it('save state: dirty → saving → saved, but stays dirty if a change landed during the save', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    s.markSaving()
    expect(useEditor.getState().save.status).toBe('saving')
    s.markSaved(5, '2026-09-14T00:00:00+00:00')
    expect(useEditor.getState().save.status).toBe('saved')
    expect(useEditor.getState().version).toBe(5)
    s.toggleObject(1)
    s.markSaving()
    s.toggleObject(1) // a change while saving
    s.markSaved(6, '2026-09-14T00:00:01+00:00')
    expect(useEditor.getState().save.status).toBe('dirty')
    expect(useEditor.getState().version).toBe(6)
  })
  it('conflict and error carry the message', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.markConflict('This image was changed elsewhere. Reload to continue editing.')
    expect(useEditor.getState().save).toEqual({ status: 'conflict', message: 'This image was changed elsewhere. Reload to continue editing.' })
    s.markSaveError('boom')
    expect(useEditor.getState().save.status).toBe('error')
  })
})
```

- [ ] **Step 2: Run to see them fail**, then implement in `store.ts`:

```ts
// state additions
viewport: { w: 0, h: 0 },
fitted: false,          // whether the first fit has happened for this document (reset by load)
changeSeq: 0,
pendingChanges: 0,      // changes since markSaving; markSaved leaves 'dirty' when > 0
```

```ts
setViewport: (w, h) =>
  set((s) => {
    const next: Partial<EditorState> = { viewport: { w, h } }
    if (!s.fitted && s.image && w > 0 && h > 0) {
      next.view = fitView(s.image.width, s.image.height, w, h)
      next.fitted = true
    }
    return next
  }),
fit: () => set((s) => (s.image && s.viewport.w > 0 ? { view: fitView(s.image.width, s.image.height, s.viewport.w, s.viewport.h) } : {})),
actual: () => set((s) => (s.viewport.w > 0 ? { view: actualSize(s.view, s.viewport.w, s.viewport.h) } : {})),
panTo: (id) =>
  set((s) => {
    const obj = s.objects.get(id)
    if (!obj || s.viewport.w <= 0) return {}
    const { scale } = s.view
    return { view: { scale, x: s.viewport.w / 2 - obj.x * scale, y: s.viewport.h / 2 - obj.y * scale } }
  }),
```

Document actions share one helper: `const changed = (s: EditorState, labels: Map<number, Label>) => ({ labels, changeSeq: s.changeSeq + 1, pendingChanges: s.pendingChanges + 1, save: s.save.status === 'conflict' ? s.save : { status: 'dirty' as const, message: null } })` (a conflict is sticky until reload). `toggleObject`, `moveLabel`, `applyLabels` build a new `Map` with the changed entries (never mutate the stored `Label` objects; `useShallow(enabledLabels)` relies on identity). `markSaving: () => set({ pendingChanges: 0, save: { status: 'saving', message: null } })`, `markSaved: (version, updatedAt) => set((s) => ({ version, updatedAt, save: s.pendingChanges > 0 ? { status: 'dirty', message: null } : { status: 'saved', message: null } }))` (add `updatedAt: string` to the state, loaded from the document). `load` resets `fitted`, `changeSeq`, `pendingChanges`.

`EditorCanvas.tsx`: the ResizeObserver calls `useEditor.getState().setViewport(w, h)` and the local `viewport`/`fittedRef` state and the `fit`/`actual` callbacks, `controlsRef` and `CanvasControls` go; the key handler calls `useEditor.getState().fit()` / `.actual()`; the Stage reads `viewport` from the store. `EditorPage.tsx`'s buttons call `useEditor.getState().fit()` / `.actual()`.

- [ ] **Step 3: Run, lint, commit**: `cd frontend && npm test --silent && npm run lint --silent && cd .. && make lint test`; commit `refactor: editor viewport and document actions live in the store`.

---

### Task 2: The placer port

**Files:**
- Create: `frontend/src/editor/placement.ts`, `frontend/src/editor/placement.test.ts`

**Interfaces:**
- Consumes: `metrics.anchorBox`, `metrics.ANCHORS`, `metrics.scaleUnit`, `metrics.Box`, `metrics.measureLabel`, `metrics.markerRadius`, `metrics.TextMeasurer`; the store's `EditorState`.
- Produces (mirrors `backend/app/placement.py` name for name):
  ```ts
  export const GAP_FACTOR = 6, PAD_FACTOR = 4, RING_STEP_FACTOR = 40, MAX_RINGS = 4
  export interface PlacementItem { id: number; x: number; y: number; radius: number; w: number; h: number }
  export interface Placement { id: number; x: number; y: number; collided: boolean }
  export interface Circle { x: number; y: number; r: number }
  export function boxesOverlap(a: Box, b: Box, pad: number): boolean
  export function boxCrossesRing(box: Box, c: Circle, pad: number): boolean
  export function boxInside(box: Box, width: number, height: number): boolean
  export function ringInsideFrame(it: PlacementItem, width: number, height: number): boolean
  export function placeLabels(width: number, height: number, items: PlacementItem[], fixedBoxes?: Box[], fixedCircles?: Circle[]): Placement[]
  export function placeNewLabel(state: EditorState, measure: TextMeasurer, id: number): { x: number; y: number; collided: boolean } | null
      // the object's label measured with the current style, placed against every other enabled label's box and marker; null when the object or style is missing
  ```

- [ ] **Step 1: Failing tests**

The vectors are imported as JSON (`resolveJsonModule` is on; vitest has no node types), one import per file:

```ts
import { describe, expect, it } from 'vitest'
import collision from '../../../tests/fixtures/placement/collision_forced.json'
import edge from '../../../tests/fixtures/placement/edge_left_fallback.json'
import fixed from '../../../tests/fixtures/placement/fixed_obstacles.json'
import huge from '../../../tests/fixtures/placement/huge_marker_centre_label.json'
import random0 from '../../../tests/fixtures/placement/random_0.json'
import random1 from '../../../tests/fixtures/placement/random_1.json'
import random2 from '../../../tests/fixtures/placement/random_2.json'
import single from '../../../tests/fixtures/placement/single_right.json'
import stacked from '../../../tests/fixtures/placement/stacked_same_position.json'
import type { Box } from './metrics'
import { PAD_FACTOR, boxesOverlap, placeLabels, placeNewLabel, type Circle, type Placement, type PlacementItem } from './placement'
import { scaleUnit, measureLabel } from './metrics'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

interface Vector {
  name: string
  width: number
  height: number
  items: PlacementItem[]
  fixed_boxes: Box[]
  fixed_circles: Circle[]
  expected: Placement[]
}
const VECTORS = [collision, edge, fixed, huge, random0, random1, random2, single, stacked] as unknown as Vector[]

describe('placeLabels', () => {
  for (const v of VECTORS) {
    it(`reproduces ${v.name}`, () => {
      const got = placeLabels(v.width, v.height, v.items, v.fixed_boxes, v.fixed_circles)
      expect(got.length).toBe(v.expected.length)
      got.forEach((p, i) => {
        const want = v.expected[i]!
        expect(p.id).toBe(want.id)
        expect(p.collided).toBe(want.collided)
        expect(Math.abs(p.x - want.x)).toBeLessThanOrEqual(1e-9)
        expect(Math.abs(p.y - want.y)).toBeLessThanOrEqual(1e-9)
      })
    })
  }
})

describe('placeNewLabel', () => {
  const measure = () => 100 // every string 100 px wide; heights come from the size

  it('places a never-placed label next to its marker, clear of the enabled boxes', () => {
    const doc = makeDoc() // objects 1 and 2 close together; label 1 enabled and placed, label 2 disabled at its object
    useEditor.getState().load(doc)
    const state = useEditor.getState()
    const obj2 = state.objects.get(2)!
    const placed = placeNewLabel(state, measure, 2)
    expect(placed).not.toBeNull()
    expect([placed!.x, placed!.y]).not.toEqual([obj2.x, obj2.y])
    const label1 = state.labels.get(1)!
    const box1 = measureLabel(measure, state.style!, label1, state.objects.get(1)!)
    const box2 = measureLabel(measure, state.style!, state.labels.get(2)!, obj2)
    const pad = PAD_FACTOR * scaleUnit(doc.image.width, doc.image.height)
    expect(
      boxesOverlap(
        { left: label1.x, top: label1.y, right: label1.x + box1.width, bottom: label1.y + box1.height },
        { left: placed!.x, top: placed!.y, right: placed!.x + box2.width, bottom: placed!.y + box2.height },
        pad,
      ),
    ).toBe(false)
  })

  it('returns null for an unknown object', () => {
    useEditor.getState().load(makeDoc())
    expect(placeNewLabel(useEditor.getState(), measure, 999)).toBeNull()
  })
})
```

`frontend/src/editor/testDoc.ts` exports `makeDoc(): LoadedDocument` (move the fixture out of `store.test.ts` and import it there): a 3000 × 2000 image, `StyleConfig` with `Inter-Regular.ttf`, size 24, `marker_min_radius` 6; objects 1 `{x: 1500, y: 1000, radius: 40}` and 2 `{x: 1560, y: 1010, radius: 0}`; labels: 1 enabled at `{x: 1552, y: 970}` (the placer's "right" anchor for object 1), 2 disabled at `{x: 1560, y: 1010}`; one `FontOut` for the file with 195 ascents of 20.

- [ ] **Step 2: Implement** `placement.ts` as a line-by-line port of `placement.py` (`_search` becomes `search`, same loop order: rings 0..MAX_RINGS, anchors in `ANCHORS` order; sort `items` by `(-radius, id)`; the centre-label fallback when `!ringInsideFrame`; the collided fallback at `anchorBox('right', ...)`). `placeNewLabel`:

```ts
export function placeNewLabel(state: EditorState, measure: TextMeasurer, id: number) {
  const { image, style } = state
  const obj = state.objects.get(id)
  const label = state.labels.get(id)
  if (!image || !style || !obj || !label) return null
  const box = measureLabel(measure, style, label, obj)
  const fixedBoxes: Box[] = []
  const fixedCircles: Circle[] = []
  for (const other of enabledLabels(state)) {
    if (other.object_id === id) continue
    const o = state.objects.get(other.object_id)
    if (!o) continue
    const b = measureLabel(measure, style, other, o)
    fixedBoxes.push({ left: other.x, top: other.y, right: other.x + b.width, bottom: other.y + b.height })
    fixedCircles.push({ x: o.x, y: o.y, r: markerRadius(o, style) })
  }
  const [p] = placeLabels(image.width, image.height, [{ id, x: obj.x, y: obj.y, radius: markerRadius(obj, style), w: box.width, h: box.height }], fixedBoxes, fixedCircles)
  return p ? { x: p.x, y: p.y, collided: p.collided } : null
}
```

- [ ] **Step 3: Run, lint, commit**: `refactor: TypeScript port of the label placer, pinned to the shared vectors` (this also satisfies SPEC § 6.4's "identical in TS and Python").

---

### Task 3: Autosave

**Files:**
- Create: `frontend/src/editor/autosave.ts`, `frontend/src/editor/autosave.test.ts`

**Interfaces:**
- Consumes: `useEditor` (`changeSeq`, `save`, `image`, `documentForSave`, `markSaving`, `markSaved`, `markSaveError`, `markConflict`), `api.saveAnnotations`, `ApiError`, `describeError`.
- Produces:
  ```ts
  export const AUTOSAVE_DELAY_MS = 500
  export interface AutosaveDeps { save: (id: string, doc: AnnotationsUpdate) => Promise<Annotations>; now?: () => number }
  export function startAutosave(imageId: string, deps?: Partial<AutosaveDeps>): () => void   // returns stop(); installs beforeunload while dirty/saving
  export function flushSave(): Promise<void>   // used by export: waits for a pending or in-flight save to settle (resolves immediately when 'saved' or 'conflict')
  export function retrySave(): void            // from the toolbar's Retry button: schedules a save now
  ```

- [ ] **Step 1: Failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type Annotations, type AnnotationsUpdate } from '../api'
import { AUTOSAVE_DELAY_MS, flushSave, retrySave, startAutosave } from './autosave'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

const CONFLICT = 'This image was changed elsewhere. Reload to continue editing.'

function fakeSave() {
  const calls: AnnotationsUpdate[] = []
  let release: ((r: Annotations) => void) | null = null
  let fail: ApiError | null = null
  const save = (_id: string, doc: AnnotationsUpdate): Promise<Annotations> => {
    calls.push(doc)
    if (fail) return Promise.reject(fail)
    return new Promise((resolve) => {
      release = (r) => resolve(r)
    })
  }
  const done = (doc: AnnotationsUpdate) =>
    release?.({ ...doc, version: doc.version + 1, updated_at: 't', image_id: 'img' } as Annotations)
  return { calls, save, done, setFail: (e: ApiError | null) => (fail = e) }
}

let stop: () => void
beforeEach(() => {
  vi.useFakeTimers()
  useEditor.getState().load(makeDoc())
})
afterEach(() => {
  stop?.()
  vi.useRealTimers()
})

describe('autosave', () => {
  it('saves 500 ms after the last change, once, with the labels in object order', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(300)
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(f.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.version).toBe(1)
    expect(f.calls[0]!.labels.map((l) => l.object_id)).toEqual([1, 2])
    expect(useEditor.getState().save.status).toBe('saving')
    f.done(f.calls[0]!)
    await flushSave()
    expect(useEditor.getState().save.status).toBe('saved')
    expect(useEditor.getState().version).toBe(2)
  })

  it('defers a change made during a save until the save returns', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(1)
    useEditor.getState().toggleObject(2, { x: 1, y: 2 })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(1) // still in flight
    f.done(f.calls[0]!)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]!.version).toBe(2)
  })

  it('409 → conflict with the server sentence and no further saves', async () => {
    const f = fakeSave()
    f.setFail(new ApiError(409, CONFLICT))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    await flushSave()
    expect(useEditor.getState().save).toEqual({ status: 'conflict', message: CONFLICT })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(1)
  })

  it('other failures → error, and retrySave saves again', async () => {
    const f = fakeSave()
    f.setFail(new ApiError(500, 'boom'))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    await flushSave()
    expect(useEditor.getState().save.status).toBe('error')
    f.setFail(null)
    retrySave()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(2)
  })

  it('does not save while the image is not solved', async () => {
    const doc = makeDoc()
    doc.image = { ...doc.image, solve_status: 'solving' }
    useEditor.getState().load(doc)
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(0)
    expect(useEditor.getState().save.status).toBe('dirty')
  })
})
```

The `beforeunload` behaviour is covered by inspection plus the smoke test (vitest runs in node, where `window` does not exist): `startAutosave` must guard `typeof window !== 'undefined'` before adding the listener.

- [ ] **Step 2: Implement** `autosave.ts`: a module-level controller with `timer`, `inFlight: Promise<void> | null`, `wanted: boolean`; `startAutosave` subscribes `useEditor.subscribe((s, prev) => { if (s.changeSeq !== prev.changeSeq) schedule() })`; `schedule()` clears/sets the 500 ms timer; `run()`: if status is `conflict` or the image is not solved, return; `markSaving()`; `deps.save(imageId, documentForSave(state))` → `markSaved(res.version, res.updated_at)`; on `ApiError` with `status === 409` → `markConflict(err.message)`; on any other error → `markSaveError(describeError(err))`; finally, if `pendingChanges > 0` (state) and status is `dirty`, schedule again. `flushSave` returns the in-flight promise chained with a pending timer's run. `beforeunload` handler: `if (status === 'dirty' || status === 'saving') { e.preventDefault(); e.returnValue = '' }`.

- [ ] **Step 3: Run, lint, commit**: `feat: editor autosave with deferral, conflict and retry`.

---

### Task 4: Canvas interactions and toolbar status

**Files:**
- Modify: `frontend/src/editor/EditorCanvas.tsx`, `frontend/src/editor/LabelTextShape.tsx`, `frontend/src/editor/EditorPage.tsx`, `frontend/src/styles.css`

**Interfaces:**
- Consumes: store actions (Task 1), `placeNewLabel` (Task 2), `startAutosave`/`retrySave` (Task 3).
- Produces: the interactions below; the `EditorTestHook` unchanged.

- [ ] **Step 1: Label groups**

`LabelTextShape` draws at `(0, 0)`: replace `label.x`/`label.y` in `fillText`/`strokeText`/`hitFunc` with `0`/`0` (the box rect is `0, 0, box.width, box.height`); it keeps `label` for `color` and the alias line. In `AnnotationLayer`, per entry render the marker `Circle` and the leader `Line` as now (absolute, `listening={false}`), then:

```tsx
<Group
  x={label.x}
  y={label.y}
  draggable={editable}
  onMouseDown={(e) => { e.cancelBubble = true; select(label.object_id) }}
  onDragStart={() => select(label.object_id)}
  onDragMove={(e) => moveLabel(label.object_id, e.target.x(), e.target.y())}
  onDragEnd={(e) => moveLabel(label.object_id, e.target.x(), e.target.y())}
>
  <LabelTextShape ... />
</Group>
```

The layer becomes `listening={editable}` where `editable = image.solve_status === 'solved' && save.status !== 'conflict'` (a conflict keeps editing local per the design, so keep `editable` true on conflict and only block saves — decide: editing continues locally, so `editable = solved`). `select` and `moveLabel` come from the store; pass them into `AnnotationLayer` as props (they are stable). `onDragMove` updates the store on every frame; the `entries` memo recomputes only the moved label's box because `measureLabel` is cheap, but memoise per label anyway: keep a `Map<Label, Entry>` cache keyed by label identity inside the memo so unchanged labels are reused.

- [ ] **Step 2: Toggle by click and keys**

Hit circles: `onClick={() => { if (!editable) return; const s = useEditor.getState(); const label = s.labels.get(id); if (!label) return; if (label.enabled) { s.toggleObject(id); return } const obj = s.objects.get(id)!; const untouched = label.x === obj.x && label.y === obj.y; s.toggleObject(id, untouched ? (placeNewLabel(s, measure, id) ?? undefined) : undefined) }}`. A click on empty stage (target === stage, no pan movement) deselects. Keys: `Escape` → `select(null)`; `Delete`/`Backspace` (not in a field) → if `selectedId !== null && editable` then `toggleObject(selectedId)` and `select(null)`.

- [ ] **Step 3: Toolbar status and autosave start**

`EditorPage`: after `load`, `startAutosave(id)` in the same effect; stop it in the cleanup. Toolbar right side: `<span className="save-status">` showing `Saved` / `Saving…` / `Unsaved changes` (dirty) / the error sentence + `<button onClick={retrySave}>Retry</button>` / the conflict sentence + `<button onClick={() => window.location.reload()}>Reload</button>`. When `solve_status !== 'solved'`, the existing notice stays and the status reads `Read-only while solving`.

- [ ] **Step 4: Manual check on the dev servers** (click a marker to toggle, drag a label, watch "Saving…" then "Saved"; refresh and see the layout persisted; open a second tab, save there, then save in the first → the conflict sentence and Reload). Then `npm run lint`, `npm test`, `make lint test`; commit `feat: toggle, select, drag and autosave in the editor`.

---

### Task 5: Side panel — Objects, Layout, Image

**Files:**
- Create: `frontend/src/editor/objectsFilter.ts`, `objectsFilter.test.ts`, `SidePanel.tsx`, `ObjectsTab.tsx`, `LayoutTab.tsx`, `ImageTab.tsx`
- Modify: `frontend/src/editor/EditorPage.tsx`, `frontend/src/styles.css`

**Interfaces:**
- `objectsFilter.ts`:
  ```ts
  export type Chip = 'ngc' | 'ic' | 'bright' | 'hd' | 'other'
  export const CHIPS: readonly Chip[] = ['ngc', 'ic', 'bright', 'hd', 'other']
  export const CHIP_LABELS: Record<Chip, string> = { ngc: 'NGC', ic: 'IC', bright: 'Bright stars', hd: 'HD stars', other: 'Other' }
  export const DEFAULT_CHIPS: ReadonlySet<Chip> = new Set(['ngc', 'ic', 'bright', 'other'])   // hd off (#37)
  export function chipFor(type: string): Chip
  export function filterObjects(objects: ObjectOut[], query: string, chips: ReadonlySet<Chip>): ObjectOut[]  // case-insensitive substring over every catalog name; order preserved
  ```
- `SidePanel({ open, onToggle })` with tabs `Objects | Layout | Image`; `ObjectsTab`, `LayoutTab`, `ImageTab` read the store.

- [ ] **Step 1: Filter tests** (`objectsFilter.test.ts`): a list mirroring nova-narrow — 8 objects: IC 5070 (`ic`), 56 Cyg (`bright`), 57 Cyg (`bright`), and five `hd` (HD 198639, HD 199081, HD 198896, HD 198931, HD 199178); with `DEFAULT_CHIPS` three remain; adding `hd` shows eight; query `"cyg"` with defaults gives two; query `"198"` with `hd` on gives three; `chipFor('messier')` is `'other'`.

- [ ] **Step 2: Components**

`ObjectsTab`: search input (`aria-label="Search objects"`), chips as toggle buttons (`aria-pressed`), the list (`<ul>` rows: checkbox bound to `label.enabled` → the same toggle logic as the canvas click (factor it into `toggleWithPlacement(id, measure)` in `EditorCanvas.tsx` or a small `editing.ts` module both call — put it in `editing.ts`, which needs a measurer: create the offscreen measurer there as a module-level lazy singleton and have `EditorCanvas` use the same one), primary name as a button that calls `panTo(id)`, type, radius `Math.round(obj.radius)` px; `onMouseEnter`/`onMouseLeave` → `hover(id)`/`hover(null)`), and "Enable shown" / "Disable shown" buttons acting on the filtered list. `LayoutTab`: "Auto-arrange" → `api.autoarrange(id, documentForSave(state))` → `applyLabels(res.labels)` (409 → `markConflict`); "Reset positions" → `window.confirm('Put every enabled label back at its object and auto-arrange?')` then `applyLabels(enabled labels at their object's (x, y) with collided false)` and the same autoarrange call; shows `N labels overlap` (count of `collided`). `ImageTab`: field centre (`calibration.ra`/`dec` to 3 decimals), size (`2 × radius`°), rotation (`orientation`°), pixel scale; the nova status link (`image.nova_status_url`); "Export" → `await flushSave()` then `api.exportImage(id, null, 1)` → result line (`formatBytes(bytes)`, `encoding`) and the download link (`export_url`) — busy state while rendering; errors via `pageError`.

`EditorPage`: layout `editor-body` grid: canvas + `SidePanel` (320 px) with a collapse toggle to a 32 px strip. CSS: `.editor-body { display: grid; grid-template-columns: 1fr 320px; flex: 1; min-height: 0 }`, `.editor-body.collapsed { grid-template-columns: 1fr 32px }`, `.side-panel { border-left: 1px solid var(--border); overflow: auto; }`, tabs, `.chip[aria-pressed=true]`, `.object-row`, `.save-status`.

- [ ] **Step 3: Manual check**, `npm run lint`, `npm test`, `make lint test`; commit `feat: editor side panel — objects, layout and image tabs`.

---

### Task 6: Smoke steps, docs, PR

**Files:**
- Modify: `frontend/e2e/smoke.spec.ts`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Smoke additions** after the existing editor step (before `page.goto('/')`): read the initial enabled count from `/api/images/<id>/annotations` via `page.request`; click the object row checkbox of a currently disabled object in the Objects tab (or an enabled one) and `expect.poll` the API's enabled count to change by one within 3 s (the autosave); drag the first label group by 40 px with `page.mouse` (locate via the canvas: use the hook `window.__astrocaptionEditor.stage.find('Group')` — add `labelPositions(): {id, x, y}[]` to the hook for this) and `expect.poll` the API label's `x` to have moved; click "Auto-arrange" in the Layout tab and expect the status to return to "Saved"; in the Image tab click Export and expect the download link. Keep `expect(errors).toEqual([])`. `make e2e` green.

- [ ] **Step 2: Docs**: SPEC § 6.1–6.3: what M3 delivers (toggle, select/drag, keys, autosave sentences, the three tabs) and the type-chip deviation (nova types until OpenNGC types arrive in M4); § 6.4: the TypeScript port exists (`frontend/src/editor/placement.ts`, pinned by the shared vectors); ARCHITECTURE: editor paragraph mentions autosave.ts, placement.ts, the panel.

- [ ] **Step 3**: `make lint test && make e2e`; commit `docs: editor interactions`; push `feat/editor-interactions`; `gh pr create --title "feat: editor interactions (milestone 3, PR 5)"` (body: the list above, `Closes #37`, `Part of #55`); `gh pr checks --watch`; stop for the owner's smoke test and "merge".
