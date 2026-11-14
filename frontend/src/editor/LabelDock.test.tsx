// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disableAll } from './editing'
import LabelDock from './LabelDock'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

// `Reset position` runs the browser placer, which measures text on a real canvas — vitest has
// none, so the module's function is replaced: it records its call, or throws on demand.
const placer = vi.hoisted(() => ({ throws: false, calls: [] as number[][] }))
vi.mock('./editing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./editing')>()
  return {
    ...actual,
    resetPositions: (ids: number[]) => {
      if (placer.throws) throw new Error('this browser could not open a canvas to measure text with')
      placer.calls.push(ids)
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
  state().toggleObject(2, { x: 100, y: 100 }) // label 2 is enabled too: one undo entry so far
  state().select(1)
})
afterEach(() => {
  cleanup()
  placer.throws = false
  placer.calls = []
  vi.restoreAllMocks()
})

const dock = () => document.querySelector('.label-dock')
const sheet = () => screen.queryByRole('group', { name: 'More label options' })
const more = () => screen.getByRole('button', { name: 'More' })
const rename = () => screen.getByLabelText('Rename') as HTMLInputElement
const openSheet = () => fireEvent.click(more())
/** Whether the elements come in this order in the document. */
function inOrder(els: Element[]): boolean {
  return els.every((el, i) => i === 0 || Boolean(els[i - 1]!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
}

describe('LabelDock bar', () => {
  it('renders nothing without a selection', () => {
    state().select(null)
    render(<LabelDock box={box} />)
    expect(dock()).toBeNull()
  })

  it('is a toolbar of size, colour, Hide and More, in that order, with no sheet', () => {
    render(<LabelDock box={box} />)
    const bar = screen.getByRole('toolbar', { name: 'Selected labels' })
    expect(bar).toBe(dock())
    expect(
      inOrder([
        screen.getByRole('button', { name: 'Smaller' }),
        screen.getByLabelText('Font size'),
        screen.getByRole('button', { name: 'Larger' }),
        screen.getByRole('button', { name: /Text colour/ }),
        screen.getByRole('button', { name: 'Hide' }),
        more(),
      ]),
    ).toBe(true)
    expect(sheet()).toBeNull()
    expect(more().getAttribute('aria-pressed')).toBe('false')
  })

  it('its controls are the strip\'s: Larger steps the size as one change', () => {
    render(<LabelDock box={box} />)
    fireEvent.click(screen.getByRole('button', { name: 'Larger' }))
    expect(label(1).font_size).toBe(25)
    expect(state().undo).toHaveLength(2)
  })

  it('Hide switches the selection off as one change, and the dock goes with it', () => {
    render(<LabelDock box={box} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(label(1).enabled).toBe(false)
    expect(state().undo).toHaveLength(2)
    expect(dock()).toBeNull()
  })

  it('Hide keeps a name and a size that were still being typed', () => {
    render(<LabelDock box={box} />)
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '30' } })
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Great Nebula' } })
    // Hide refuses the focus, so neither field ever blurs.
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(label(1)).toMatchObject({ enabled: false, text_override: 'Great Nebula', font_size: 30 })
    // The hiding is the last change: one Undo brings the label back as it was left.
    act(() => state().undoLast())
    expect(label(1)).toMatchObject({ enabled: true, text_override: 'Great Nebula', font_size: 30 })
  })

  it('Hide takes every selected label at once', () => {
    state().toggleSelect(2)
    render(<LabelDock box={box} />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(label(1).enabled || label(2).enabled).toBe(false)
    expect(state().undo).toHaveLength(2)
  })
})

describe('LabelDock sheet', () => {
  it('More opens it with its rows in order; More again closes it', () => {
    render(<LabelDock box={box} />)
    openSheet()
    expect(sheet()).not.toBeNull()
    expect(more().getAttribute('aria-pressed')).toBe('true')
    expect(
      inOrder([
        rename(),
        screen.getByLabelText('Aliases'),
        screen.getByLabelText('Leader'),
        screen.getByRole('button', { name: 'Pin in place' }),
        screen.getByRole('button', { name: 'Reset position' }),
        screen.getByRole('button', { name: 'Clear overrides' }),
      ]),
    ).toBe(true)
    fireEvent.click(more())
    expect(sheet()).toBeNull()
  })

  it('Escape closes it and goes no further', () => {
    render(<LabelDock box={box} />)
    openSheet()
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    fireEvent.keyDown(rename(), { key: 'Escape' })
    window.removeEventListener('keydown', seen)
    expect(sheet()).toBeNull()
    expect(seen).not.toHaveBeenCalled() // the canvas's own Escape would clear the selection
    expect([...state().selectedIds]).toEqual([1])
  })

  it('Escape closes it wherever the focus is', () => {
    render(<LabelDock box={box} />)
    openSheet() // More refuses the focus, so it is still on the body
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', seen)
    expect(sheet()).toBeNull()
    expect(seen).not.toHaveBeenCalled()
    expect([...state().selectedIds]).toEqual([1])
  })

  it('a press anywhere else closes it; one inside does not', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.mouseDown(screen.getByLabelText('Aliases'))
    expect(sheet()).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(sheet()).toBeNull()
  })

  it('a press elsewhere keeps a name that was being typed', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Great Nebula' } })
    // A mouse press removes the field before any blur could reach it.
    fireEvent.mouseDown(document.body)
    expect(sheet()).toBeNull()
    expect(label(1).text_override).toBe('Great Nebula')
    expect(state().undo).toHaveLength(2)
  })

  it('Escape drops a name that was being typed', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Great Nebula' } })
    fireEvent.keyDown(rename(), { key: 'Escape' })
    expect(label(1).text_override).toBeNull()
    openSheet()
    expect(rename().value).toBe('M 42')
  })

  it('Rename shows the name, commits on Enter as one change, and stays open', () => {
    render(<LabelDock box={box} />)
    openSheet()
    expect(rename().value).toBe('M 42')
    fireEvent.change(rename(), { target: { value: '  Great Nebula ' } })
    fireEvent.keyDown(rename(), { key: 'Enter' })
    expect(label(1).text_override).toBe('Great Nebula')
    expect(state().undo).toHaveLength(2)
    expect(rename().value).toBe('Great Nebula')
    expect(sheet()).not.toBeNull()
  })

  it('a blank Rename goes back to the catalogue name; leaving the field commits too', () => {
    state().updateLabels([1], { text_override: 'Great Nebula' })
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: '' } })
    fireEvent.blur(rename())
    expect(label(1).text_override).toBeNull()
    expect(rename().value).toBe('M 42')
  })

  it('an untouched Rename field commits nothing', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.focus(rename())
    fireEvent.blur(rename())
    expect(label(1).text_override).toBeNull()
    expect(state().undo).toHaveLength(1)
  })

  it('a name half typed belongs to the label it was typed for', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Great Nebula' } })
    // A press on the photo ends the edit first (the gesture layer blurs the field, for a finger
    // and for a mouse on a label alike), and only then moves the selection.
    fireEvent.blur(rename())
    act(() => state().select(2))
    expect(label(1).text_override).toBe('Great Nebula')
    expect(label(2).text_override).toBeNull()
    expect(state().undo).toHaveLength(2)
    expect(sheet()).toBeNull()
    openSheet()
    expect(rename().value).toBe('Alnitak')
  })

  it('several labels: no Rename, "mixed" where they differ', () => {
    state().updateLabels([1], { show_aliases: true })
    state().toggleSelect(2)
    render(<LabelDock box={box} />)
    openSheet()
    expect(screen.queryByLabelText('Rename')).toBeNull()
    expect((screen.getByLabelText('Aliases') as HTMLSelectElement).value).toBe('mixed')
    expect((screen.getByLabelText('Leader') as HTMLSelectElement).value).toBe('auto')
    // The row already says which field it is; the choices do not repeat it as the strip's do.
    const shown = (name: string) => (screen.getByLabelText(name) as HTMLSelectElement).selectedOptions[0]!.textContent
    expect(shown('Aliases')).toBe('mixed')
    expect(shown('Leader')).toBe('auto')
  })

  it('Aliases, Leader and Pin act on the selection and leave the sheet open', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(screen.getByLabelText('Aliases'), { target: { value: 'on' } })
    fireEvent.change(screen.getByLabelText('Leader'), { target: { value: 'off' } })
    const pin = screen.getByRole('button', { name: 'Pin in place' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pin)
    expect(label(1)).toMatchObject({ show_aliases: true, leader: 'off', pinned: true })
    expect(screen.getByRole('button', { name: 'Pin in place' }).getAttribute('aria-pressed')).toBe('true')
    expect(state().undo).toHaveLength(4)
    expect(sheet()).not.toBeNull()
  })

  it('Reset position and Clear overrides act and close the sheet', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }))
    expect(placer.calls).toEqual([[1]])
    expect(sheet()).toBeNull()

    act(() => state().updateLabels([1], { font_size: 40, color: '#123456', text_override: 'X', leader: 'on', show_aliases: false }))
    openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Clear overrides' }))
    expect(label(1)).toMatchObject({ font_size: null, color: null, text_override: null, leader: 'auto', show_aliases: null })
    expect(sheet()).toBeNull()
  })

  it('Clear overrides drops a name that was being typed instead of storing it first', () => {
    state().updateLabels([1], { font_size: 40 })
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Great Nebula' } })
    const before = state().undo.length
    fireEvent.click(screen.getByRole('button', { name: 'Clear overrides' }))
    expect(label(1)).toMatchObject({ font_size: null, text_override: null })
    expect(state().undo).toHaveLength(before + 1)
  })

  it('a Reset position that throws reports it and changes nothing', () => {
    placer.throws = true
    const onError = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<LabelDock box={box} onError={onError} />)
    openSheet()
    const before = state().labels
    fireEvent.click(screen.getByRole('button', { name: 'Reset position' }))
    expect(onError).toHaveBeenCalledWith('The labels could not be placed again; nothing was moved.')
    expect(state().labels).toBe(before)
    expect(sheet()).toBeNull()
  })

  it('goes away quietly when the label does, or when the document turns read-only', () => {
    render(<LabelDock box={box} />)
    openSheet()
    fireEvent.change(rename(), { target: { value: 'Great Nebula' } })
    const before = state().undo.length
    act(() => disableAll([1]))
    expect(dock()).toBeNull()
    // The label is gone (an undo could have taken it): a name typed for it is not stored on the
    // way out, which would also be a new change on top of that undo and cost the redo.
    expect(state().labels.get(1)?.text_override).toBeNull()
    expect(state().undo).toHaveLength(before + 1)

    act(() => {
      state().undoLast()
      state().select(1)
    })
    openSheet()
    const entries = state().undo.length
    act(() => {
      state().load({ ...makeDoc(), image: { ...makeDoc().image, solve_status: 'solving' } })
      state().select(1)
    })
    expect(dock()).toBeNull()
    expect(state().undo.length).toBeLessThanOrEqual(entries)
  })
})

describe('LabelDock keeps the selection in view', () => {
  /** jsdom measures everything as 0 × 0: the sheet and the dock are given heights by hand. */
  function sheetHeight(height: number, dockHeight = 0) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const isSheet = this.classList.contains('label-sheet') || this.classList.contains('color-sheet')
      const h = isSheet ? height : this.classList.contains('label-dock') ? dockHeight : 0
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) } as DOMRect
    })
  }

  it('appearing takes the bottom of the canvas: a label selected down there is moved up into view', () => {
    sheetHeight(300, 60)
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    // The canvas is 800 tall and is about to lose 60 to the dock; the box's bottom is at 780.
    render(<LabelDock box={{ ...box, bottom: 1560 }} />)
    expect(state().view).toEqual({ scale: 0.5, x: 0, y: -48 })
  })

  it('appearing leaves the view alone when the selection is clear of it', () => {
    sheetHeight(300, 60)
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    const before = state().view
    render(<LabelDock box={{ ...box, bottom: 1400 }} />) // screen y 700, the dock starts at 740
    expect(state().view).toBe(before)
  })

  it('a sheet taller than the canvas scrolls inside it and moves nothing', () => {
    sheetHeight(900)
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    const before = state().view
    render(<LabelDock box={{ ...box, bottom: 1400 }} />)
    openSheet()
    expect(state().view).toBe(before) // there is no room left to show the label in
    expect((dock() as HTMLElement).style.getPropertyValue('--sheet-max')).toBe('792px')
  })

  it('pans the photo up by just enough when the sheet would cover the selection', () => {
    sheetHeight(300)
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    render(<LabelDock box={{ ...box, bottom: 1400 }} />) // the box's bottom is at screen y 700
    openSheet()
    // The canvas is 800 tall and the sheet covers its lowest 300: 700 + 8 has to come up to 500.
    expect(state().view).toEqual({ scale: 0.5, x: 0, y: -208 })
  })

  it('pans the photo up when the colour sheet would cover the selection', () => {
    sheetHeight(300)
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    render(<LabelDock box={{ ...box, bottom: 1400 }} />)
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    expect(state().view).toEqual({ scale: 0.5, x: 0, y: -208 })
  })

  it('leaves the view alone when the selection is clear of the sheet, and on closing', () => {
    sheetHeight(300)
    act(() => state().setView({ scale: 0.5, x: 0, y: 0 }))
    const before = state().view
    render(<LabelDock box={{ ...box, bottom: 400 }} />) // screen y 200
    openSheet()
    expect(state().view).toBe(before)
    fireEvent.click(more())
    expect(state().view).toBe(before)
  })
})

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

  it('Escape closes the colour sheet and goes no further, so the selection stays', () => {
    render(<LabelDock box={box} />)
    fireEvent.click(swatch())
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    fireEvent.keyDown(document, { key: 'Escape' })
    window.removeEventListener('keydown', seen)
    expect(colourSheet()).toBeNull()
    expect(seen).not.toHaveBeenCalled() // the canvas's own Escape would clear the selection
    expect([...state().selectedIds]).toEqual([1])
    expect(dock()).not.toBeNull()
  })

  it('Use default clears the colour as one change and closes the sheet, with nothing put back', () => {
    act(() => state().updateLabels([1], { color: '#123456' }))
    const before = state().undo.length
    render(<LabelDock box={box} />)
    fireEvent.click(swatch())
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(colourSheet()).toBeNull()
    expect(label(1).color).toBeNull()
    expect(state().undo).toHaveLength(before + 1)
    expect(sheet()).toBeNull()
    expect(more().getAttribute('aria-pressed')).toBe('false')
  })

  it('the colour sheet lies inside the dock that caps it at the canvas height', () => {
    render(<LabelDock box={box} />)
    fireEvent.click(swatch())
    const capped = colourSheet()!.closest<HTMLElement>('[style*="--sheet-max"]')
    expect(capped).toBe(dock())
    expect(capped!.style.getPropertyValue('--sheet-max')).toBe('792px')
  })

  it('goes away with a selection change that no press caused, as the More sheet does', () => {
    act(() => state().select(1))
    act(() => state().toggleSelect(2))
    render(<LabelDock box={box} />)
    fireEvent.click(swatch())
    expect(colourSheet()).not.toBeNull()
    act(() => state().undoLast()) // label 2 goes dark again: the selection is pruned to label 1
    expect([...state().selectedIds]).toEqual([1])
    expect(colourSheet()).toBeNull()
    expect(dock()).not.toBeNull()
  })
})
