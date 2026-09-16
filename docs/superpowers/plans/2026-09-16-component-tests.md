# Component Tests for the Style Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Component tests under jsdom for the three interaction-heavy pieces PR 3 shipped without any: `ColorField`, `StyleTab` and `StyleForm` (values mode), so the bugs reviewers found by tracing closures are caught by tests from now on.

**Architecture:** The harness is already on the branch (commit "test: component-test harness"): `jsdom` and `@testing-library/react` as dev dependencies, vitest include widened to `*.test.{ts,tsx}`, node stays the default environment and each component test opts in with `// @vitest-environment jsdom` on line 1. Tests render the real components with Testing Library, drive them with `fireEvent`, use `vi.useFakeTimers()` for the 400 ms debounce, and assert on the Zustand store (`useEditor.getState()`) rather than on mocks. `../api` and `./fonts` are mocked per file where a component would otherwise fetch.

**Tech Stack:** vitest 5, @testing-library/react 16, jsdom 30, React 19, Zustand.

**Spec:** Issue #95; the behaviours under test are the ones settled by PR #99's reviews (design spec `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md` § C "Style tab" and the ledger rulings recorded in PR #99's description).

## Global Constraints

- Tests assert behaviour, never implementation: the number of store commits (`useEditor.getState().undo.length`), the committed values (`useEditor.getState().style`), what is rendered. No spying on internal helpers.
- Fake timers only where a debounce is involved (`vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`); `act()`-wrapped timer advances (`await act(async () => { vi.advanceTimersByTime(400) })`).
- Every test file: `// @vitest-environment jsdom` as the first line; `afterEach(cleanup)`; `useEditor.getState().reset()` in `beforeEach` where the store is used; `makeDoc()` from `frontend/src/editor/testDoc.ts` for the document.
- jsdom has no layout: `getBoundingClientRect` returns zeros, so the popover-flip side and any geometry stay out of scope (Playwright and the owner's smoke test cover them).
- No new dependencies beyond the two already added. TypeScript strict; eslint clean (`react-refresh/only-export-components` does not apply to test files, but keep test files free of exports).
- Conventional one-line commit subjects; end every commit message with the attribution trailer the session reminder gives.
- Never run `npm ci`/`npm install`/`make install FORCE=1`; never touch `data/`; never restart the dev unit. Checks: `cd frontend && npx vitest run`, `npx tsc --noEmit`, `npx eslint src`.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/src/style/ColorField.test.tsx` | exactly-once commit per close path; typed hex commits its own value; `allowDefault`/`disabled` rendering |
| `frontend/src/editor/StyleTab.test.tsx` | debounce lifecycle, undo cancels, unmount flushes, invalid input feedback, font load await and failure, same-font pick with a fallback, reset to site defaults, colour commit through the real picker |
| `frontend/src/style/StyleForm.test.tsx` | values vs overrides rendering rules |
| `CLAUDE.md` | one line under Coding conventions about component tests |

---

### Task 1: `ColorField.test.tsx`

**Files:**
- Create: `frontend/src/style/ColorField.test.tsx`

**Interfaces:**
- Consumes: `ColorField` props `{ label, value, fallback, allowDefault?, disabled?, onChange(hex), onCommit?(hex?) }`; the swatch is a `button` whose accessible name includes the label; the popover is `role="dialog"`; the hex input is the `input` inside the dialog (react-colorful's `HexColorInput`); the picker's drag surface is `.react-colorful__interactive`.

- [ ] **Step 1: Write the tests**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ColorField from './ColorField'

afterEach(cleanup)

function mount(over: Partial<Parameters<typeof ColorField>[0]> = {}) {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  render(
    <ColorField label="Text colour" value="#ffffff" fallback="#000000" allowDefault={false} onChange={onChange} onCommit={onCommit} {...over} />,
  )
  const swatch = screen.getByRole('button', { name: /Text colour/ })
  return { onChange, onCommit, swatch, open: () => fireEvent.click(swatch), dialog: () => screen.queryByRole('dialog') }
}

describe('ColorField commits exactly once per close', () => {
  it('Escape', () => {
    const f = mount()
    f.open()
    expect(f.dialog()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(f.dialog()).toBeNull()
    expect(f.onCommit).toHaveBeenCalledTimes(1)
    expect(f.onCommit).toHaveBeenCalledWith()
  })
  it('click away, even when focus was inside the popover (mousedown then blur)', () => {
    const f = mount()
    f.open()
    const hex = screen.getByRole('dialog').querySelector('input')!
    hex.focus()
    fireEvent.mouseDown(document.body)
    fireEvent.blur(hex, { relatedTarget: document.body })
    expect(f.dialog()).toBeNull()
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })
  it('the swatch toggled shut', () => {
    const f = mount()
    f.open()
    fireEvent.click(f.swatch)
    expect(f.dialog()).toBeNull()
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })
  it('a picker drag then click away commits once, after the last onChange', () => {
    const f = mount()
    f.open()
    const surface = screen.getByRole('dialog').querySelector('.react-colorful__interactive')!
    fireEvent.mouseDown(surface, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { clientX: 20, clientY: 20 })
    fireEvent.mouseUp(document)
    expect(f.onChange).toHaveBeenCalled()
    expect(f.onCommit).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(f.onCommit).toHaveBeenCalledTimes(1)
    expect(f.onChange.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.onCommit.mock.invocationCallOrder[0]!)
  })
})

describe('ColorField typed hex', () => {
  it('commits its own normalised value at once and keeps the popover open', () => {
    const f = mount()
    f.open()
    const hex = screen.getByRole('dialog').querySelector('input')!
    fireEvent.change(hex, { target: { value: 'ff8800' } })
    expect(f.onChange).toHaveBeenLastCalledWith('#ff8800')
    expect(f.onCommit).toHaveBeenCalledTimes(1)
    expect(f.onCommit).toHaveBeenLastCalledWith('#ff8800')
    expect(f.dialog()).not.toBeNull()
  })
})

describe('ColorField rendering', () => {
  it('values mode shows no default chip and no Use default button', () => {
    const f = mount()
    expect(screen.queryByText('default')).toBeNull()
    f.open()
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull()
  })
  it('overrides mode shows the default chip for a blank value and Use default clears it', () => {
    const f = mount({ allowDefault: true, value: '' })
    expect(screen.getByText('default')).toBeTruthy()
    f.open()
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(f.onChange).toHaveBeenCalledWith('')
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })
  it('disabled disables the swatch', () => {
    const f = mount({ disabled: true })
    expect(f.swatch).toHaveProperty('disabled', true)
  })
})
```

Adjust the drag simulation if react-colorful needs `pointer` events or a `touches` shape in jsdom (read `node_modules/react-colorful/dist/index.module.js` for the handler names it binds); the assertion that matters is "onChange fired during the drag, one commit after the close, ordered after the last onChange".

- [ ] **Step 2: Run** — `cd frontend && npx vitest run src/style/ColorField.test.tsx` → all pass. If the click-away test shows two commits, the component's `openRef` guard is broken; that is a real finding, report it rather than weakening the test.

- [ ] **Step 3: Commit** — `git add frontend/src/style/ColorField.test.tsx && git commit -m "test(style): ColorField commits exactly once per close and the typed hex carries its value"`

---

### Task 2: `StyleTab.test.tsx`

**Files:**
- Create: `frontend/src/editor/StyleTab.test.tsx`

**Interfaces:**
- Consumes: the store (`useEditor` with `load`, `reset`, `undoLast`, `style`, `undo`, `fontFallback`, `save`), `makeDoc()`, `StyleTab` (renders `StyleForm mode="values"` with a "Reset to site defaults" button), labels: "Font size (px)" (number input), "Font" (select, `htmlFor`-linked), "Halo" (select), "Text colour" (swatch button), the note text `Whole number between 6 and 200.` for an invalid font size, the fallback sentence from `fallbackSentence`.
- Mocks: `vi.mock('../api', ...)` providing `api.imageDefaultStyle` and `pageError`; `vi.mock('./fonts', ...)` providing `loadBundledFont` (resolved or rejected per test).

- [ ] **Step 1: Write the tests**

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { loadBundledFont } from './fonts'
import { useEditor } from './store'
import StyleTab from './StyleTab'
import { makeDoc } from './testDoc'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, imageDefaultStyle: vi.fn() } }
})
vi.mock('./fonts', () => ({ loadBundledFont: vi.fn() }))

const doc = () => makeDoc()

beforeEach(() => {
  vi.useFakeTimers()
  useEditor.getState().reset()
  vi.mocked(loadBundledFont).mockReset().mockResolvedValue('Inter-Regular')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const state = () => useEditor.getState()
const fontSize = () => screen.getByLabelText('Font size (px)') as HTMLInputElement
const tick = async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

describe('StyleTab numbers', () => {
  it('debounces keystrokes into one commit of the final value', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '1' } })
    fireEvent.change(fontSize(), { target: { value: '10' } })
    fireEvent.change(fontSize(), { target: { value: '100' } })
    expect(state().style?.font_size).toBe(24)
    await tick(400)
    expect(state().style?.font_size).toBe(100)
    expect(state().undo).toHaveLength(1)
  })
  it('blur and Enter flush at once', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '30' } })
    fireEvent.blur(fontSize())
    expect(state().style?.font_size).toBe(30)
    fireEvent.change(fontSize(), { target: { value: '40' } })
    fireEvent.keyDown(fontSize(), { key: 'Enter' })
    expect(state().style?.font_size).toBe(40)
    expect(state().undo).toHaveLength(2)
  })
  it('an invalid value commits nothing and says why', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '3' } })
    await tick(400)
    expect(state().style?.font_size).toBe(24)
    expect(fontSize().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Whole number between 6 and 200.')).toBeTruthy()
  })
  it('undo while a value is pending cancels it', async () => {
    state().load(doc())
    state().toggleObject(1) // something to undo
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '50' } })
    act(() => state().undoLast())
    await tick(400)
    expect(state().style?.font_size).toBe(24)
    expect(fontSize().value).toBe('24')
  })
  it('unmount flushes a pending value', async () => {
    state().load(doc())
    const view = render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '60' } })
    view.unmount()
    expect(state().style?.font_size).toBe(60)
  })
  it('the form follows undo', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '30' } })
    fireEvent.blur(fontSize())
    act(() => state().undoLast())
    expect(fontSize().value).toBe('24')
  })
})

describe('StyleTab fonts', () => {
  it('commits a font only once the browser loaded it', async () => {
    state().load(doc())
    let resolve!: (f: string) => void
    vi.mocked(loadBundledFont).mockReturnValue(new Promise((r) => { resolve = r }))
    render(<StyleTab />)
    const font = screen.getByLabelText('Font') as HTMLSelectElement
    fireEvent.change(font, { target: { value: 'Roboto-Bold.ttf' } })
    expect(font.disabled).toBe(true)
    expect(state().style?.font_file).toBe('Inter-Regular.ttf')
    await act(async () => { resolve('Roboto-Bold') })
    expect(state().style?.font_file).toBe('Roboto-Bold.ttf')
    expect(state().undo).toHaveLength(1)
  })
  it('keeps the previous font and shows the sentence when the load fails', async () => {
    state().load(doc())
    vi.mocked(loadBundledFont).mockRejectedValue(new Error('Font Roboto-Bold.ttf could not be loaded.'))
    render(<StyleTab />)
    const font = screen.getByLabelText('Font') as HTMLSelectElement
    await act(async () => { fireEvent.change(font, { target: { value: 'Roboto-Bold.ttf' } }) })
    expect(state().style?.font_file).toBe('Inter-Regular.ttf')
    expect(font.value).toBe('Inter-Regular.ttf')
    expect(screen.getByText('Font Roboto-Bold.ttf could not be loaded.')).toBeTruthy()
    expect(state().undo).toHaveLength(0)
  })
  it('picking the font already in use clears a pending fallback notice with one commit', async () => {
    state().load({ ...doc(), fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' } })
    render(<StyleTab />)
    expect(screen.getByText(/set up with Gone\.ttf/)).toBeTruthy()
    const font = screen.getByLabelText('Font') as HTMLSelectElement
    await act(async () => { fireEvent.change(font, { target: { value: 'Inter-Regular.ttf' } }) })
    expect(state().fontFallback).toBeNull()
    expect(state().undo).toHaveLength(1)
    expect(screen.queryByText(/set up with Gone\.ttf/)).toBeNull()
  })
})

describe('StyleTab reset and colour', () => {
  it('reset to site defaults is one commit of the server\'s style', async () => {
    state().load(doc())
    const def = { ...doc().annotations.style, font_size: 36, text_color: '#ff8800' }
    vi.mocked(api.imageDefaultStyle).mockResolvedValue(def)
    render(<StyleTab />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reset to site defaults' })) })
    expect(state().style).toEqual(def)
    expect(state().undo).toHaveLength(1)
    expect(fontSize().value).toBe('36')
  })
  it('a colour typed then closed is one commit', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    const hex = screen.getByRole('dialog').querySelector('input')!
    fireEvent.change(hex, { target: { value: '#ff8800' } })
    expect(state().style?.text_color).toBe('#ff8800')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(state().undo).toHaveLength(1) // the close committed the same value: no second entry
  })
  it('controls are disabled while the document is not editable', () => {
    const d = doc()
    state().load({ ...d, image: { ...d.image, solve_status: 'solving' } })
    render(<StyleTab />)
    expect(fontSize().disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reset to site defaults' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
```

The doc's font list (`makeDoc().fonts`) holds only `Inter-Regular.ttf`; for the Roboto cases add a second `FontOut` to the loaded doc (`fonts: [...d.fonts, { ...d.fonts[0]!, file: 'Roboto-Bold.ttf', family: 'Roboto', weight: 'Bold' }]`) so the select offers it and `fontFor` still resolves after the commit.

- [ ] **Step 2: Run** — `cd frontend && npx vitest run src/editor/StyleTab.test.tsx`. Every test here encodes a behaviour settled in PR #99's reviews; a failure is either a test-harness detail (label text, an `act` wrapper missing around an async state change) or a real defect. Fix harness details; report defects as DONE_WITH_CONCERNS with the failing assertion rather than changing component code.

- [ ] **Step 3: Commit** — `git add frontend/src/editor/StyleTab.test.tsx && git commit -m "test(editor): StyleTab debounce, undo, unmount, fonts, reset and colour commit"`

---

### Task 3: `StyleForm.test.tsx` and CLAUDE.md

**Files:**
- Create: `frontend/src/style/StyleForm.test.tsx`
- Modify: `CLAUDE.md` (Coding conventions)

- [ ] **Step 1: Write the tests**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FontOut, StyleDefaults } from '../api'
import { makeDoc } from '../editor/testDoc'
import StyleForm from './StyleForm'
import { styleFormFromConfig, styleFormFromOverrides } from './styleForm'

afterEach(cleanup)

const defaults: StyleDefaults = {
  font_file: 'Inter-Regular.ttf', text_color: '#FFFFFF', marker_color: '#FFD54A', leader_color: '#FFD54A',
  halo: true, halo_color: '#000000', show_aliases: true, name_preference: 'popular', max_aliases: 2,
}
const fonts: FontOut[] = makeDoc().fonts

describe('StyleForm overrides mode (config page)', () => {
  it('offers Default entries, placeholders and the one other preference', () => {
    render(<StyleForm mode="overrides" values={styleFormFromOverrides({})} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Default (Inter-Regular.ttf)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Default (on)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /^Default \(Messier/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'NGC and IC first' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Messier, Caldwell, Sharpless, Barnard first$/ })).toBeNull()
    expect((screen.getByLabelText('Font size (px)') as HTMLInputElement).placeholder).toBe('auto')
    expect((screen.getByLabelText('Aliases shown (max)') as HTMLInputElement).placeholder).toBe('Default (2)')
  })
})

describe('StyleForm values mode (Style tab)', () => {
  const values = styleFormFromConfig(makeDoc().annotations.style)
  it('offers no Default entries, both preferences by name, required numbers', () => {
    render(<StyleForm mode="values" values={values} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    expect(screen.queryByRole('option', { name: /^Default/ })).toBeNull()
    expect(screen.getByRole('option', { name: 'Messier, Caldwell, Sharpless, Barnard first' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'NGC and IC first' })).toBeTruthy()
    const size = screen.getByLabelText('Font size (px)') as HTMLInputElement
    expect(size.required).toBe(true)
    expect(size.placeholder).toBe('')
  })
  it('flags an out-of-range number with a note and aria-invalid', () => {
    render(<StyleForm mode="values" values={{ ...values, halo_width: '99' }} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    const halo = screen.getByLabelText('Halo width (px)') as HTMLInputElement
    expect(halo.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Whole number between 0 and 40.')).toBeTruthy()
  })
  it('keeps the current font selectable when it is not in the list', () => {
    render(<StyleForm mode="values" values={{ ...values, font_file: 'Gone.ttf' }} defaults={defaults} fonts={fonts} onChange={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Gone.ttf (not installed)' })).toBeTruthy()
  })
  it('forwards a number flush on blur and Enter', () => {
    const onNumberFlush = vi.fn()
    render(<StyleForm mode="values" values={values} defaults={defaults} fonts={fonts} onChange={vi.fn()} onNumberFlush={onNumberFlush} />)
    const size = screen.getByLabelText('Font size (px)')
    fireEvent.blur(size)
    fireEvent.keyDown(size, { key: 'Enter' })
    expect(onNumberFlush).toHaveBeenCalledTimes(2)
    expect(onNumberFlush).toHaveBeenCalledWith('font_size')
  })
})
```

Adjust option labels to the real `PREFERENCE_LABELS` strings and the `StyleFormProps` names (`onNumberFlush` exists on the branch; check its exact name in `StyleForm.tsx`).

- [ ] **Step 2: CLAUDE.md** — under "Coding conventions", after the "TypeScript strict…" bullet add: "- Component tests are `*.test.tsx` next to the component, with `// @vitest-environment jsdom` on line 1 (vitest stays in node otherwise); render with Testing Library and assert on the store or the DOM, never on internals."

- [ ] **Step 3: Run everything** — `cd frontend && npx vitest run && npx tsc --noEmit && npx eslint src` then `make lint test`. Expected: all green (the existing 189 tests plus the new files).

- [ ] **Step 4: Commit** — `git add frontend/src/style/StyleForm.test.tsx CLAUDE.md && git commit -m "test(style): StyleForm modes; note component tests in CLAUDE.md"`

---

### Task 4: Review and PR

- [ ] Whole-branch review (tests only: are they behavioural, non-vacuous, would they have caught PR 3's colour-commit and debounce defects?), `make lint test`, `make e2e` once (the vitest include change must not affect the build).
- [ ] `gh pr create` — title `test: component tests for ColorField, StyleTab and StyleForm under jsdom`; body `Closes #95`, names the two dev dependencies (approved by the owner on 2026-09-16), notes the Docker image is unaffected (dev dependencies live in the build stage only). `gh pr checks --watch`. Do not merge without the owner's go.
