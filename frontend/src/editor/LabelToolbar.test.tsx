// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LabelToolbar from './LabelToolbar'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

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
afterEach(cleanup)

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

  it('is disabled while a solve is running', () => {
    state().load({ ...makeDoc(), image: { ...makeDoc().image, solve_status: 'solving' } })
    state().select(1)
    const { container } = render(<LabelToolbar box={box} />)
    expect(container.querySelector('.label-toolbar')).toBeNull()
  })
})
