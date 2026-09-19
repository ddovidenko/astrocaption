// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectOut } from '../api'
import ObjectsTab from './ObjectsTab'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

// The toggle runs the browser placer, which measures text on a real canvas — vitest has none,
// so the failing path is reached by making the module throw on demand.
const placer = vi.hoisted(() => ({ throws: false }))
vi.mock('./placement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./placement')>()
  return {
    ...actual,
    placeNewLabel: (...args: Parameters<typeof actual.placeNewLabel>) => {
      if (placer.throws) throw new Error('this browser could not open a canvas to measure text with')
      return actual.placeNewLabel(...args)
    },
  }
})

const hd: ObjectOut = { id: 3, catalog_names: ['HD 37742'], primary_name: 'HD 37742', type: 'hd', kind: 'star', x: 1561, y: 1011, radius: 0 }

function load(extra: ObjectOut[] = []) {
  const doc = makeDoc()
  doc.objects.push(...extra)
  for (const o of extra) {
    doc.annotations.labels.push({ ...doc.annotations.labels[1]!, object_id: o.id, x: o.x, y: o.y })
  }
  useEditor.getState().load(doc)
}

beforeEach(() => load())
afterEach(() => {
  cleanup()
  placer.throws = false
  useEditor.getState().reset()
})

const row = (name: string) => screen.getByRole('checkbox', { name: `Show ${name}` }).closest('li')!

describe('ObjectsTab', () => {
  it('lists the objects under the stored name preference and follows a Style-tab change (#94)', () => {
    render(<ObjectsTab />)
    expect(screen.getByRole('button', { name: 'M 42' })).toBeTruthy()
    act(() => useEditor.getState().setStyle({ name_preference: 'ngc_ic' }))
    expect(screen.getByRole('button', { name: 'NGC 1976' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'M 42' })).toBeNull()
  })

  it('hides hd rows until the HD toggle is on, and the star kind gates both', () => {
    load([hd])
    render(<ObjectsTab />)
    expect(screen.queryByRole('checkbox', { name: 'Show HD 37742' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'HD stars' }))
    expect(screen.getByRole('checkbox', { name: 'Show HD 37742' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stars' }))
    expect(screen.queryByRole('checkbox', { name: 'Show HD 37742' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Show Alnitak' })).toBeNull()
    expect(screen.getByText('1 of 3 objects')).toBeTruthy()
  })

  it('highlights a row and its marker on hover and on keyboard focus (#76)', () => {
    render(<ObjectsTab />)
    fireEvent.mouseEnter(row('M 42'))
    expect(useEditor.getState().hoveredId).toBe(1)
    fireEvent.mouseLeave(row('M 42'))
    expect(useEditor.getState().hoveredId).toBeNull()
    const box = screen.getByRole('checkbox', { name: 'Show Alnitak' })
    act(() => box.focus())
    expect(useEditor.getState().hoveredId).toBe(2)
    expect(row('Alnitak').className).toContain('hovered')
    act(() => box.blur())
    expect(useEditor.getState().hoveredId).toBeNull()
  })

  it('shows a dash, not 0 px, for an object nova gave no size', () => {
    render(<ObjectsTab />)
    expect(row('M 42').textContent).toContain('40 px')
    expect(row('Alnitak').textContent).toContain('—')
    expect(row('Alnitak').textContent).not.toContain('px')
  })

  it('marks the selected label’s row', () => {
    render(<ObjectsTab />)
    act(() => useEditor.getState().select(1))
    expect(row('M 42').className).toContain('selected')
    expect(row('Alnitak').className).not.toContain('selected')
  })

  it('a focused row filtered out of the list leaves no hover behind', () => {
    render(<ObjectsTab />)
    act(() => screen.getByRole('checkbox', { name: 'Show Alnitak' }).focus())
    expect(useEditor.getState().hoveredId).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Stars' })) // unmounts Alnitak's row
    expect(screen.queryByRole('checkbox', { name: 'Show Alnitak' })).toBeNull()
    expect(useEditor.getState().hoveredId).toBeNull()
  })

  it('keeps the highlight while the row holds the keyboard focus', () => {
    render(<ObjectsTab />)
    const box = screen.getByRole('checkbox', { name: 'Show Alnitak' })
    act(() => box.focus())
    fireEvent.mouseLeave(row('Alnitak')) // the pointer left, the focus did not
    expect(useEditor.getState().hoveredId).toBe(2)
    // ...and the focus moving inside the row is not a blur either.
    fireEvent.blur(box, { relatedTarget: screen.getByRole('button', { name: 'Alnitak' }) })
    expect(useEditor.getState().hoveredId).toBe(2)
    fireEvent.blur(box, { relatedTarget: null })
    expect(useEditor.getState().hoveredId).toBeNull()
  })

  it('the checkbox disables an enabled label without touching the others', () => {
    const doc = makeDoc()
    doc.annotations.labels[1]!.enabled = true
    act(() => useEditor.getState().load(doc))
    render(<ObjectsTab />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show M 42' }))
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().labels.get(2)?.enabled).toBe(true)
  })

  it('a toggle that throws says so and changes nothing', () => {
    render(<ObjectsTab />)
    placer.throws = true
    const before = useEditor.getState().labels
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Alnitak' }))
    expect(screen.getByText('The label could not be changed; nothing was altered.')).toBeTruthy()
    expect(useEditor.getState().labels).toBe(before)
    // ...and the next toggle that works takes the sentence away again.
    placer.throws = false
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show M 42' })) // disabling never measures
    expect(screen.queryByText('The label could not be changed; nothing was altered.')).toBeNull()
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
  })
})
