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
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_QUERY, q: 'm 27' })
  })

  it('shows the chips to the owner only, one pressed per group, and a second press clears it', () => {
    const onChange = vi.fn()
    const query: ListQuery = { q: '', status: 'failed', published: null }
    const { rerender } = render(<ListFilters query={query} onChange={onChange} owner label="Search images" />)
    expect(pressed('Failed')).toBe('true')
    expect(pressed('Solved')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...query, status: 'solved' })
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...query, status: null })
    fireEvent.click(screen.getByRole('button', { name: 'Unpublished' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...query, published: false })

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

  it('keeps a chip pressed inside the typing pause: the search lands on the latest query', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} owner label="Search images" />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'veil' } })
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_QUERY, status: 'solved' })
    rerender(<ListFilters query={{ ...EMPTY_QUERY, status: 'solved' }} onChange={onChange} owner label="Search images" />)
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenLastCalledWith({ q: 'veil', status: 'solved', published: null })
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
})
