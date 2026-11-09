# Docked label bar and sheet (#57, PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a compact editor a selected label gets a short bar docked under the photo (size, colour, Hide, More) and a sheet with the rest (Rename, Aliases, Leader, Pin, Reset position, Clear overrides), in place of the floating strip that is wider than a phone.

**Architecture:** The floating strip's logic moves out of `LabelToolbar.tsx` into a hook, `useLabelControls`, so the strip and the new `LabelDock` are two presentations of one model and every control keeps its one-undo-entry behaviour. `EditorCanvas` renders the strip inside the canvas when the editor is not compact and the dock after the canvas when it is. Two small pieces are shared instead of copied: the rename commit (`renameLabel`, also used by the double-click editor) and the "pressed somewhere else" rule (`usePressAway`, lifted out of `ColorField`).

**Tech Stack:** React 19, TypeScript strict, zustand, Konva (untouched here), vitest + Testing Library (jsdom), Playwright (Chromium, touch through CDP).

**Spec:** `docs/superpowers/specs/2026-11-09-editor-touch-design.md`, section "The docked bar and the sheet (PR 2)", with "Tests" items 3–5 and the layout assertion. SPEC.md § 6.5 is what PR 1 (#260) and the compact top bar (#264) left; this plan extends it.

## Global Constraints

- No new dependencies. Nothing drawn changes; `parity.spec.ts` passes unmodified.
- The floating strip on a non-compact editor is unchanged: every test in `LabelToolbar.test.tsx` passes **unmodified**.
- Compact is `useCompactEditor()` (`(pointer: coarse), (max-width: 640px)`); jsdom has no `matchMedia`, so component tests see the strip unless they render `LabelDock` directly.
- Bar: left to right `−`, size field, `+`, colour swatch (chip only, no hex text), spacer, `Hide`, `More`. Controls 44 px tall, text 16 px. `role="toolbar"`, `aria-label="Selected labels"`. It must fit a 343 px pane (a 375 px phone) without wrapping.
- Sheet rows at least 48 px tall, in this order: Rename, Aliases, Leader, Pin in place, Reset position, Clear overrides. Rename only when exactly one label is selected.
- The sheet closes on: a press on the photo or anywhere else outside the dock, `More` again, Escape, the selection becoming empty. Reset position and Clear overrides act and close it. It does not drag and has no swipe-to-dismiss.
- Hide is `disableAll([...selectedIds])`: one undo entry, the same as the Delete key.
- Every control applies to every selected label and is one undo entry, exactly as on the strip.
- Stage by path, conventional commits, branch `feat/editor-touch-dock-57` (created; this plan is on it). Never push to `main`; no merge without the owner's go.
- Two departures from the spec, decided here:
  1. **Where the sheet lives.** The spec anchors it "to the bottom of `.editor-canvas`". It is instead a child of the dock, positioned above it (`bottom: 100%`), so it overlays the bottom of the photo in the same place without being inside the canvas element, whose touches are all cancelled. Same look; no special-casing of touches on the sheet.
  2. **No sideways scroll yet.** The spec lets the bar scroll in a pane narrower than 343 px. A scrolling bar would clip the colour popover that opens from its swatch, so the bar does not scroll in this PR; PR 3 replaces the popover with a sheet and can add the scroll then. Phones narrower than 375 px may clip the bar's right edge until PR 3.

## Review Focus

1. The selection moves on while the sheet is open with a name half typed (a tap on another label): the name is committed to the label it was typed for, never to the new one (Task 5).
2. Undo, or a re-solve starting, takes the selected label away while the sheet is open: the dock disappears without an error and without committing anything (Task 5).
3. Several labels selected (possible with a keyboard attached): no Rename row, "mixed" where values differ, Hide hides them all as one entry (Task 5).
4. The selected label sits low in the photo when the sheet opens: the view pans up just enough to show it, and not at all when it is already clear (Tasks 1 and 5).
5. A long name in the Rename field, the sheet open, on a 375 px phone: no horizontal overflow (Task 6).

---

### Task 1: `revealAbove` in `view.ts`

**Files:** Modify `frontend/src/editor/view.ts`; test `frontend/src/editor/view.test.ts`.

**Interfaces:**
- Produces: `export function revealAbove(view: View, worldBottom: number, visibleBottom: number, margin: number): View`. `worldBottom` is a y in original image pixels (the selection box's bottom); `visibleBottom` is a y in stage-container pixels (the top edge of whatever covers the bottom of the canvas). Returns the view panned up by the least amount that puts `worldBottom` at least `margin` screen px above `visibleBottom`; returns the same object when it already is.

- [ ] **Step 1: Failing tests** (`describe('revealAbove')`), with `v = { scale: 0.5, x: 10, y: 100 }`:
  - `revealAbove(v, 400, 400, 8)` (box bottom at screen 300, cover at 400) → `toBe(v)`.
  - `revealAbove(v, 800, 400, 8)` (box bottom at screen 500) → `{ scale: 0.5, x: 10, y: -8 }`, and `toScreen(result, 0, 800).y` is `392`.
  - exactly at the limit, `revealAbove(v, 584, 400, 8)` (screen 392) → `toBe(v)`.
  - scale and x never change.
- [ ] **Step 2: Run** `npm --prefix frontend test -- view.test.ts`. Expected: FAIL, `revealAbove` is not exported.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pan the view up to keep a point above a cover (#57)`.

### Task 2: one rename rule, `renameLabel`

**Files:** Modify `frontend/src/editor/editing.ts`, `frontend/src/editor/LabelTextEditor.tsx`; test `frontend/src/editor/editing.test.ts`.

**Interfaces:**
- Produces: `export function renameLabel(id: number, text: string, initial: string): 'unchanged' | 'refused' | 'renamed'`. Trims `text`; equal to `initial.trim()` → `'unchanged'`, no store write; document not editable → `'refused'`, no store write; otherwise `updateLabels([id], { text_override: trimmed === '' ? null : trimmed })` → `'renamed'`.
- `LabelTextEditor`'s `finish` calls it and keeps its own behaviour: `'refused'` shows the existing refusal line and keeps the field open; the other two close.

- [ ] **Step 1: Failing tests** in `editing.test.ts`, `describe('renameLabel')`: sets `text_override` to the trimmed text and returns `'renamed'` (one undo entry); a blank clears the override to `null`; text equal to `initial` after trimming returns `'unchanged'` and adds no undo entry; while the image is being solved returns `'refused'` and changes nothing.
- [ ] **Step 2: Run** `npm --prefix frontend test -- editing.test.ts`. Expected: FAIL, not exported.
- [ ] **Step 3: Implement `renameLabel`; switch `LabelTextEditor.finish` to it.**
- [ ] **Step 4: Run** `npm --prefix frontend test -- editing.test.ts LabelTextEditor.test.tsx`. Expected: PASS, the editor's existing tests unmodified.
- [ ] **Step 5: Commit** `refactor: one rename rule for the label text editor (#57)`.

### Task 3: `usePressAway`, lifted out of `ColorField`

**Files:** Create `frontend/src/style/pressAway.ts`, `frontend/src/style/pressAway.test.tsx`; modify `frontend/src/style/ColorField.tsx`.

**Interfaces:**
- Produces: `export function usePressAway(ref: RefObject<HTMLElement | null>, active: boolean, onAway: () => void): void`. While `active`: a document `mousedown` whose target is outside `ref`, or a document `touchstart` that is `defaultPrevented` and outside `ref` (the editor canvas cancels its touches, so no mousedown follows them), calls the latest `onAway`. The touch listener is passive. Listeners exist only while `active`.
- `ColorField` uses it for its click-away; its Escape handling and `closePicker` guard stay where they are.

- [ ] **Step 1: Failing tests** in `pressAway.test.tsx` (a tiny host component with a ref'd box and an outside element): mousedown outside calls `onAway`, inside does not; a cancelled touchstart outside calls it; an uncancelled touchstart outside does not; nothing is called while `active` is false; the callback used is the one from the latest render.
- [ ] **Step 2: Run** `npm --prefix frontend test -- pressAway.test.tsx`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** (`useEffectEvent` for the callback, as `ColorField` does today) and replace `ColorField`'s `away` / `cancelledTouch` listeners with one `usePressAway(wrap, open, () => closePicker(false))`.
- [ ] **Step 4: Run** `npm --prefix frontend test -- pressAway.test.tsx ColorField.test.tsx`. Expected: PASS, every existing `ColorField` test unmodified.
- [ ] **Step 5: Commit** `refactor: the press-away rule as a hook (#57)`.

### Task 4: `useLabelControls`, the strip's logic without its layout

A refactor under green: no behaviour changes, so there is no new test; the 30 existing tests in `LabelToolbar.test.tsx` are the gate and must pass unmodified.

**Files:** Create `frontend/src/editor/labelControls.tsx`; modify `frontend/src/editor/LabelToolbar.tsx`.

**Interfaces:**
- Produces, in `labelControls.tsx`:

```ts
export const MIXED = 'mixed'
export function MixedSelect(props: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }): JSX.Element   // moved as is
export const ALIAS_OPTIONS: { value: string; label: string }[]     // moved as is
export const LEADER_OPTIONS: { value: string; label: string }[]    // moved as is

export interface LabelControls {
  ids: number[]
  /** Spread onto the size `<input type="number">`: value, placeholder, min, max, aria-label "Font size" and every handler it has today (change, blur, keydown incl. undo/redo and arrows, keyup). */
  sizeField: React.InputHTMLAttributes<HTMLInputElement>
  step(delta: number): void
  /** Spread onto `<ColorField label="Text colour" … />`. */
  color: { value: string; fallback: string; mixed: boolean; onChange(hex: string): void; onCommit(hex?: string): void; onClear(): void }
  aliases: { value: string; onChange(value: string): void }
  leader: { value: string; onChange(value: string): void }
  pin: { label: string; pressed: boolean; toggle(): void }
  /** Runs the placer; on a throw reports through `onError` and changes nothing. */
  resetPosition(): void
  clearOverrides(): void
  /** What decides the strip's width, for its re-measure: unchanged from today's `contentKey`. */
  contentKey: string
}
/** null when there is nothing to show: no style yet, a read-only document, or no enabled label selected. */
export function useLabelControls(onError?: (message: string) => void): LabelControls | null
```

- `LabelToolbar.tsx` keeps only the floating presentation: its measuring, its placement above or below the selection box, and the same JSX built from `useLabelControls`.

- [ ] **Step 1: Run** `npm --prefix frontend test -- LabelToolbar.test.tsx` on the untouched code. Expected: PASS (the baseline).
- [ ] **Step 2: Move the logic** into `useLabelControls` and rebuild the strip's JSX from it. Comments move with the code they explain.
- [ ] **Step 3: Run** the same command, then `npm --prefix frontend run lint`. Expected: PASS, with `git diff --stat main -- frontend/src/editor/LabelToolbar.test.tsx` empty.
- [ ] **Step 4: Commit** `refactor: the label toolbar's logic as a hook (#57)`.

### Task 5: `LabelDock`, the bar and its sheet

**Files:** Create `frontend/src/editor/LabelDock.tsx`, `frontend/src/editor/LabelDock.test.tsx`; modify `frontend/src/styles.css`.

**Interfaces:**
- Consumes: `useLabelControls`, `MixedSelect`, `ALIAS_OPTIONS`, `LEADER_OPTIONS` (Task 4); `usePressAway` (Task 3); `renameLabel` (Task 2); `revealAbove` (Task 1); `disableAll`; `useTaggedDraft`; `ColorField` (its popover, until PR 3).
- Produces: `export default function LabelDock(props: { box: Box; onError?: (message: string) => void }): JSX.Element | null`. `box` is the selection's union box in original pixels (what the strip already receives). Root element: `<div class="label-dock" role="toolbar" aria-label="Selected labels">`, containing the sheet (`<div class="label-sheet" role="group" aria-label="More label options">`, only while open) and the bar row. Renders nothing when `useLabelControls` returns null.
- CSS classes `label-dock`, `label-dock-bar`, `label-sheet`, `label-sheet-row`. The dock is `position: relative`; the sheet is `position: absolute; left: 0; right: 0; bottom: 100%`.

- [ ] **Step 1: Failing tests** in `LabelDock.test.tsx` (store set up as `LabelToolbar.test.tsx` does: `makeDoc`, viewport 1000 × 800, label 1 selected, object 2 enabled):
  - the bar has, in order, buttons "Smaller", the "Font size" field, "Larger", the "Text colour" swatch, "Hide", "More"; no sheet;
  - "Larger" steps the size as one undo entry (the model is the strip's; one control is enough to prove the wiring);
  - "Hide" disables the selection as one undo entry and the dock renders nothing afterwards;
  - "More" opens the sheet (`aria-pressed="true"` on the button, rows "Rename", "Aliases", "Leader", "Pin in place", "Reset position", "Clear overrides" in that order); "More" again closes it; Escape closes it; a `mousedown` on `document.body` closes it;
  - Rename: the field shows the label's current name; typing and Enter sets `text_override` (one entry) and leaves the sheet open; a blank resets it to `null`; Escape restores the field and adds no entry;
  - Review Focus 1: type a name, then `select(2)` after a blur → label 1 has the name, label 2 has no override;
  - Review Focus 3: with labels 1 and 2 selected there is no Rename row, the Aliases select reads "mixed" when they differ, and Hide disables both as one entry;
  - "Pin in place" toggles `pinned` on the selection (one entry) and stays open; "Reset position" and "Clear overrides" each act and close the sheet; a Reset that throws (the `./editing` mock from `LabelToolbar.test.tsx`) calls `onError` and changes nothing;
  - Review Focus 2: with the sheet open, `disableAll([1])` → nothing is rendered and nothing throws; with the sheet open, a solve starting (`solve_status: 'solving'` in the store) → nothing is rendered, no undo entry added;
  - Review Focus 4: with `getBoundingClientRect` mocked so the sheet is 300 px tall and the viewport 800 px, a box whose bottom is at screen y 700 → opening the sheet moves `view.y` by `-(700 + 8 - 500)`; a box at screen y 200 → `view` is the same object.
- [ ] **Step 2: Run** `npm --prefix frontend test -- LabelDock.test.tsx`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `LabelDock`.**
  - Sheet state is local (`useState`), so it is gone when the dock unmounts. `usePressAway(dockRef, open, close)`; Escape handled on the dock's `onKeyDown` (stop it there, so the canvas's Escape does not also clear the selection on the same keystroke, the rule `ColorField` follows).
  - Rename draft through `useTaggedDraft<string>([currentName, selectedIds])`; commit on Enter and on blur through `renameLabel`; `'refused'` leaves the draft in the field.
  - Opening the sheet: in a layout effect, measure the sheet's height and `setView(revealAbove(view, box.bottom, viewport.h - sheetHeight, 8))`. Not on close.
  - Buttons keep the focus off themselves on `mousedown` the way the strip's do, so the canvas shortcuts stay live.
- [ ] **Step 4: Add the CSS** next to the `.label-toolbar` rules, with a short why-comment: the bar is a flex row with a 0.5 rem gap and padding, a top border and the panel background; controls `min-height: 44px; font-size: 1rem`; the stepper's three parts joined (the mockup's look); the size field narrow enough that the row fits 343 px (`width: 3.25rem`), its spinner hidden like the strip's; the swatch shows its chip only (`.swatch-hex` hidden); sheet rows `min-height: 48px` with a hairline between them, the sheet with rounded top corners, a shadow, `z-index` above the canvas.
- [ ] **Step 5: Run** `npm --prefix frontend test` and `npm --prefix frontend run lint`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: a docked label bar and its sheet (#57)`.

### Task 6: wire it in, and the browser tests

**Files:** Modify `frontend/src/editor/EditorCanvas.tsx` (the toolbar line near the end of the render), `frontend/src/editor/canvasGestures.ts` (the three `.label-toolbar` look-ups in the key handler), `frontend/e2e/touch.spec.ts`, `frontend/e2e/layout.spec.ts`.

**Interfaces:**
- Consumes: `LabelDock` (Task 5), `useCompactEditor` (already used in `EditorCanvas`).
- Produces: in `canvasGestures.ts`, `const LABEL_CONTROLS = '.label-toolbar, .label-dock'`, used wherever the key handler asks whether the focus is in the label controls, so Delete, Backspace and Escape typed in the dock edit the field and do not act on the selection.

- [ ] **Step 1: Failing browser tests.**
  - `touch.spec.ts`, in "a label moves only once it is selected": after the tap that selects, the toolbar is the dock (`.label-dock` visible, `.label-toolbar` absent) and the canvas is shorter by the bar's height. Every later "tap the photo" in this file must aim at a point inside the canvas as it is *then*: re-read the canvas box after a selection, and replace the `box.y + box.height - 20` taps (they would now land on the bar).
  - New steps in that test, before the size-field step: **Hide** → the label is gone from `labelPositions()`, the dock is gone, Undo is enabled; Undo → the label is back. **More → Rename**: tap More, type a new name in "Rename", Enter → the stored `text_override` is that name and the sheet is still open; **Clear overrides** → the stored `text_override` is `null` and the sheet is closed. **A tap on the photo closes the sheet**: open More, tap the photo → the sheet is hidden.
  - `layout.spec.ts`, phone block: select a label (expand the panel is not needed: tap the photo where a label is, or use the test hook's positions as `touch.spec` does), then: no horizontal overflow; the bar's last control ("More") is fully in the viewport; open More, type a 60-character name into Rename → still no horizontal overflow (Review Focus 5). Repeat the bar check after `page.setViewportSize({ width: 375, height: 812 })`.
- [ ] **Step 2: Run** `npm --prefix frontend run build && cd frontend && E2E_START_APP=1 npx playwright test touch.spec.ts layout.spec.ts`. Expected: FAIL (`.label-dock` not found).
- [ ] **Step 3: Wire.** In `EditorCanvas.tsx`: inside the canvas `div`, the strip only when not compact; after the canvas `div` (still inside the fragment, so it is a flex child of `.editor-pane` under the canvas), `compact && selectionBox && editing === null && <LabelDock box={selectionBox} onError={setToolbarError} />`. In `canvasGestures.ts`, the `LABEL_CONTROLS` selector.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS. Then `npm --prefix frontend test` and lint.
- [ ] **Step 5: Commit** `feat: the compact editor docks the label controls under the photo (#57)`.

### Task 7: documents, full verification, hand-over

- [ ] **Step 1: `docs/SPEC.md`.** § 6.5: replace the sentence that says the strip is still used in a compact editor with the docked bar and sheet as built (controls, order, what closes the sheet, Hide, Rename, the view panning up, the two departures from the design above); § 6.2: one sentence where the floating toolbar is introduced, pointing to § 6.5 for a compact editor.
- [ ] **Step 2: Full verification.** `make lint test`, then `make e2e`. Expected: all green; `git diff --stat main -- frontend/src/editor/LabelToolbar.test.tsx frontend/src/style/ColorField.test.tsx` empty.
- [ ] **Step 3: Commit** `docs: SPEC § 6.5, the docked label bar (#57)`.
- [ ] **Step 4: Review ritual (CLAUDE.md):** `/code-review high`, the silent-failure pass, `/simplify`; fix what is real (test first), re-run Step 2, commit.
- [ ] **Step 5: Hand to the owner for the smoke test, and wait.** Restart `astrocaption-dev`; list for `http://localhost:5173` in desktop devtools at iPhone size (one finger only; devtools cannot pinch): tap a label and the bar appears under the photo; − and + resize it; the swatch opens the colour picker; Hide removes it and the undo arrow brings it back; More opens the sheet; Rename changes the name; Pin, Reset position and Clear overrides work; a tap on the photo closes the sheet; a label low in the photo is still visible with the sheet open. Device toolbar off: the floating strip is exactly as before.
- [ ] **Step 6: After the owner's go**, push, open the PR `feat: docked label bar and sheet on touch screens (#57)` with `Part of #57`, milestone "Later (post-v1)", watch CI, and ask before merging.
