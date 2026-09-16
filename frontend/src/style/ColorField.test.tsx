// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    expect(f.onCommit).toHaveBeenCalledTimes(1)
  })
  it('disabled disables the swatch', () => {
    const f = mount({ disabled: true })
    expect(f.swatch).toHaveProperty('disabled', true)
  })
})
