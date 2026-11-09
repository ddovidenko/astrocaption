import { useSyncExternalStore } from 'react'

/** A *compact* editor (SPEC § 6.5): a touch-first device at any width, or any window as narrow as
 *  a phone (the width at which the side panel already starts closed). It decides layout and target
 *  sizes only; which gesture rules apply is decided per event, touch or mouse. */
export const PHONE_WIDTH_QUERY = '(max-width: 640px)'
export const COMPACT_QUERY = `(pointer: coarse), ${PHONE_WIDTH_QUERY}`

// One list for the life of the page: the snapshot below is read on every render of the canvas,
// which is every frame of a pan. Keyed on the function it came from, so a test that swaps
// `matchMedia` gets a list of its own.
let cached: { from: typeof window.matchMedia; list: MediaQueryList } | null = null

function query(): MediaQueryList | null {
  const from = window.matchMedia
  // jsdom has no matchMedia: component tests see the desktop layout.
  if (typeof from !== 'function') return null
  if (cached?.from !== from) cached = { from, list: window.matchMedia(COMPACT_QUERY) }
  return cached.list
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  if (!list) return () => {}
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Whether the editor is compact right now; re-renders when a resize or a newly attached mouse
 *  flips it. */
export function useCompactEditor(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false)
}
