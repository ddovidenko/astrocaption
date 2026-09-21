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

  // #110: collapsing the panel used to unmount every body, and display:none forgets a scroll offset.
  it('keeps the bodies mounted through a collapse, so their state survives it', () => {
    const { rerender } = render(<SidePanel open onToggle={() => {}} />)
    fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: 'M 4' } })
    rerender(<SidePanel open={false} onToggle={() => {}} />)
    expect(screen.queryByRole('tab', { name: 'Objects' })).toBeNull()
    expect((screen.getByLabelText('Search objects').closest('[role=tabpanel]') as HTMLElement).hidden).toBe(true)
    rerender(<SidePanel open onToggle={() => {}} />)
    expect(screen.getByRole('tabpanel', { name: 'Objects' }).hidden).toBe(false)
    expect((screen.getByLabelText('Search objects') as HTMLInputElement).value).toBe('M 4')
  })

  it('brings a panel back at the scroll offset it was left at', () => {
    const { rerender } = render(<SidePanel open onToggle={() => {}} />)
    const panel = screen.getByRole('tabpanel', { name: 'Objects' })
    // jsdom lays nothing out, so the offset is set by hand and the scroll event carries it.
    panel.scrollTop = 120
    fireEvent.scroll(panel)
    fireEvent.click(tab('Layout'))
    panel.scrollTop = 0 // what display:none does to it in a browser
    fireEvent.click(tab('Objects'))
    expect(panel.scrollTop).toBe(120)
    rerender(<SidePanel open={false} onToggle={() => {}} />)
    panel.scrollTop = 0
    rerender(<SidePanel open onToggle={() => {}} />)
    expect(panel.scrollTop).toBe(120)
  })

  it('does not mount a tab body before its first visit', () => {
    render(<SidePanel open onToggle={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull()
    fireEvent.click(tab('Layout'))
    expect(screen.getByRole('button', { name: 'Auto-arrange' })).toBeTruthy()
  })
})
