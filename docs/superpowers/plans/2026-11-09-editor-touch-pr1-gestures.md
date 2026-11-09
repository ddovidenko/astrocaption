# Touch gestures in the editor (#57, PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the editor a finger pinches and pans the photo, selects and moves labels, and toggles objects, and the page itself never zooms or scrolls.

**Architecture:** Touch handlers sit beside the mouse handlers in `canvasGestures.ts` and are spread onto the same Konva `Stage`, label groups and hit circles; they drive the same zustand store calls, so nothing downstream changes. The only new arithmetic is a pure `pinchView` in `view.ts`. Page zoom is switched off with CSS (`touch-action`, 16 px fields) scoped to the editor route.

**Tech Stack:** React 19, TypeScript strict, Konva 10 / react-konva 19, zustand, vitest + Testing Library (jsdom), Playwright (Chromium, CDP touch input).

**Spec:** `docs/superpowers/specs/2026-11-09-editor-touch-design.md` (sections "Gestures on the canvas (PR 1)", "Tests", "Documents", "PRs" item 1). PRs 2 and 3 get their own plans after this one merges.

## Global Constraints

- No new dependencies.
- Nothing drawn changes: annotation JSON, `render.py`, `metrics.ts`, the placer and every vector fixture are untouched; `parity.spec.ts` passes unmodified.
- A mouse user notices nothing: every existing vitest and Playwright spec passes unmodified.
- Touch is decided per event (Konva `touchstart`/`touchmove`/`touchend`/`tap`), never per device. "Compact" (layout only) is `(pointer: coarse)` or `(max-width: 640px)`.
- Tap slack is 10 screen px for touch; the mouse's stays 3.
- Hit-circle floor is 16 screen px when compact, 8 otherwise.
- Editor fields render at 16 px or more under `(pointer: coarse)`.
- `index.html`'s viewport tag does not change. No `user-scalable=no`.
- Coordinates stay in original image pixels in the store; convert at the edges only (CLAUDE.md).
- Component tests: `*.test.tsx` beside the component, `// @vitest-environment jsdom` on line 1.
- Stage by path, conventional commits, branch `feat/editor-touch-57` (already created; the design commit is on it). Never push to `main`; do not merge without the owner's explicit go.
- Deviation from the spec, decided here: the spec asks for a separate Playwright project matching `*.touch.spec.ts`. `e2e/layout.spec.ts` already gets phone emulation with `test.use({ viewport, isMobile, hasTouch })` inside the default Chromium project, so the new spec does the same and `playwright.config.ts` is not touched. Same engine, same CI cost, one less convention.

## Review Focus

Inputs the spec implies that are most likely to bite, each pinned by a test in the task named:

1. Two fingers at the same point, or a pinch pushed past a zoom limit: the view must stay finite and clamped, never `NaN` (Task 1).
2. A finger that wobbles 6 px while tapping a selected label (more than the mouse's 3, less than touch's 10): the label must not move, pin or add an undo entry (Task 5).
3. Fingers lifting one at a time after a pinch: the finger still down must not pan, drag or count as a tap (Task 4).
4. A `touchcancel` mid-gesture (a call comes in): the next touch must work normally and nothing is committed (Task 4).
5. A mouse used after a touch on the same page (touch-screen laptop): wheel zoom and a label drag still work, no touch state is stuck (Task 6).

Not automated, checked in the smoke test: a read-only document during a re-solve (labels not selectable, second tap does not toggle).

---

### Task 1: `pinchView` in `view.ts`

**Files:**
- Modify: `frontend/src/editor/view.ts`
- Test: `frontend/src/editor/view.test.ts`

**Interfaces:**
- Produces: `export interface ScreenPoint { x: number; y: number }` and
  `export function pinchView(view: View, prevMid: ScreenPoint, prevDist: number, mid: ScreenPoint, dist: number, min = MIN_SCALE, max = MAX_SCALE): View`.
  Points are stage-container pixels. The world point under `prevMid` ends up under `mid`; scale is multiplied by `dist / prevDist` and clamped.

- [ ] **Step 1: Write the failing tests** in a new `describe('pinchView')`:

```ts
const v: View = { scale: 0.5, x: 100, y: 50 }
it('is the identity when nothing moved', () => {
  expect(pinchView(v, { x: 200, y: 200 }, 80, { x: 200, y: 200 }, 80)).toEqual(v)
})
it('keeps the world point under the midpoint while zooming', () => {
  const out = pinchView(v, { x: 200, y: 200 }, 80, { x: 200, y: 200 }, 160)
  expect(out.scale).toBeCloseTo(1)
  expect(toWorld(out, 200, 200)).toEqual(toWorld(v, 200, 200))
})
it('pans with the midpoint', () => {
  const out = pinchView(v, { x: 200, y: 200 }, 80, { x: 230, y: 180 }, 80)
  expect(out).toEqual({ scale: 0.5, x: 130, y: 30 })
})
it('zooms and pans in one step', () => {
  const out = pinchView(v, { x: 200, y: 200 }, 80, { x: 230, y: 180 }, 160)
  const w = toWorld(v, 200, 200)
  expect(toScreen(out, w.x, w.y)).toEqual({ x: 230, y: 180 })
})
it('clamps at both limits and still follows the midpoint', () => {
  expect(pinchView(v, { x: 0, y: 0 }, 1, { x: 0, y: 0 }, 1e6).scale).toBe(MAX_SCALE)
  expect(pinchView(v, { x: 0, y: 0 }, 1e6, { x: 0, y: 0 }, 1).scale).toBe(MIN_SCALE)
})
it('returns the view unchanged for a zero or non-finite distance', () => {
  expect(pinchView(v, { x: 1, y: 1 }, 0, { x: 9, y: 9 }, 50)).toBe(v)
  expect(pinchView(v, { x: 1, y: 1 }, 50, { x: 9, y: 9 }, 0)).toBe(v)
  expect(pinchView(v, { x: 1, y: 1 }, NaN, { x: 9, y: 9 }, 50)).toBe(v)
})
```

- [ ] **Step 2: Run** `npm --prefix frontend test -- view.test.ts`. Expected: FAIL, `pinchView` is not exported.
- [ ] **Step 3: Implement `pinchView`** in `view.ts` by composing `zoomAt` about `prevMid` and then adding `mid − prevMid` to `x`, `y`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pinch arithmetic for the editor view (#57)` (`view.ts`, `view.test.ts`).

### Task 2: `useCompactEditor`

**Files:**
- Create: `frontend/src/editor/compact.ts`
- Test: `frontend/src/editor/compact.test.tsx`

**Interfaces:**
- Produces: `export const COMPACT_QUERY = '(pointer: coarse), (max-width: 640px)'` and
  `export function useCompactEditor(): boolean`. Live (re-renders when the query flips); `false` where `window.matchMedia` is not a function (jsdom), so existing component tests are unaffected.

- [ ] **Step 1: Write the failing tests** (`renderHook`):
  - no `matchMedia` on `window` → `false`;
  - `matchMedia` stubbed to `{ matches: true, addEventListener, removeEventListener }` and asserted to be called with `COMPACT_QUERY` → `true`;
  - the stub's `change` listener invoked after `matches` flips to `false` → the hook returns `false`;
  - unmount removes the listener (the stub's `removeEventListener` was called with the same function).
- [ ] **Step 2: Run** `npm --prefix frontend test -- compact.test.tsx`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** with `useSyncExternalStore` (subscribe = the media query list's `change` event, snapshot = `.matches`).
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat: compact-editor media query hook (#57)`.

### Task 3: the colour picker closes on a touch outside it

Konva cancels `touchstart` on the canvas, so no compatibility `mousedown` reaches the document and the picker's click-away never fires on touch.

**Files:**
- Modify: `frontend/src/style/ColorField.tsx` (the `away` effect event and the open-effect that wires `mousedown`)
- Test: `frontend/src/style/ColorField.test.tsx`

**Interfaces:**
- Produces: no API change. While open, a `touchstart` on the document outside the field closes the picker through the existing `closePicker(false)`; the `openRef` guard keeps it to one terminal callback when a `mousedown` follows.

- [ ] **Step 1: Write the failing tests**, next to "click away…":
  - open the picker, `fireEvent.touchStart(document.body)` → popover gone, `onCommit` called once;
  - `fireEvent.touchStart(document.body)` then `fireEvent.mouseDown(document.body)` → `onCommit` still called once;
  - `fireEvent.touchStart` on the picker surface itself → stays open, `onCommit` not called.
- [ ] **Step 2: Run** `npm --prefix frontend test -- ColorField.test.tsx`. Expected: the three new cases FAIL.
- [ ] **Step 3: Implement**: widen `away` to `MouseEvent | TouchEvent` and add/remove a `touchstart` document listener beside `mousedown`.
- [ ] **Step 4: Run** again. Expected: PASS, the existing cases included.
- [ ] **Step 5: Commit** `fix: the colour picker closes on a touch outside it (#57)`.

### Task 4: pinch, one-finger pan, and a page that stays put

**Files:**
- Modify: `frontend/e2e/helpers.ts` (touch input helper)
- Create: `frontend/e2e/touch.spec.ts`
- Modify: `frontend/src/editor/canvasGestures.ts`, `frontend/src/editor/EditorCanvas.tsx` (spread only), `frontend/src/styles.css`

**Interfaces:**
- Consumes: `pinchView` (Task 1).
- Produces, in `e2e/helpers.ts`:

```ts
export interface TouchPoint { x: number; y: number; id?: number }   // page CSS px; id defaults to the index
export interface TouchDriver {
  start(points: TouchPoint[]): Promise<void>     // Input.dispatchTouchEvent touchStart
  move(points: TouchPoint[]): Promise<void>      // touchMove
  end(remaining?: TouchPoint[]): Promise<void>   // touchEnd; `remaining` are the fingers still down
  cancel(): Promise<void>                        // touchCancel
  /** One finger down at `from`, `steps` moves, up at `to`. */
  drag(from: TouchPoint, to: TouchPoint, steps?: number): Promise<void>
  /** Two fingers `fromDist` apart around `center`, moved in `steps` to `toDist` apart around `center + shift`. */
  pinch(center: TouchPoint, fromDist: number, toDist: number, opts?: { steps?: number; shift?: { x: number; y: number } }): Promise<void>
}
export async function touchDriver(page: Page): Promise<TouchDriver>   // page.context().newCDPSession(page)
```

- Produces, in `canvasGestures.ts`: `CanvasGestures.stage` gains `onTouchStart`, `onTouchMove`, `onTouchEnd`, `onTouchCancel` (each `(e: Konva.KonvaEventObject<TouchEvent>) => void`); `EditorCanvas.tsx` keeps `{...gestures.stage}`. `CanvasGestures.moved()` keeps its meaning for both inputs. Later tasks rely on these internals of the hook:
  - a touch gesture state held in refs: the one-finger pan anchor, the pinch's previous midpoint and distance, and a "spent" flag set when a second finger lands, cleared when the last finger lifts;
  - `movedRef` set `true` once a single finger travels more than 10 px, and for the whole gesture once a second finger lands.

- [ ] **Step 1: Write `touchDriver`** in `helpers.ts`.
- [ ] **Step 2: Write the failing spec** `touch.spec.ts`. File header: `test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })`. One `test('touch: pinch and pan move the photo, never the page', …)` that opens the Orion image's editor as `gestures.spec.ts` does (reuse its `readStage` shape and "empty canvas point" logic; lift both into `helpers.ts` if importing them is cleaner than copying) and asserts, in order:
  1. `pinch(center of canvas, 80, 160)` → `readStage().scale` is 2 × before within 2 %, the world point under the centre is unchanged within 1 px, the top bar's percentage text changed, `window.visualViewport.scale === 1`, `window.scrollX === 0 && window.scrollY === 0`.
  2. `pinch(a point on .editor-toolbar, 80, 160)` → `readStage()` deep-equals before, `visualViewport.scale === 1`.
  3. `drag(empty, empty + (−30, −20))` → stage `x`, `y` moved by (−30, −20) within 1 px, scale unchanged, `.save-status` reads `Saved`.
  4. Lifting one at a time: `start([a, b])`, `move` both apart, `end([a])`, `move([a + (40, 40)])`, `end()` → the view is what it was right after the two-finger move; selection unchanged.
  5. Cancel: `start([p])`, `move([p + (30, 0)])`, `cancel()` → then `drag(empty, empty + (20, 10))` pans by exactly (20, 10) from where the view was at the cancel; `.save-status` reads `Saved`.
- [ ] **Step 3: Run** `npm --prefix frontend run build && cd frontend && E2E_START_APP=1 npx playwright test touch.spec.ts`. Expected: FAIL at assertion 1 (the stage scale does not change; in Chromium the page zooms instead).
- [ ] **Step 4: Add the CSS** to `styles.css`, beside the existing `.editor-canvas` and `body:has(> #root > main.editor-main)` rules, each with a one-line why-comment:

```css
.editor-canvas { touch-action: none; }
body:has(> #root > main.editor-main) { touch-action: pan-x pan-y; overscroll-behavior: none; }
```

- [ ] **Step 5: Implement the stage touch handlers** in `canvasGestures.ts`:
  - `onTouchStart`: `e.evt.preventDefault()` when cancelable (Konva only does this on listening shapes; without it bare sky gets compatibility mouse events after the tap). One touch: reset `movedRef`, record the anchor. Two touches: drop the pan anchor, mark the gesture spent and moved, record midpoint and distance in stage-container pixels (`touch.clientX/Y − stage.container().getBoundingClientRect()`).
  - `onTouchMove`: two touches → `setView(pinchView(view, prevMid, prevDist, mid, dist))`, then store the new midpoint and distance. One touch, gesture not spent → once travel exceeds 10 px set `movedRef` and re-anchor the pan at that point (so the photo does not jump by the slack), then pan as `onMouseMove` does. One touch, gesture spent → nothing.
  - `onTouchEnd` / `onTouchCancel`: clear the pinch state; when `e.evt.touches.length === 0` clear the anchor and the spent flag.
  - `Konva.hitOnDragEnabled = true` in an effect for the hook's lifetime, restoring the previous value on unmount (Konva's documented requirement for `touchmove` during a node drag).
- [ ] **Step 6: Run** the Step 3 command. Expected: PASS. Then `npm --prefix frontend test` and `npm --prefix frontend run lint`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: pinch-zoom and one-finger pan in the editor; the page no longer zooms (#57)`.

### Task 5: labels by touch

**Files:**
- Modify: `frontend/src/editor/canvasGestures.ts`, `frontend/src/editor/EditorCanvas.tsx` (the label `Group` in the entry component, ~lines 200–235)
- Test: `frontend/e2e/touch.spec.ts`

**Interfaces:**
- Consumes: Task 4's stage handlers and gesture refs; `touchDriver`.
- Produces: `CanvasGestures.label` gains
  - `onTouchPress(id: number): void`, called from the label group's `onTouchStart` (it fires before the stage's, as `onPress` does for the mouse). Records whether the pressed label is selected, so the stage's `onTouchStart` skips the pan anchor for a selected label and a drag owns that finger;
  - `onTap(id: number): void`, selects the label (replacing the selection) and clears the hover, unless `moved()`;
  - `blocksDrag(e: Konva.KonvaEventObject<DragEvent>, id: number): boolean`, `true` when the drag was started by a touch (`e.evt.type` starts with `touch`) on a label that is not selected.
- Produces: the stage's `onTap` (target is the stage, not moved) clears the selection and the hover; the stage's `onTouchStart` gains "end an edit in progress": before anything else, `document.activeElement.blur()` when it is an `HTMLElement` other than `body`.

- [ ] **Step 1: Add the failing tests** to `touch.spec.ts`, a second `test('touch: a label moves only once it is selected', …)` wrapped in `withAnnotationsRestored`:
  1. `drag(labelPoint, labelPoint + (60, 40))` on an unselected label → the stage panned by (60, 40) within 1 px; the label's drawn and stored positions are unchanged; `selectedIds()` is `[]`; Undo is disabled; `.save-status` reads `Saved`.
  2. `page.touchscreen.tap(labelPoint)` → `selectedIds()` equals `[id]`, the label toolbar is visible.
  3. Wobble: `start([labelPoint])`, `move([labelPoint + (6, 0)])`, `end()` on the now-selected label → position unchanged, Undo still disabled, still selected.
  4. `drag(labelPoint, labelPoint + (50, 30))` → the label's stored position moved by (50, 30) / scale within 1 original px, stage transform unchanged, Undo enabled; one Undo restores the position and disables Undo again.
  5. Second finger during a drag: `start([labelPoint])`, `move` by (40, 0), `start([labelPoint + (40, 0), other])`, pinch `move`, `end()` → the label sits 40 / scale to the right (committed where it was when the second finger landed), exactly one undo entry, and the scale changed.
  6. Ends an edit in progress: with the label selected, focus the toolbar's "Font size" field, type a different size without Enter, `page.touchscreen.tap(empty)` → the stored `font_size` is the typed value and the selection is empty.
  7. `page.touchscreen.tap(empty)` with a selection → `selectedIds()` is `[]`.
- [ ] **Step 2: Run** the Task 4 Step 3 command. Expected: the new test FAILS at 1 (the label moves; Konva drags it).
- [ ] **Step 3: Implement** in the label `Group`:
  - `onTouchStart` → `onTouchPress(id)` and `e.currentTarget.dragDistance(10)`; the existing `onMouseDown` path sets `dragDistance(3)` back, so a mouse drag is what it was.
  - `onTap` → `gestures.label.onTap(id)`.
  - `onDragStart`: if `blocksDrag(e, id)` → `e.target.stopDrag()`, remember that this drag was refused, and return before the existing "select on drag start" line. Konva supports stopping inside `dragstart` (`DragAndDrop.js`: "a user can stop dragging inside `dragstart`") and does not move the node.
  - `onDragMove` / `onDragEnd`: skip `moveLabel` for a refused drag, and clear the flag in `onDragEnd`, so no undo entry and no pin is recorded.
  - Keep a ref to the node being dragged (set in an accepted `onDragStart`, cleared in `onDragEnd`); the stage's two-finger `onTouchStart` calls its `stopDrag()` so the normal `dragend` commits once.
  - Stage `onTouchMove` with one finger does not pan while `Konva.isDragging()`.
- [ ] **Step 4: Run** the e2e command, then `npm --prefix frontend test` and `npm --prefix frontend run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: select and move labels by touch (#57)`.

### Task 6: two-tap toggle, bigger targets, 16 px fields

**Files:**
- Modify: `frontend/src/editor/EditorCanvas.tsx` (the `hitCircles` memo, ~lines 547–577), `frontend/src/styles.css`
- Test: `frontend/e2e/touch.spec.ts`

**Interfaces:**
- Consumes: `useCompactEditor` (Task 2), `moved()`, store `hover` / `hoveredId`, `tryToggleWithPlacement`.
- Produces: nothing later tasks call.

- [ ] **Step 1: Add the failing tests**, a third `test('touch: two taps toggle an object; fields are finger-sized', …)` wrapped in `withAnnotationsRestored`:
  1. Pick a disabled object from `fetchObjects`/`fetchAnnotations` whose position is inside the canvas. First `tap` on it → `.editor-tooltip` is visible with its name, `labelCount` and the stored enabled count unchanged, `.save-status` reads `Saved`.
  2. Second `tap` on it → `labelCount` is one more and the stored label is enabled.
  3. Third `tap` → back to the starting count (the hover stayed on it).
  4. `tap` on empty canvas → `.editor-tooltip` is gone.
  5. A star whose marker radius on screen is under 8 px: `tap` 12 px from its centre → its tooltip shows (the 16 px floor).
  6. With a label selected and the side panel opened, every `input, select, textarea` in the document has `parseFloat(getComputedStyle(el).fontSize) >= 16`.
  7. Mouse after touch: `page.mouse.wheel` over the canvas changes the stage scale; a `page.mouse` drag on a label moves it by the dragged distance; then Undo once.
- [ ] **Step 2: Run** the e2e command. Expected: the new test FAILS at 1 (a tap does nothing; there is no `tap` handler).
- [ ] **Step 3: Implement**:
  - `hitCircles`: `onTap` → if `moved()` return; if `useEditor.getState().hoveredId !== id` call `hover(id)`, else `tryToggleWithPlacement(id, setToggleError)`. Radius floor `(compact ? 16 : 8) / view.scale`, with `compact` from `useCompactEditor()` added to the memo's dependencies.
  - `styles.css`, with a why-comment naming the iOS focus zoom:

```css
@media (pointer: coarse) {
  body:has(> #root > main.editor-main) :is(input, select, textarea) { font-size: max(16px, 1em); }
}
```

- [ ] **Step 4: Run** the e2e command for `touch.spec.ts`, then `npm --prefix frontend test` and `npm --prefix frontend run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: two-tap object toggle and finger-sized fields on touch (#57)`.

### Task 7: documents, full verification, hand-over

**Files:**
- Modify: `docs/SPEC.md` (§ 3 bullet at "Mobile-first editor"; new `### 6.5 Touch` after § 6.4; § 6.1 pointer; § 14 line), `CLAUDE.md` (only if the e2e description needs the touch spec named)

**Interfaces:** none.

- [ ] **Step 1: Update `docs/SPEC.md`**:
  - § 3: the editor is still not mobile-first, but it no longer assumes a mouse; point to § 6.5.
  - § 6.5 Touch: the gesture list exactly as built (two fingers zoom and pan; one finger pans; tap selects; only a selected label drags; two taps toggle an object; 10 px tap slack; a second finger ends a label drag; touching the photo commits an edit in progress), the page-zoom rule (`touch-action`, 16 px fields, editor route only), what is not there on touch (multi-select, double-tap rename, wheel-resize), and "the label toolbar is still the floating strip until the docked bar lands (#57)".
  - § 6.1: one sentence after the mouse list pointing to § 6.5.
  - § 14: replace the touch line with "Touch editor: not yet checked on a real iPhone (after the next release) or on a tablet (#57)."
- [ ] **Step 2: Full verification.** Run `make lint test`, then `make e2e`. Expected: all green, including every pre-existing spec unmodified (`git diff --stat main -- frontend/e2e` shows only `helpers.ts` and `touch.spec.ts`).
- [ ] **Step 3: Commit** `docs: SPEC § 6.5 touch gestures (#57)`.
- [ ] **Step 4: Review ritual (CLAUDE.md).** `/code-review high` on the branch diff, a silent-failure pass (pr-review-toolkit agent), then `/simplify`; fix what they find, re-run Step 2, commit.
- [ ] **Step 5: Hand to the owner for the smoke test, and wait.** Restart `astrocaption-dev`, then give them this list for `http://localhost:5173` in desktop devtools (device toolbar on, an iPhone preset, touch emulation):
  - Shift-drag pinches: the photo zooms, the page does not.
  - Drag on sky pans; drag on an unselected label pans; tap a label, then drag it: it moves, and Undo puts it back.
  - Tap a faint object once: its name shows; tap again: its label appears.
  - Type a size in the toolbar, tap the photo: the size sticks.
  - Device toolbar off: the mouse behaves exactly as before.
  - An image mid re-solve (if one is to hand): labels cannot be selected.
- [ ] **Step 6: After the owner's go**, push the branch and open the PR titled `feat: touch gestures in the editor (#57)` with `Part of #57` (not `Closes`), milestone "Later (post-v1)"; `gh pr checks --watch`; stop and ask before merging.
