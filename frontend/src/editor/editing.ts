// The editing actions the canvas and the side panel share (design § 5): whether the document may
// be edited at all, the one offscreen measuring context, and toggling a label on with a placement.

import { canvasMeasurer, type TextMeasurer } from './metrics'
import { placeNewLabel } from './placement'
import { isEditable, useEditor } from './store'
export { isEditable } from './store'

let measurer: TextMeasurer | null = null

/** One offscreen 2D context for every width the editor measures (design § 3), built on first use:
 *  the placer needs it outside the canvas component too, and a second context would be a second
 *  set of font state to keep in step. */
export function getMeasurer(): TextMeasurer {
  if (!measurer) {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) throw new Error('This browser could not open a canvas to measure text with.')
    measurer = canvasMeasurer(ctx)
  }
  return measurer
}

/** Toggles the label for `id`, placing it when it is being enabled for the first time.
 *
 *  A label still sitting exactly on its object (how the server stores a never-placed one) gets the
 *  placer's anchor search against the currently enabled boxes, so it appears somewhere legible at
 *  once. A label that was placed before — by the auto-arrange or by a drag — keeps its position, so
 *  disabling and re-enabling restores it. `measure` is injectable for tests (vitest has no canvas).
 */
export function toggleWithPlacement(id: number, measure?: TextMeasurer): void {
  const state = useEditor.getState()
  if (!isEditable(state)) return
  const label = state.labels.get(id)
  const obj = state.objects.get(id)
  if (!label || !obj) return
  if (label.enabled) {
    state.toggleObject(id)
    return
  }
  if (label.x !== obj.x || label.y !== obj.y) {
    state.toggleObject(id)
    return
  }
  state.toggleObject(id, placeNewLabel(state, measure ?? getMeasurer(), id) ?? undefined)
}
