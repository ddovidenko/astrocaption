# Editor Touch, PR 3: the Colour Sheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the compact editor the docked bar's colour swatch opens a full-width bottom sheet instead of a popover, the bar scrolls sideways on phones narrower than 375 px, and the README says the editor works by touch. Closes #57.

**Architecture:** `ColorField` gains a `presentation: 'sheet'` mode that renders its picker body as a `.color-sheet` panel (no placement measurement; the dock positions it by CSS against itself) and tells its owner when it opens and closes. `LabelDock` widens its sheet state from "More open or not" to "which sheet is open" (`'more' | 'color' | null`): opening one closes the other, the one `reveal` effect keeps the selection visible above whichever sheet just opened, and a CSS variable on the dock caps both sheets at the canvas height. The commit rules of the picker do not change: `ColorField` still fires exactly one terminal callback per close.

**Tech Stack:** React 19, react-colorful (already installed), vitest + Testing Library (jsdom), Playwright with CDP touch events (`frontend/e2e/helpers.ts`).

**Spec:** `docs/superpowers/specs/2026-11-09-editor-touch-design.md`, section "The colour sheet (PR 3)", plus the bar's "in a narrower pane it scrolls sideways" (Docked bar) and "One sentence in the README's feature list" (Documents). SPEC § 6.5 is the product spec the design amends.

## Global Constraints

- No new dependencies ("Konva 10 and react-colorful already do everything needed").
- Touch is decided per event, never per device; "compact" (`useCompactEditor`) affects layout and sizes only.
- Every other user of `ColorField` (Style tab, config page, the floating `LabelToolbar`) keeps the popover, unchanged; `ColorField.test.tsx`'s and `LabelToolbar.test.tsx`'s existing tests run unmodified.
- `ColorField` keeps its contract: exactly one terminal callback leaves it per interaction (`onCommit` for every close and for a typed hex, `onClear` for "Use default", never both).
- What previews: a drag in the picker moves a local draft shown by the swatch chip and the hex field; the label on the photo changes when the sheet closes, as one undo entry. No live preview on the photo.
- Only one sheet is open at a time; opening one closes the other (with that one's commit).
- Controls in the bar and sheets: 44 px tall, 16 px text (`(pointer: coarse)` fields never under 16 px).
- Component tests: `*.test.tsx` beside the component, `// @vitest-environment jsdom` on line 1, assert on the store or the DOM.
- TDD: every test is run and seen failing before the code that makes it pass; a rule never seen failing gets a mutation check.
- Branch `feat/editor-touch-colour-sheet-57`; conventional commits ending in `(#57)`; stage by path; never push to `main`; the PR says `Closes #57`.

## Review Focus

Behaviours the design implies that no task's tests exercise directly; each gets a test in the task that owns the code:

1. **"Use default" in the sheet** must clear the override and close the sheet with no trailing commit putting the draft back (Task 1: `sheet: Use default clears and closes silently`).
2. **A press on the photo while the colour sheet is open** must commit the pick and close it, through the same cancelled-touch path the popover uses (Task 2: `a press on the photo closes the colour sheet, committing the pick` and e2e step 1).
3. **Escape with the colour sheet open** must close it, keep the pick, and not clear the selection (Task 2: `Escape closes the colour sheet and keeps the selection`).
4. **The colour sheet on a short screen** must scroll inside the canvas height rather than grow past the top of the screen (Task 2: `the colour sheet is capped at the canvas height too`).
5. **A bar narrower than its controls** must scroll rather than hide More, with no page overflow (Task 3, e2e at 320 px).

---

### Task 1: `ColorField` as a sheet

**Files:**
- Modify: `frontend/src/style/ColorField.tsx`
- Modify: `frontend/src/styles.css` (the `.popover` block around line 111; a new `.color-sheet` block right after it)
- Test: `frontend/src/style/ColorField.test.tsx` (new `describe('ColorField as a sheet')`; existing tests unmodified)

**Interfaces:**
- Produces: three optional props on `ColorField`:
  - `presentation?: 'popover' | 'sheet'` (default `'popover'`). In `'sheet'` the open panel is `<div className="color-sheet" role="dialog" aria-label={`${label} picker`}>` with the same children as the popover (`HexColorPicker`, then a `.popover-row` with `HexColorInput` and, with `allowDefault`, "Use default"); the placement layout effect does not run and no `popover-right`/`popover-up` class is ever set.
  - `onOpen?: () => void`: called from `openPicker` after `setOpen(true)`.
  - `onClose?: () => void`: called from `closePicker` after `setOpen(false)` on every close, silent ones included, exactly once per close (it sits behind the same `openRef` guard as `onCommit`).
- The swatch keeps `aria-haspopup="dialog"` and `aria-expanded`.

- [ ] **Step 1: Write the failing tests**

Add to `ColorField.test.tsx`, using the existing `mount` and `canvas` helpers:

```tsx
describe('ColorField as a sheet', () => {
  it('opens a full-width sheet, not a placed popover', () => {
    mockRects({ left: 10, bottom: 100 }, { right: 300, bottom: 120 }) // would push a popover up and right
    const f = mount({ presentation: 'sheet' })
    f.open()
    const dialog = f.dialog()!
    expect(dialog.className).toBe('color-sheet')
    expect(dialog.querySelector('.react-colorful')).not.toBeNull()
    expect(dialog.querySelector('input')).not.toBeNull()
    expect(f.swatch.getAttribute('aria-expanded')).toBe('true')
  })

  it('tells its owner when it opens and when it closes, once each', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const f = mount({ presentation: 'sheet', onOpen, onClose })
    f.open()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      fireEvent.touchStart(canvas())
      fireEvent.mouseDown(canvas())
    })
    expect(f.dialog()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })

  it('sheet: Use default clears and closes silently', () => {
    const onClose = vi.fn()
    const f = mount({ presentation: 'sheet', allowDefault: true, value: '#123456', onClose })
    f.open()
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(f.dialog()).toBeNull()
    expect(f.onChange).toHaveBeenLastCalledWith('')
    expect(f.onClear).toHaveBeenCalledTimes(1)
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the popover presentation is the default and reports open and close too', () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const f = mount({ onOpen, onClose })
    f.open()
    expect(f.dialog()!.className).toMatch(/^popover/)
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

`canvas()` is the test file's existing helper (line 77) that renders an element with class `editor-canvas`; it is scoped inside the first `describe`, so lift it to module level.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/style/ColorField.test.tsx`
Expected: the four new tests FAIL (`className` is `popover`, `onOpen`/`onClose` never called); the 20 existing tests pass.

- [ ] **Step 3: Implement the props in `ColorField.tsx`**

Add `presentation = 'popover'`, `onOpen`, `onClose` to the props with one-line doc comments each. `openPicker` calls `onOpen?.()` after `setOpen(true)`; `closePicker` calls `onClose?.()` after `setOpen(false)` (before the `onCommit`/refocus logic is fine; what matters is once per close behind `openRef`). Guard the placement effect with `if (presentation !== 'popover' || !open || …) return`. Render the panel's `className` as `'color-sheet'` for the sheet, the existing string otherwise; everything inside the panel is unchanged.

- [ ] **Step 4: Style `.color-sheet`**

In `styles.css`, after the `.popover` rules:

```css
/* The picker as a bottom sheet (SPEC § 6.5): the docked label bar positions it against itself. */
.color-sheet { position: absolute; z-index: 10; left: 0; right: 0; bottom: 100%; max-height: var(--sheet-max, none); overflow-y: auto; display: grid; gap: 0.75rem; padding: 0.9rem; background: var(--panel); border-top: 1px solid var(--border); border-radius: 14px 14px 0 0; box-shadow: 0 -12px 28px rgba(0, 0, 0, 0.55); }
.color-sheet .react-colorful { width: 100%; height: 180px; }
.color-sheet .popover-row { justify-content: space-between; }
.color-sheet .popover-row input, .color-sheet .popover-row button { min-height: 44px; font-size: 1rem; }
.color-sheet .popover-row input { width: 7.5rem; }
```

- [ ] **Step 5: Run the file and the lint**

Run: `cd frontend && npx vitest run src/style/ColorField.test.tsx && npx eslint src/style/ColorField.tsx && npx tsc --noEmit`
Expected: 24 tests pass; no lint or type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/style/ColorField.tsx frontend/src/style/ColorField.test.tsx frontend/src/styles.css
git commit -m "feat: ColorField as a bottom sheet (#57)"
```

---

### Task 2: the dock's colour sheet

**Files:**
- Modify: `frontend/src/editor/LabelDock.tsx`
- Modify: `frontend/src/styles.css` (the `.label-dock` block around lines 331–360: drop the `.label-dock .popover` override, move the sheet cap to a variable)
- Test: `frontend/src/editor/LabelDock.test.tsx` (new `describe('LabelDock colour sheet')`; one existing assertion changes, named below)

**Interfaces:**
- Consumes: `ColorField`'s `presentation`, `onOpen`, `onClose` (Task 1); `useLabelControls().color` (`{ value, fallback, mixed, onChange, onCommit, onClear }`); `revealAbove`; `useTaggedDraft`.
- Produces: inside `LabelDock`, `const [sheet, setSheet, dropSheet] = useTaggedDraft<'more' | 'color'>([selectedIds])` replaces `opened`/`setOpened`/`dropOpened`. The dock root carries `style={{ '--sheet-max': `${Math.max(0, canvasHeight - MARGIN)}px` }}`; the More sheet's inline `maxHeight` goes, and `.label-sheet` reads `max-height: var(--sheet-max, none)`. The one `reveal` effect runs on `[sheet]` and measures `dockRef.current?.querySelector<HTMLElement>('.label-sheet, .color-sheet') ?? null` (no more `sheetRef`).

Behaviour to implement:
- `<ColorField label="Text colour" presentation="sheet" {...controls.color} onOpen={() => { commitName(); setSheet('color') }} onClose={() => { if (sheet === 'color') dropSheet() }} />`. The `onClose` reads this render's `sheet`; it is only ever `'color'` or already `null` there.
- More: `onClick={() => (sheet === 'more' ? close() : setSheet('more'))}`. A press on More while the colour sheet is open is a press outside `ColorField`'s wrap, so `usePressAway` in `ColorField` has already closed it (committing) by the time the click runs.
- `usePressAway(dockRef, sheet === 'more', () => close())` and `useEscapeKey(sheet === 'more', () => close(false))`: the colour sheet has its own press-away and Escape inside `ColorField`. (Escape on the colour sheet must not reach the canvas: `ColorField`'s `useEscapeKey` already stops it.)
- `aria-pressed` on More is `sheet === 'more'`.

- [ ] **Step 1: Write the failing tests**

Add to `LabelDock.test.tsx`:

```tsx
describe('LabelDock colour sheet', () => {
  const swatch = () => screen.getByRole('button', { name: /Text colour/ })
  const colourSheet = () => screen.queryByRole('dialog', { name: 'Text colour picker' })

  it('the swatch opens a sheet, not a popover', () => {
    render(<LabelDock box={box} />)
    fireEvent.click(swatch())
    expect(colourSheet()!.className).toBe('color-sheet')
    expect(sheet()).toBeNull()
  })

  it('only one sheet at a time: the swatch closes More, More closes the colour sheet', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.click(swatch())
    expect(sheet()).toBeNull()
    expect(colourSheet()).not.toBeNull()
    expect(more().getAttribute('aria-pressed')).toBe('false')
    fireEvent.mouseDown(more()) // the press that closes the picker
    fireEvent.click(more())
    expect(colourSheet()).toBeNull()
    expect(sheet()).not.toBeNull()
  })

  it('opening the colour sheet stores a name that was being typed', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Typed' } })
    fireEvent.click(swatch())
    expect(label(1).text_override).toBe('Typed')
  })

  it('a press on the photo closes the colour sheet, committing the pick as one change', () => {
    render(<LabelDock box={box} />)
    const before = state().undo.length
    fireEvent.click(swatch())
    const hex = colourSheet()!.querySelector('input')!
    fireEvent.change(hex, { target: { value: '#ff8800' } }) // a typed hex commits at once
    const canvas = document.createElement('div')
    canvas.className = 'editor-canvas'
    document.body.append(canvas)
    canvas.addEventListener('touchstart', (e) => e.preventDefault())
    act(() => {
      fireEvent.touchStart(canvas)
    })
    expect(colourSheet()).toBeNull()
    expect(label(1).color).toBe('#ff8800')
    expect(state().undo).toHaveLength(before + 1)
    canvas.remove()
  })

  it('Escape closes the colour sheet and keeps the selection', () => {
    render(<LabelDock box={box} />)
    fireEvent.click(swatch())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(colourSheet()).toBeNull()
    expect(state().selectedIds).toEqual([1])
    expect(dock()).not.toBeNull()
  })

  it('the colour sheet is capped at the canvas height too', () => {
    render(<LabelDock box={box} />)
    expect((dock() as HTMLElement).style.getPropertyValue('--sheet-max')).toBe('792px')
  })
})
```

If `fireEvent.change` on react-colorful's hex input does not reach `onChange` in jsdom, drive it the way `ColorField.test.tsx`'s "typed hex" test does.

Also change, in `describe('LabelDock keeps the selection in view')`:
- `'a sheet taller than the canvas scrolls inside it and moves nothing'`: replace `expect((sheet() as HTMLElement).style.maxHeight).toBe('792px')` with `expect((dock() as HTMLElement).style.getPropertyValue('--sheet-max')).toBe('792px')`.
- Add:

```tsx
  it('pans the photo up when the colour sheet would cover the selection', () => {
    sheetHeight(300) // sheetHeight measures `.label-sheet`; extend it to `.color-sheet` as well
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    render(<LabelDock box={{ ...box, bottom: 1400 }} />)
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    expect(state().view).toEqual({ scale: 0.5, x: 0, y: -208 })
  })
```

and extend `sheetHeight` so `classList.contains('label-sheet') || classList.contains('color-sheet')` gets `height`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/editor/LabelDock.test.tsx`
Expected: the 7 new tests FAIL (popover class, no `--sheet-max`, view unchanged on swatch click); the changed `maxHeight` assertion FAILS; the other 26 pass.

- [ ] **Step 3: Implement in `LabelDock.tsx` and `styles.css`**

Per the Interfaces block. In `styles.css`: delete `.label-dock .popover { … }`; `.label-sheet` gets `max-height: var(--sheet-max, none)`; keep `.label-dock .color-field { display: flex; position: static }` (the sheets position against `.label-dock`). Update the component's doc comment: the swatch opens the colour sheet; one sheet at a time.

- [ ] **Step 4: Run the file, then the editor tests**

Run: `cd frontend && npx vitest run src/editor/LabelDock.test.tsx src/editor/LabelToolbar.test.tsx src/style && npx eslint src/editor/LabelDock.tsx && npx tsc --noEmit`
Expected: all pass (LabelDock 34, LabelToolbar 29 unmodified, ColorField 24, pressAway 5); no lint or type errors.

- [ ] **Step 5: Mutation check**

Temporarily remove `commitName()` from `onOpen`; `opening the colour sheet stores a name that was being typed` must FAIL. Temporarily make the reveal effect ignore `.color-sheet`; `pans the photo up when the colour sheet would cover the selection` must FAIL. Restore both.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/editor/LabelDock.tsx frontend/src/editor/LabelDock.test.tsx frontend/src/styles.css
git commit -m "feat: the docked bar's colour picker is a sheet (#57)"
```

---

### Task 3: the bar scrolls sideways on a narrow phone

**Files:**
- Modify: `frontend/src/styles.css` (`.label-dock-bar`)
- Test: `frontend/e2e/touch.spec.ts` (step 4 of `'touch: the docked bar and its sheet do what the floating strip does'`, the `for (const width of [375, 390])` loop)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing e2e assertions**

After the `[375, 390]` loop, before the viewport is left at 390:

```ts
      // Narrower than 375 px the bar does not fit on one row; it scrolls sideways within its
      // pane (the sheets, children of the dock and not of the bar, are not clipped by this).
      {
        await page.setViewportSize({ width: 320, height: 568 })
        const bar = page.locator('.label-dock-bar')
        await expect.poll(async () => bar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
        await expectNoHorizontalOverflow(page, 'editor with the docked bar at 320 px')
        await expect(toolbar.getByRole('button', { name: 'More' })).not.toBeInViewport({ ratio: 1 })
        await bar.evaluate((el) => el.scrollTo({ left: el.scrollWidth }))
        await expect(toolbar.getByRole('button', { name: 'More' })).toBeInViewport({ ratio: 1 })
        expect((await bar.boundingBox())!.height, 'a scrollbar must not make the bar taller').toBeLessThanOrEqual(64)
        await bar.evaluate((el) => el.scrollTo({ left: 0 }))
        await page.setViewportSize({ width: 390, height: 844 })
        await expect.poll(selected).toEqual([id])
      }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx playwright test e2e/touch.spec.ts -g "docked bar"` (with the e2e app up as `make e2e` starts it; if `make e2e` is the only way to run the project here, use `make e2e` and read the touch spec's result)
Expected: FAIL at `scrollWidth > clientWidth` (the bar overflows its pane without scrolling today) or at `expectNoHorizontalOverflow`.

- [ ] **Step 3: Implement**

`.label-dock-bar { display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem; overflow-x: auto; scrollbar-width: thin; }`. If the scrollbar pushes the bar past 64 px on Chromium, add `.label-dock-bar::-webkit-scrollbar { height: 4px; }`.

- [ ] **Step 4: Run to verify it passes**

Run: the same command as Step 2.
Expected: PASS. Also run `make e2e` in full if Step 2 did not: 20 passed, 1 skipped.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles.css frontend/e2e/touch.spec.ts
git commit -m "feat: the docked bar scrolls sideways on phones under 375 px (#57)"
```

---

### Task 4: end to end, documents, and the PR

**Files:**
- Modify: `frontend/e2e/touch.spec.ts` (step 1 of the docked-bar test, "The toolbar's colour picker is drawn over the canvas")
- Modify: `docs/SPEC.md` § 6.5 ("The docked label bar") and § 14
- Modify: `README.md` ("What it does")

**Interfaces:** consumes the dock's `.color-sheet` dialog (`role="dialog"`, name `Text colour picker`).

- [ ] **Step 1: Rewrite e2e step 1 as design item 6**

Replace the block's body with:

```ts
    // 1. The swatch opens the colour picker as a sheet over the bottom of the photo. A pick shows
    //    on the swatch chip and nowhere else until the sheet closes; a tap on the photo closes it,
    //    changes the label and adds one undo entry. More and the colour sheet take turns.
    {
      await expect.poll(selected).toEqual([id])
      const storedColor = async () => (await fetchAnnotations(page, imageId)).labels.find((x) => x.object_id === id)!.color
      const chip = toolbar.locator('.swatch-chip')
      const chipColor = () => chip.evaluate((el) => getComputedStyle(el).backgroundColor)
      const before = await chipColor()
      await toolbar.getByRole('button', { name: /Text colour/ }).tap()
      const picker = page.getByRole('dialog', { name: 'Text colour picker' })
      await expect(picker).toBeVisible()
      await expect(picker).toBeInViewport({ ratio: 1 })
      const dockBox = (await page.locator('.label-dock').boundingBox())!
      const pickerBox = (await picker.boundingBox())!
      expect(Math.abs(pickerBox.width - dockBox.width), 'a sheet is as wide as the dock').toBeLessThanOrEqual(1)
      expect(pickerBox.y + pickerBox.height, 'the sheet sits on the bar').toBeLessThanOrEqual(dockBox.y + 1)
      // More takes the sheet's place, then the swatch takes it back (nothing picked yet, so
      // nothing is committed on the way).
      await toolbar.getByRole('button', { name: 'More' }).tap()
      await expect(picker).toBeHidden()
      await expect(sheet).toBeVisible()
      await toolbar.getByRole('button', { name: /Text colour/ }).tap()
      await expect(sheet).toBeHidden()
      await expect(picker).toBeVisible()
      await expect(undo).toBeDisabled()
      // A pick: a tap in the saturation square. The chip follows; the label does not yet.
      const sat = (await picker.locator('.react-colorful__saturation').boundingBox())!
      await page.touchscreen.tap(sat.x + sat.width * 0.8, sat.y + sat.height * 0.2)
      await expect.poll(chipColor).not.toBe(before)
      expect(await storedColor()).toBeNull()
      await expect(undo).toBeDisabled()
      // A tap on the photo closes it and commits the pick as one change.
      await page.touchscreen.tap(photo.x, photo.y)
      await expect(picker).toBeHidden()
      await expect.poll(storedColor, { timeout: 5_000 }).toMatch(/^#[0-9a-f]{6}$/i)
      await expect(undo).toBeEnabled()
      await undo.tap()
      await expect.poll(storedColor, { timeout: 5_000 }).toBeNull()
      await expect(undo).toBeDisabled()
      // That touch may have landed on anything; back to the label.
      const at = await labelPoint()
      await page.touchscreen.tap(at.x, at.y)
      await expect.poll(selected).toEqual([id])
    }
```

The More/swatch exchange comes before the pick on purpose: every close commits, so a pick followed by More would already be one undo entry, and item 6 counts one entry for pick-then-photo-tap.

- [ ] **Step 2: Run to verify it passes, and the whole suite**

Run: `make e2e`
Expected: 20 passed, 1 skipped. If the saturation tap does not change the chip (react-colorful listens to pointer events; a CDP touch should produce them), use `touch.path([...])` from `touchDriver` for a short drag inside the square instead, and note it.

- [ ] **Step 3: SPEC § 6.5 and § 14**

In "The docked label bar", replace the bullet "The colour swatch opens the same picker as on the desktop, placed against the bar and upwards over the image. (A sheet replaces it in the last step of #57.)" with:

> - The colour swatch opens the picker as a sheet above the bar, full width, with the same picker, hex field and **Use default** as the desktop popover. A pick shows on the swatch chip while the sheet is open; the label on the image changes when the sheet closes, as one undo entry; a typed hex commits at once; Use default clears the override. Only one sheet is open at a time: the swatch closes More and More closes the colour sheet, each committing on the way out. The view pans up for it as for More.

Delete the bullet "On a phone narrower than 375 px the bar's right edge may be cut off until the last step of #57." and add after the bar bullet: "Narrower than 375 px, the bar scrolls sideways; its sheets are not cut off with it." In § 14 change the Touch editor line to: "Touch editor (§ 6.5): not yet checked on a real iPhone (planned for the first release carrying it) or on any tablet (#263)."

- [ ] **Step 4: README**

In "What it does", extend the **Annotate** bullet with one sentence: "Small corrections work by touch too: on a phone, fingers zoom and pan, a tap selects a label, and its controls dock under the photo."

- [ ] **Step 5: Lint, tests, commit**

Run: `make lint test`
Expected: all green (pytest 631; vitest 549 + the new tests).

```bash
git add frontend/e2e/touch.spec.ts docs/SPEC.md README.md
git commit -m "docs: the colour sheet in SPEC § 6.5 and the README (#57)"
```

- [ ] **Step 6: Review ritual, then the owner's smoke test**

`/code-review high`, then the silent-failure pass on the branch diff, then `/simplify`; fix with RED→GREEN tests, `make lint test`, commit. Then restart `astrocaption-dev` and hand to the owner for `http://localhost:5173` in desktop devtools at iPhone size (one finger; devtools cannot pinch), and wait:

- tap a label; tap the swatch: a sheet rises over the bottom of the photo, as wide as the screen; drag in the colour square: the chip in the bar follows, the label does not; tap the photo: the sheet closes and the label takes the colour; the undo arrow undoes it in one step;
- swatch, then More: the colour sheet gives way to the More sheet; swatch again brings it back;
- "Use default" in the colour sheet clears the colour and closes the sheet;
- a label low in the photo stays visible when the colour sheet opens;
- set the device to iPhone SE (320 px): the bar scrolls sideways with a finger and the page does not;
- device toolbar off: the floating strip's colour popover is exactly as before.

- [ ] **Step 7: PR**

Push `feat/editor-touch-colour-sheet-57`; `gh pr create --title "feat: colour picker as a sheet in the docked bar (#57)" --milestone "Later (post-v1)"` with a body that says `Closes #57`, lists the rulings and deferred minors from the ledger, and ends with the attribution line; `gh pr checks --watch`; stop and ask before merging. After the merge: `git checkout main && git pull`, delete the branch and `.superpowers/sdd/2026-11-14-editor-touch-pr3-colour-sheet/`, update the backlog memory (#57 closed), and tell the owner the real-iPhone check waits for the next release.
