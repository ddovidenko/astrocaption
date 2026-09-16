// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LabelTextEditor from './LabelTextEditor'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

beforeEach(() => {
  useEditor.getState().reset()
  useEditor.getState().load(makeDoc())
  useEditor.getState().setViewport(1000, 800) // fits: scale < 1
})
afterEach(cleanup)

const input = () => screen.getByRole('textbox', { name: 'Label text' }) as HTMLInputElement

describe('LabelTextEditor', () => {
  it('starts with the primary text, Enter commits the trimmed override and closes', () => {
    const onClose = vi.fn()
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={onClose} />)
    expect(input().value).toBe('M 42')
    fireEvent.change(input(), { target: { value: '  Great Nebula  ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useEditor.getState().labels.get(1)!.text_override).toBe('Great Nebula')
    expect(useEditor.getState().undo).toHaveLength(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a blank commits null (back to the catalogue name)', () => {
    useEditor.getState().updateLabels([1], { text_override: 'Old' })
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={() => {}} />)
    expect(input().value).toBe('Old')
    fireEvent.change(input(), { target: { value: '   ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useEditor.getState().labels.get(1)!.text_override).toBeNull()
  })

  it('Escape closes without a commit', () => {
    const onClose = vi.fn()
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={onClose} />)
    fireEvent.change(input(), { target: { value: 'Nope' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(useEditor.getState().labels.get(1)!.text_override).toBeNull()
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is placed and sized through the view transform', () => {
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={() => {}} />)
    const { view } = useEditor.getState()
    const el = input()
    expect(el.style.left).toBe(`${1552 * view.scale + view.x}px`)
    expect(el.style.top).toBe(`${970 * view.scale + view.y}px`)
    expect(el.style.fontSize).toBe(`${24 * view.scale}px`)
    expect(el.style.fontFamily).toContain('Inter-Regular')
  })
})
