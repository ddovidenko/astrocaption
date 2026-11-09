import { useSyncExternalStore } from 'react'

/** A *compact* editor (SPEC § 6.5): a touch-first device at any width, or any window as narrow as
 *  a phone (the width at which the side panel already starts closed). It decides layout and target
 *  sizes only; which gesture rules apply is decided per event, touch or mouse. */
export const COMPACT_QUERY = '(pointer: coarse), (max-width: 640px)'

function query(): MediaQueryList | null {
  // jsdom has no matchMedia: component tests see the desktop layout.
  return typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null
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
