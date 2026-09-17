// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ColorField from './ColorField'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** jsdom measures everything as 0x0, so the open-time measurement has to be fed by hand: the
 *  wrapper (`.color-field`) is the swatch's row, everything else — here the bound `openPicker`
 *  falls back to, `document.documentElement` — is the container it is measured against. */
function mockRects(wrap: { left: number; bottom: number }, bound: { right: number; bottom: number }) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = this.classList.contains('color-field')
      ? { left: wrap.left, right: wrap.left + 120, top: wrap.bottom - 30, bottom: wrap.bottom }
      : { left: 0, right: bound.right, top: 0, bottom: bound.bottom }
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect
  })
}

function mount(over: Partial<Parameters<typeof ColorField>[0]> = {}) {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  const onClear = vi.fn()
  render(
    <ColorField
      label="Text colour"
      value="#ffffff"
      fallback="#000000"
      allowDefault={false}
      onChange={onChange}
      onCommit={onCommit}
      onClear={onClear}
      {...over}
    />,
  )
  const swatch = screen.getByRole('button', { name: /Text colour/ })
  return { onChange, onCommit, onClear, swatch, open: () => fireEvent.click(swatch), dialog: () => screen.queryByRole('dialog') }
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
    // Both events must share one outer act(): a separate act() per fireEvent flushes and
    // unmounts the popover after the mousedown alone, so the blur would land on an already
    // detached node and the test could never see a double commit even with the openRef guard
    // stripped. One act() defers the re-render so both native handlers run against the still-
    // mounted popover, reproducing the real single-gesture race the guard defends against.
    act(() => {
      fireEvent.mouseDown(document.body)
      fireEvent.blur(hex, { relatedTarget: document.body })
    })
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

describe('ColorField placement', () => {
  it('opens below and left-aligned when the container has room', () => {
    mockRects({ left: 10, bottom: 100 }, { right: 1000, bottom: 800 })
    const f = mount()
    f.open()
    expect(screen.getByRole('dialog').className).toBe('popover')
  })

  it('opens upwards when the popover would not fit below the container', () => {
    // 232 px of popover under a swatch row ending 40 px above the container's bottom edge: in the
    // editor's canvas, which clips its overflow, that popover would simply not be seen.
    mockRects({ left: 10, bottom: 760 }, { right: 1000, bottom: 800 })
    const f = mount()
    f.open()
    expect(screen.getByRole('dialog').className).toContain('popover-up')
    expect(screen.getByRole('dialog').className).not.toContain('popover-right')
  })

  it('opens upwards and right-aligned when neither edge has room', () => {
    mockRects({ left: 900, bottom: 760 }, { right: 1000, bottom: 800 })
    const f = mount()
    f.open()
    expect(screen.getByRole('dialog').className).toBe('popover popover-right popover-up')
  })
})

describe('ColorField rendering', () => {
  it('values mode shows no default chip and no Use default button', () => {
    const f = mount()
    expect(screen.queryByText('default')).toBeNull()
    f.open()
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull()
  })
  it('overrides mode shows the default chip for a blank value', () => {
    mount({ allowDefault: true, value: '' })
    expect(screen.getByText('default')).toBeTruthy()
  })
  it('overrides mode: Use default clears a real override', () => {
    // The button is disabled (nothing to clear) when the value is already blank, so this needs a
    // concrete override to click it — see ColorField.tsx `disabled={!value}` on "Use default".
    const f = mount({ allowDefault: true, value: '#112233' })
    f.open()
    expect(screen.queryByText('default')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(f.onChange).toHaveBeenCalledWith('')
    // onClear names the clear, which a bare onCommit() (a plain close) cannot — and it is the
    // only callback for this click: the close it triggers is silent, so a caller holding a picker
    // draft (LabelToolbar) cannot have it put back over the clear it just asked for.
    expect(f.onClear).toHaveBeenCalledTimes(1)
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it('mixed says "mixed" instead of "default" and leaves Use default clickable', () => {
    // The caller's selection holds several colours, so the blank value means "they differ" —
    // there is something to clear, unlike a blank that means "no override".
    const f = mount({ allowDefault: true, value: '', mixed: true })
    expect(screen.getByText('mixed')).toBeTruthy()
    expect(screen.queryByText('default')).toBeNull()
    f.open()
    const useDefault = screen.getByRole('button', { name: 'Use default' })
    expect(useDefault).toHaveProperty('disabled', false)
    fireEvent.click(useDefault)
    expect(f.onClear).toHaveBeenCalledTimes(1)
  })
  it('disabled disables the swatch', () => {
    const f = mount({ disabled: true })
    expect(f.swatch).toHaveProperty('disabled', true)
  })
})
