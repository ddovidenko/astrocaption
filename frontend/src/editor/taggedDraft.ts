import { useState } from 'react'

/** A draft value tagged with what it was raised for.
 *
 *  Three places in the editor hold a value that belongs to one selection and one stored value: the
 *  toolbar's size field, its colour picker, and the canvas's toolbar-error notice. All three must
 *  disappear the moment either moves on — a stale draft would show over a different label, and an
 *  undo that restores the value the draft was typed against must not revive it. Resetting them
 *  from an effect is out (`react-hooks/set-state-in-effect` is an error, and it would paint the
 *  stale value for a frame), so the draft carries its tag instead and is simply *derived away*
 *  during render when the tag no longer matches.
 *
 *  The tag alone cannot do all of it: an undo that puts the stored value back where the draft
 *  started would match the tag again and revive a draft already spent. So every path that acts on
 *  the draft drops it explicitly (`drop`).
 *
 *  Returns `[draft, set, drop]`, where `draft` is null whenever there is nothing live for the
 *  current tag. `set` tags with the tag of the render it was called from, which is the one the
 *  owner was looking at.
 */
export function useTaggedDraft<T>(tag: readonly unknown[]): [T | null, (value: T) => void, () => void] {
  const [held, setHeld] = useState<{ tag: readonly unknown[]; value: T } | null>(null)
  const live = held !== null && held.tag.length === tag.length && held.tag.every((t, i) => Object.is(t, tag[i]))
  return [live ? held.value : null, (value: T) => setHeld({ tag, value }), () => setHeld(null)]
}
