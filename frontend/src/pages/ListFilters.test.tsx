// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_MAX_LENGTH } from '../api'
import ListFilters, { SEARCH_DEBOUNCE_MS } from './ListFilters'
import { EMPTY_QUERY, type ListQuery } from './listQuery'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('ListFilters', () => {
  it('reports the typed text once the typing pauses', () => {
    const onChange = vi.fn()
    render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' })
    fireEvent.change(box, { target: { value: 'm 2' } })
    fireEvent.change(box, { target: { value: 'm 27' } })
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ q: 'm 27' })
  })

  it('shows the chips to the owner only, one pressed per group, and a second press clears it', () => {
    // Each press reports a patch; the page merges it onto the URL as it is then.
    const onChange = vi.fn()
    const query: ListQuery = { ...EMPTY_QUERY, status: 'failed' }
    const { rerender } = render(<ListFilters query={query} onChange={onChange} owner label="Search images" />)
    expect(pressed('Failed')).toBe('true')
    expect(pressed('Solved')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    expect(onChange).toHaveBeenLastCalledWith({ status: 'solved' })
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }))
    expect(onChange).toHaveBeenLastCalledWith({ status: null })
    fireEvent.click(screen.getByRole('button', { name: 'Unpublished' }))
    expect(onChange).toHaveBeenLastCalledWith({ published: false })

    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    expect(screen.queryByRole('button', { name: 'Failed' })).toBeNull()
  })

  it('offers Clear only while something is set, and Clear empties the box too', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    rerender(<ListFilters query={{ ...EMPTY_QUERY, q: 'veil' }} onChange={onChange} label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' }) as HTMLInputElement
    expect(box.value).toBe('veil')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_QUERY)
    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    expect(box.value).toBe('')
  })

  it('Clear inside the typing pause drops the pending search and empties the box', () => {
    const onChange = vi.fn()
    const query: ListQuery = { ...EMPTY_QUERY, status: 'solved' }
    render(<ListFilters query={query} onChange={onChange} owner label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' }) as HTMLInputElement
    fireEvent.change(box, { target: { value: 'm3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(box.value).toBe('')
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(EMPTY_QUERY)
  })

  it('caps the box at the length the server accepts, so typing alone can never be refused', () => {
    render(<ListFilters query={EMPTY_QUERY} onChange={() => {}} label="Search images" />)
    expect(screen.getByRole('searchbox', { name: 'Search images' }).getAttribute('maxlength')).toBe(String(SEARCH_MAX_LENGTH))
  })

  it('follows a query changed from outside (back button) without echoing it back', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    rerender(<ListFilters query={{ ...EMPTY_QUERY, q: 'orion' }} onChange={onChange} label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' }) as HTMLInputElement
    expect(box.value).toBe('orion')
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers the kind chips to everyone, one pressed at most, and a second press clears it', () => {
    const onChange = vi.fn()
    const query: ListQuery = { ...EMPTY_QUERY, kind: 'nebula' }
    render(<ListFilters query={query} onChange={onChange} label="Search the gallery" />)
    expect(pressed('Nebulae')).toBe('true')
    expect(pressed('Galaxies')).toBe('false')
    expect(screen.getByRole('group', { name: 'Object kind' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Galaxies' }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'galaxy' })
    fireEvent.click(screen.getByRole('button', { name: 'Nebulae' }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: null })
  })

  it('reports a chosen day after the typing pause and follows one set from outside', () => {
    // Keyboard entry of a date emits a complete value per digit of the year (0002-, 0020-, ...),
    // each of which would be a list request if the dates reported at once as the chips do.
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    const from = screen.getByLabelText('From') as HTMLInputElement
    const to = screen.getByLabelText('To') as HTMLInputElement
    expect(from.type).toBe('date')
    fireEvent.change(from, { target: { value: '0202-10-01' } })
    fireEvent.change(from, { target: { value: '2026-10-01' } })
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ since: '2026-10-01' })
    fireEvent.change(to, { target: { value: '2026-10-31' } })
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenLastCalledWith({ until: '2026-10-31' })
    // The URL now carries both; a later URL without `until` (back button) empties that box.
    rerender(<ListFilters query={{ ...EMPTY_QUERY, since: '2026-09-01', until: '2026-10-31' }} onChange={onChange} label="Search the gallery" />)
    expect(from.value).toBe('2026-09-01')
    expect(to.value).toBe('2026-10-31')
    rerender(<ListFilters query={{ ...EMPTY_QUERY, since: '2026-09-01' }} onChange={onChange} label="Search the gallery" />)
    expect(to.value).toBe('')
  })

  it('a cleared or half-typed date drops that bound', () => {
    // Chromium reports '' while a date is being typed; that is "no bound" until it is complete.
    const onChange = vi.fn()
    render(<ListFilters query={{ ...EMPTY_QUERY, since: '2026-10-01' }} onChange={onChange} label="Search the gallery" />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } })
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenLastCalledWith({ since: null })
  })

  it('a day the URL cannot carry (a five-digit year) is reported as no bound', () => {
    // The picker accepts years past 9999; the URL reader would drop such a value and the sync
    // effect would then wipe the box without a word, so it never reaches the URL.
    const onChange = vi.fn()
    render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '20260-01-01' } })
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenLastCalledWith({ since: null })
  })

  it('a search and a date inside one pause land as a single patch', () => {
    const onChange = vi.fn()
    render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the gallery' }), { target: { value: 'm3' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ q: 'm3', since: '2026-10-01' })
  })

  it('Clear empties a date the query never received, as it does the box', () => {
    // A date whose change has not reached the URL (or a half-typed one, which reads as '' but
    // still shows its digits) stays in the picker unless Clear resets the DOM itself.
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={{ ...EMPTY_QUERY, kind: 'star' }} onChange={onChange} label="Search the gallery" />)
    const from = screen.getByLabelText('From') as HTMLInputElement
    fireEvent.change(from, { target: { value: '2026-10-05' } })
    expect(from.value).toBe('2026-10-05')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    expect(from.value).toBe('')
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_QUERY)
  })

  it('Clear empties the dates with the rest', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ListFilters query={{ ...EMPTY_QUERY, kind: 'star', since: '2026-10-01', until: '2026-10-31' }} onChange={onChange} label="Search the gallery" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_QUERY)
    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('')
    expect(pressed('Stars')).toBe('false')
  })
})
