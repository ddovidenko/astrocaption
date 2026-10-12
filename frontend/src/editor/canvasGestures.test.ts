// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCanvasGestures } from './canvasGestures'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

// The keyboard half of the gesture layer (#108) needs no Konva stage: the hook installs window
// listeners and talks to the store. The pointer half (pan, wheel, press and click) is pinned by
// the Playwright gesture specs, since it needs a real stage.

function mount() {
  return renderHook(() => useCanvasGestures({ current: null }))
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit) {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  act(() => {
    window.dispatchEvent(e)
  })
  return e
}

beforeEach(() => {
  useEditor.getState().reset()
  useEditor.getState().load(makeDoc())
  useEditor.getState().setViewport(1000, 800)
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('useCanvasGestures keys', () => {
  it('Space held sets spacePan, released or on window blur clears it', () => {
    const { result } = mount()
    expect(result.current.spacePan).toBe(false)
    const down = key('keydown', { code: 'Space', key: ' ' })
    expect(down.defaultPrevented).toBe(true) // the page must not scroll
    expect(result.current.spacePan).toBe(true)
    key('keyup', { code: 'Space', key: ' ' })
    expect(result.current.spacePan).toBe(false)
    key('keydown', { code: 'Space', key: ' ' })
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current.spacePan).toBe(false)
  })

  it('Space on a focused button is left to the button', () => {
    const { result } = mount()
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    const down = key('keydown', { code: 'Space', key: ' ' })
    expect(down.defaultPrevented).toBe(false)
    expect(result.current.spacePan).toBe(false)
  })

  it('Escape clears the selection; Delete disables the selected labels as one commit', () => {
    mount()
    useEditor.getState().select(1)
    key('keydown', { key: 'Escape' })
    expect(useEditor.getState().selectedIds.size).toBe(0)
    useEditor.getState().select(1)
    const del = key('keydown', { key: 'Delete' })
    expect(del.defaultPrevented).toBe(true)
    expect(useEditor.getState().labels.get(1)!.enabled).toBe(false)
    expect(useEditor.getState().selectedIds.size).toBe(0)
    expect(useEditor.getState().undo).toHaveLength(1)
  })

  it('Ctrl+Z undoes and Ctrl+Shift+Z / Ctrl+Y redo, also from a focused checkbox', () => {
    mount()
    useEditor.getState().toggleObject(2, { x: 100, y: 100 })
    expect(useEditor.getState().labels.get(2)!.enabled).toBe(true)
    key('keydown', { key: 'z', ctrlKey: true })
    expect(useEditor.getState().labels.get(2)!.enabled).toBe(false)
    key('keydown', { key: 'z', ctrlKey: true, shiftKey: true })
    expect(useEditor.getState().labels.get(2)!.enabled).toBe(true)
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    document.body.append(checkbox)
    checkbox.focus()
    key('keydown', { key: 'z', ctrlKey: true })
    expect(useEditor.getState().labels.get(2)!.enabled).toBe(false)
    key('keydown', { key: 'y', ctrlKey: true })
    expect(useEditor.getState().labels.get(2)!.enabled).toBe(true)
  })

  it('every shortcut is ignored while a text field has the focus', () => {
    const { result } = mount()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    useEditor.getState().select(1)
    key('keydown', { key: 'Escape' })
    key('keydown', { key: 'Delete' })
    key('keydown', { code: 'Space', key: ' ' })
    expect(useEditor.getState().selectedIds.has(1)).toBe(true)
    expect(useEditor.getState().labels.get(1)!.enabled).toBe(true)
    expect(result.current.spacePan).toBe(false)
  })

  it('Escape on a toolbar button clears the selection; in a toolbar field it does not (#104)', () => {
    mount()
    const toolbar = document.createElement('div')
    toolbar.className = 'label-toolbar'
    const swatch = document.createElement('button')
    const field = document.createElement('input')
    toolbar.append(swatch, field)
    document.body.append(toolbar)
    useEditor.getState().select(1)
    field.focus()
    key('keydown', { key: 'Escape' })
    expect(useEditor.getState().selectedIds.has(1)).toBe(true)
    swatch.focus()
    key('keydown', { key: 'Delete' }) // still a toolbar control: Delete stays with it
    expect(useEditor.getState().labels.get(1)!.enabled).toBe(true)
    key('keydown', { key: 'Escape' })
    expect(useEditor.getState().selectedIds.size).toBe(0)
  })

  it('f fits and 1 shows actual pixels', () => {
    mount()
    useEditor.getState().setView({ scale: 3, x: -500, y: -400 })
    key('keydown', { key: 'f' })
    const fitted = useEditor.getState().view
    expect(fitted.scale).toBeLessThan(1) // a 3000x2000 image in a 1000x800 viewport
    key('keydown', { key: '1' })
    expect(useEditor.getState().view.scale).toBe(1)
  })

  it('the listeners go with the hook', () => {
    const { result, unmount } = mount()
    unmount()
    key('keydown', { code: 'Space', key: ' ' })
    expect(result.current.spacePan).toBe(false)
  })
})
