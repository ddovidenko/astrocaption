// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPACT_QUERY, useCompactEditor } from './compact'

// jsdom has no matchMedia, which is the first case; the others install a stand-in for one media
// query list whose `matches` the test flips, as a browser does when a window is resized.
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  const list = {
    matches,
    addEventListener: vi.fn((_type: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_type: string, fn: () => void) => listeners.delete(fn)),
  }
  const matchMedia = vi.fn(() => list)
  vi.stubGlobal('matchMedia', matchMedia)
  return {
    list,
    matchMedia,
    flip(next: boolean) {
      list.matches = next
      act(() => listeners.forEach((fn) => fn()))
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useCompactEditor', () => {
  it('is false where matchMedia does not exist', () => {
    expect(typeof window.matchMedia).not.toBe('function')
    expect(renderHook(() => useCompactEditor()).result.current).toBe(false)
  })

  it('reads the coarse-pointer-or-phone-width query', () => {
    const { matchMedia } = stubMatchMedia(true)
    expect(renderHook(() => useCompactEditor()).result.current).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith(COMPACT_QUERY)
    expect(COMPACT_QUERY).toBe('(pointer: coarse), (max-width: 640px)')
  })

  it('follows the query when it flips', () => {
    const media = stubMatchMedia(true)
    const { result } = renderHook(() => useCompactEditor())
    media.flip(false)
    expect(result.current).toBe(false)
    media.flip(true)
    expect(result.current).toBe(true)
  })

  it('stops listening on unmount', () => {
    const { list } = stubMatchMedia(false)
    const { unmount } = renderHook(() => useCompactEditor())
    expect(list.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    const listener = list.addEventListener.mock.calls[0]![1]
    unmount()
    expect(list.removeEventListener).toHaveBeenCalledWith('change', listener)
  })
})
