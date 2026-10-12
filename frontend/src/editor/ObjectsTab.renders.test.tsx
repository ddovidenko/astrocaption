// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectOut } from '../api'
import ObjectsTab from './ObjectsTab'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

// The render-count guard for the per-row memoisation (#111, pinning #75). `ObjectRow` is memoised
// with primitive per-row selectors so that a drag frame or a marker hover re-renders only the rows
// it concerns; a future selector that allocates (returns a fresh object or array) would silently
// re-render every row on every store change, and every other test would still pass.
//
// React's automatic JSX runtime is the one place every render of a row passes through: each
// `ObjectRow` render creates exactly one `<li className="object-row…">`. Wrapping the runtime
// records those creations, attributed to the row by its checkbox's "Show <name>" label. Vitest
// transforms JSX with the dev runtime (`jsxDEV`); the production runtime is wrapped too, so a
// change of transform cannot quietly empty the record (the first case would fail instead).
const rendered = vi.hoisted(() => ({ rows: [] as string[] }))

type JsxFn = (type: unknown, props: unknown, ...rest: unknown[]) => unknown
type ElementLike = { props?: Record<string, unknown> }

function recording<T extends JsxFn>(original: T): T {
  return ((type: unknown, props: unknown, ...rest: unknown[]) => {
    if (type === 'li' && typeof props === 'object' && props !== null) {
      const p = props as { className?: unknown; children?: unknown }
      if (typeof p.className === 'string' && p.className.startsWith('object-row')) {
        const children = Array.isArray(p.children) ? (p.children as ElementLike[]) : [p.children as ElementLike]
        const checkbox = children.find((c) => typeof c?.props?.['aria-label'] === 'string')
        const label = checkbox ? (checkbox.props!['aria-label'] as string) : '?'
        rendered.rows.push(label.replace(/^Show /, ''))
      }
    }
    return original(type, props, ...rest)
  }) as T
}

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...actual, jsxDEV: recording(actual.jsxDEV as JsxFn) }
})
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-runtime')>()
  return { ...actual, jsx: recording(actual.jsx as JsxFn), jsxs: recording(actual.jsxs as JsxFn) }
})

// A third row, so "only one row" is distinguishable from "all but one".
const rigel: ObjectOut = { id: 3, catalog_names: ['Rigel'], primary_name: 'Rigel', type: 'bright', kind: 'star', x: 700, y: 1500, radius: 0 }

/** The rows rendered since the last call, in name order. */
function rowsRendered(): string[] {
  const out = [...rendered.rows].sort()
  rendered.rows.length = 0
  return out
}

beforeEach(() => {
  const doc = makeDoc()
  doc.objects.push(rigel)
  doc.annotations.labels.push({ ...doc.annotations.labels[1]!, object_id: rigel.id, x: rigel.x, y: rigel.y })
  useEditor.getState().load(doc)
  render(<ObjectsTab />)
})
afterEach(() => {
  cleanup()
  rendered.rows.length = 0
  useEditor.getState().reset()
  localStorage.clear()
})

describe('ObjectsTab row renders (#111)', () => {
  it('the first render lists every row exactly once', () => {
    // Also the guard on the guard: an empty record would mean the JSX runtime moved.
    expect(rowsRendered()).toEqual(['Alnitak', 'M 42', 'Rigel'])
  })

  it('a drag frame re-renders only the moved label’s row', () => {
    rowsRendered()
    const one = useEditor.getState().labels.get(1)!
    act(() => useEditor.getState().moveLabel(1, one.x + 5, one.y + 7, false))
    expect(rowsRendered()).toEqual(['M 42'])
    act(() => useEditor.getState().moveLabel(1, one.x + 10, one.y + 14))
    expect(rowsRendered()).toEqual(['M 42'])
  })

  it('a marker hover re-renders the row it lights and the row it leaves', () => {
    rowsRendered()
    act(() => useEditor.getState().hover(2))
    expect(rowsRendered()).toEqual(['Alnitak'])
    act(() => useEditor.getState().hover(1))
    expect(rowsRendered()).toEqual(['Alnitak', 'M 42'])
    act(() => useEditor.getState().hover(null))
    expect(rowsRendered()).toEqual(['M 42'])
  })

  it('selecting re-renders the selected row only; a pan re-renders none', () => {
    rowsRendered()
    act(() => useEditor.getState().select(1))
    expect(rowsRendered()).toEqual(['M 42'])
    act(() => useEditor.getState().setView({ scale: 2, x: -100, y: -50 }))
    expect(rowsRendered()).toEqual([])
  })

  it('enabling a label re-renders its row only, although the list itself recomputes', () => {
    rowsRendered()
    // The parent re-renders here (the enabled set changed), so this also pins that the props it
    // hands each row are stable: `setError` for onError, the same object and name.
    act(() => useEditor.getState().toggleObject(2, { x: 100, y: 100 }))
    expect(rowsRendered()).toEqual(['Alnitak'])
  })
})
