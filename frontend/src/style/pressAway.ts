import { useEffect, useEffectEvent, type RefObject } from 'react'

/** Calls `onAway` when the pointer goes down somewhere outside `ref`, for as long as `active`:
 *  what closes a popover or a sheet when the owner turns to something else.
 *
 *  Two events count. A mouse press, which is also what a tap sends after itself. And a touch the
 *  page cancelled: the editor canvas cancels every touch that lands on it (Konva for its shapes,
 *  the gesture layer for bare sky: SPEC § 6.5), so the browser sends no compatibility mousedown
 *  after it, and whatever was open would stay open over a selection that has moved on. Reading the
 *  cancel itself, not where the touch landed, keeps this to exactly the touches no mousedown
 *  follows; a touch that turns out to be a scroll of the panel changes nothing.
 *
 *  The listeners are wired once per activation, not once per render; `onAway` is still the one from
 *  the latest render, so a draft that changed after the thing opened is what gets committed. */
export function usePressAway(ref: RefObject<HTMLElement | null>, active: boolean, onAway: () => void): void {
  const outside = (e: Event) => ref.current !== null && e.target instanceof Node && !ref.current.contains(e.target)
  const pressed = useEffectEvent((e: MouseEvent) => {
    if (outside(e)) onAway()
  })
  const cancelledTouch = useEffectEvent((e: TouchEvent) => {
    if (e.defaultPrevented && outside(e)) onAway()
  })
  useEffect(() => {
    if (!active) return
    document.addEventListener('mousedown', pressed)
    // Passive: it only reads the event, and must not hold up the start of a scroll.
    document.addEventListener('touchstart', cancelledTouch, { passive: true })
    return () => {
      document.removeEventListener('mousedown', pressed)
      document.removeEventListener('touchstart', cancelledTouch)
    }
  }, [active])
}
