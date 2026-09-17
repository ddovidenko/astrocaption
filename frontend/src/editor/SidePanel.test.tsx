// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidePanel from './SidePanel'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, imageDefaultStyle: vi.fn() } }
})
vi.mock('./fonts', () => ({ loadBundledFont: vi.fn() }))

beforeEach(() => useEditor.getState().load(makeDoc()))
afterEach(() => {
  cleanup()
  useEditor.getState().reset()
})

const tab = (name: string) => screen.getByRole('tab', { name })

describe('SidePanel', () => {
  it('moves between tabs with the arrow keys, Home and End, focusing the new tab', () => {
    render(<SidePanel open onToggle={() => {}} />)
    tab('Objects').focus()
    fireEvent.keyDown(tab('Objects'), { key: 'ArrowRight' })
    expect(tab('Style').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Style'))
    fireEvent.keyDown(tab('Style'), { key: 'End' })
    expect(tab('Image').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Image'), { key: 'ArrowRight' })
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Objects'), { key: 'ArrowLeft' })
    expect(tab('Image').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Image'), { key: 'Home' })
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true')
  })

  it('only the current tab is in the tab order and its panel is focusable', () => {
    render(<SidePanel open onToggle={() => {}} />)
    expect(tab('Objects').tabIndex).toBe(0)
    expect(tab('Style').tabIndex).toBe(-1)
    const panel = screen.getByRole('tabpanel', { name: 'Objects' })
    expect(panel.tabIndex).toBe(0)
    expect(tab('Objects').getAttribute('aria-controls')).toBe(panel.id)
  })

  it('keeps a visited tab mounted, so its state survives a switch', () => {
    render(<SidePanel open onToggle={() => {}} />)
    fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: 'M 4' } })
    fireEvent.click(tab('Layout'))
    expect(screen.getByRole('tabpanel', { name: 'Layout' }).hidden).toBe(false)
    expect(
      (screen.getByLabelText('Search objects', { selector: 'input' }).closest('[role=tabpanel]') as HTMLElement).hidden,
    ).toBe(true)
    fireEvent.click(tab('Objects'))
    expect((screen.getByLabelText('Search objects') as HTMLInputElement).value).toBe('M 4')
  })

  it('does not mount a tab body before its first visit', () => {
    render(<SidePanel open onToggle={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull()
    fireEvent.click(tab('Layout'))
    expect(screen.getByRole('button', { name: 'Auto-arrange' })).toBeTruthy()
  })
})
