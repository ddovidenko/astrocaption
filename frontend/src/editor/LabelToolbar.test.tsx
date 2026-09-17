// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LabelToolbar from './LabelToolbar'
import { useEditor } from './store'
import { makeDoc } from './testDoc'
import { toScreen } from './view'

// `Reset position` runs the browser placer, which measures text on a real canvas — vitest has
// none, so the failing path is reached by making the module throw on demand.
const placer = vi.hoisted(() => ({ throws: false }))
vi.mock('./editing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./editing')>()
  return {
    ...actual,
    resetPositions: (...args: Parameters<typeof actual.resetPositions>) => {
      if (placer.throws) throw new Error('this browser could not open a canvas to measure text with')
      return actual.resetPositions(...args)
    },
  }
})

const box = { left: 1552, top: 970, right: 1700, bottom: 1000 }
const state = () => useEditor.getState()
const label = (id: number) => state().labels.get(id)!

beforeEach(() => {
  state().reset()
  state().load(makeDoc())
  state().setViewport(1000, 800)
  state().toggleObject(2, { x: 100, y: 100 })
  state().select(1)
})
afterEach(() => {
  cleanup()
  placer.throws = false
  vi.restoreAllMocks()
})

const size = () => screen.getByLabelText('Font size') as HTMLInputElement

describe('LabelToolbar', () => {
  it('renders nothing without a selection', () => {
    state().select(null)
    const { container } = render(<LabelToolbar box={box} />)
    expect(container.querySelector('.label-toolbar')).toBeNull()
  })

  it('font size: blank means the global size; Enter commits; blank clears', () => {
    render(<LabelToolbar box={box} />)
    expect(size().value).toBe('')
    expect(size().placeholder).toBe('24')
    fireEvent.change(size(), { target: { value: '30' } })
    fireEvent.keyDown(size(), { key: 'Enter' })
    expect(label(1).font_size).toBe(30)
    expect(state().undo).toHaveLength(2) // toggleObject + this
    fireEvent.change(size(), { target: { value: '' } })
    fireEvent.blur(size())
    expect(label(1).font_size).toBeNull()
    fireEvent.change(size(), { target: { value: '3' } })
    fireEvent.blur(size())
    expect(label(1).font_size).toBeNull() // out of bounds: ignored
    expect(size().value).toBe('')
  })

  it('− / + step every selected label from its effective size', () => {
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    fireEvent.click(screen.getByLabelText('Larger'))
    expect(label(1).font_size).toBe(25)
    expect(label(2).font_size).toBe(25)
    expect(state().undo).toHaveLength(2)
    fireEvent.click(screen.getByLabelText('Smaller'))
    fireEvent.click(screen.getByLabelText('Smaller'))
    expect(label(1).font_size).toBe(23)
  })

  it('a blur with nothing typed leaves a mixed selection alone', () => {
    // The field is blank because the sizes differ, not because anyone cleared it: committing that
    // blank would wipe label 1's override on a stray focus.
    state().updateLabels([1], { font_size: 40 })
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    const entries = state().undo.length
    expect(size().value).toBe('')
    fireEvent.focus(size())
    fireEvent.blur(size())
    expect(label(1).font_size).toBe(40)
    expect(label(2).font_size).toBeNull()
    expect(state().undo).toHaveLength(entries)
  })

  it('a mixed selection shows a blank size and "mixed" selects', () => {
    state().updateLabels([1], { font_size: 40, leader: 'on' })
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    expect(size().value).toBe('')
    expect((screen.getByLabelText('Leader') as HTMLSelectElement).value).toBe('mixed')
    fireEvent.change(screen.getByLabelText('Leader'), { target: { value: 'off' } })
    expect(label(1).leader).toBe('off')
    expect(label(2).leader).toBe('off')
  })

  it('aliases and colour commit one entry each', () => {
    render(<LabelToolbar box={box} />)
    fireEvent.change(screen.getByLabelText('Aliases'), { target: { value: 'on' } })
    expect(label(1).show_aliases).toBe(true)
    fireEvent.change(screen.getByLabelText('Aliases'), { target: { value: 'inherit' } })
    expect(label(1).show_aliases).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: 'ff8800' } })
    expect(label(1).color).toBe('#ff8800')
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(label(1).color).toBeNull()
  })

  it('a picker drag is a live draft; the close commits it once', () => {
    render(<LabelToolbar box={box} />)
    const swatch = () => screen.getByRole('button', { name: /Text colour/ })
    fireEvent.click(swatch())
    const surface = screen.getByRole('dialog').querySelector('.react-colorful__interactive')!
    fireEvent.mouseDown(surface, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { clientX: 20, clientY: 20 })
    fireEvent.mouseUp(document)
    // The draft is on screen (the "default" chip is gone) but nothing is committed yet.
    expect(screen.queryByText('default')).toBeNull()
    expect(label(1).color).toBeNull()
    expect(state().undo).toHaveLength(1)
    fireEvent.mouseDown(document.body) // click away: one commit for the whole drag
    expect(label(1).color).toMatch(/^#[0-9a-f]{6}$/)
    expect(state().undo).toHaveLength(2)
    expect(swatch().textContent).toContain(label(1).color!.toUpperCase())
  })

  it('"Use default" after a drag clears the override instead of committing the draft', () => {
    state().updateLabels([1], { color: '#123456' }) // something to clear
    render(<LabelToolbar box={box} />)
    const entries = state().undo.length
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    const surface = screen.getByRole('dialog').querySelector('.react-colorful__interactive')!
    fireEvent.mouseDown(surface, { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(document, { clientX: 20, clientY: 20 })
    fireEvent.mouseUp(document)
    // ColorField clears, then closes itself: the close's onCommit still closes over the drag's
    // draft, and must not put it back.
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(label(1).color).toBeNull()
    expect(state().undo).toHaveLength(entries + 1)
  })

  it('a close with no drag commits nothing', () => {
    render(<LabelToolbar box={box} />)
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(label(1).color).toBeNull()
    expect(state().undo).toHaveLength(1)
  })

  it('a typed hex commits once, and closing after it records no second entry', () => {
    render(<LabelToolbar box={box} />)
    const swatch = () => screen.getByRole('button', { name: /Text colour/ })
    fireEvent.click(swatch())
    fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: 'ff8800' } })
    expect(label(1).color).toBe('#ff8800')
    expect(swatch().textContent).toContain('#FF8800')
    expect(state().undo).toHaveLength(2)
    fireEvent.keyDown(document, { key: 'Escape' }) // the draft went with the commit
    expect(state().undo).toHaveLength(2)
  })

  it('pin toggles the whole selection; reset unpins and moves; clear overrides clears', () => {
    state().moveLabel(1, 5, 5) // pinned now
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    const pin = screen.getByRole('button', { name: 'Pin (mixed)' })
    fireEvent.click(pin)
    expect(label(1).pinned && label(2).pinned).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    expect(label(1).pinned || label(2).pinned).toBe(false)

    state().updateLabels([1], { font_size: 40, color: '#123456', text_override: 'X', leader: 'on', show_aliases: false, pinned: true })
    fireEvent.click(screen.getByRole('button', { name: 'Clear overrides' }))
    expect(label(1)).toMatchObject({ font_size: null, color: null, text_override: null, leader: 'auto', show_aliases: null, pinned: true })
  })

  it('an undo of a committed size clears the draft with it', () => {
    render(<LabelToolbar box={box} />)
    fireEvent.change(size(), { target: { value: '30' } })
    fireEvent.keyDown(size(), { key: 'Enter' })
    expect(label(1).font_size).toBe(30)
    act(() => state().undoLast())
    const entries = state().undo.length
    expect(label(1).font_size).toBeNull()
    expect(size().value).toBe('') // not the 30 that was just undone
    fireEvent.blur(size())
    expect(label(1).font_size).toBeNull()
    expect(state().undo).toHaveLength(entries)
  })

  it('− / + drop a draft typed against a blank field', () => {
    state().updateLabels([1], { font_size: 40 })
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    fireEvent.change(size(), { target: { value: '99' } })
    fireEvent.click(screen.getByLabelText('Larger'))
    expect(label(1).font_size).toBe(41)
    expect(label(2).font_size).toBe(25)
    expect(size().value).toBe('') // still mixed: the 99 went with the step
  })

  it('+ at the maximum records nothing', () => {
    state().updateLabels([1], { font_size: 200 })
    render(<LabelToolbar box={box} />)
    const entries = state().undo.length
    fireEvent.click(screen.getByLabelText('Larger'))
    expect(label(1).font_size).toBe(200)
    expect(state().undo).toHaveLength(entries)
  })

  it('sits above the box, and below it when there is no room above', () => {
    const { container } = render(<LabelToolbar box={box} />)
    const el = container.querySelector('.label-toolbar') as HTMLElement
    const at = toScreen(state().view, box.left, box.top)
    // jsdom measures every element as 0x0, so the toolbar's own height drops out of `top`.
    expect(parseFloat(el.style.left)).toBeCloseTo(at.x, 3)
    expect(parseFloat(el.style.top)).toBeCloseTo(at.y - 8, 3)
    cleanup()

    // Against the top edge (world y 0 at screen y 0) there is no room above: it flips below.
    state().setView({ scale: 1, x: 0, y: 0 })
    const top = { left: 100, top: 0, right: 200, bottom: 30 }
    const flipped = render(<LabelToolbar box={top} />).container.querySelector('.label-toolbar') as HTMLElement
    expect(parseFloat(flipped.style.left)).toBeCloseTo(100, 3)
    expect(parseFloat(flipped.style.top)).toBeCloseTo(38, 3) // bottom 30 + the 8 px margin
  })

  it('a Reset position that throws reports it and changes nothing', () => {
    placer.throws = true
    const onError = vi.fn()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<LabelToolbar box={box} onError={onError} />)
    const before = state().labels
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('The labels could not be placed again; nothing was moved.')
    expect(state().labels).toBe(before)
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('an unparseable number (badInput) is ignored instead of read as a clear', () => {
    state().updateLabels([1], { font_size: 40 })
    render(<LabelToolbar box={box} />)
    expect(size().value).toBe('40')
    // Chromium hands over an empty string with `validity.badInput` set for 'e' or a lone '-'.
    Object.defineProperty(size(), 'validity', { value: { badInput: true }, configurable: true })
    fireEvent.change(size(), { target: { value: '' } })
    expect(size().value).toBe('40')
    fireEvent.blur(size())
    expect(label(1).font_size).toBe(40)
  })

  it('a mixed colour says so, and "Use default" clears the whole selection at once', () => {
    state().updateLabels([1], { color: '#112233' })
    state().updateLabels([2], { color: '#445566' })
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    const swatch = screen.getByRole('button', { name: /Text colour/ })
    expect(swatch.textContent).toContain('mixed')
    expect(swatch.textContent).not.toContain('default')
    fireEvent.click(swatch)
    const entries = state().undo.length
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(label(1).color).toBeNull()
    expect(label(2).color).toBeNull()
    expect(state().undo).toHaveLength(entries + 1)
  })

  it('is disabled while a solve is running', () => {
    state().load({ ...makeDoc(), image: { ...makeDoc().image, solve_status: 'solving' } })
    state().select(1)
    const { container } = render(<LabelToolbar box={box} />)
    expect(container.querySelector('.label-toolbar')).toBeNull()
  })
})
