// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectOut } from '../api'
import ObjectsTab from './ObjectsTab'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

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

  it('marks the selected label’s row', () => {
    render(<ObjectsTab />)
    act(() => useEditor.getState().select(1))
    expect(row('M 42').className).toContain('selected')
    expect(row('Alnitak').className).not.toContain('selected')
  })

  it('the checkbox disables an enabled label without touching the others', () => {
    render(<ObjectsTab />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show M 42' }))
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().labels.get(2)?.enabled).toBe(false)
  })
})
