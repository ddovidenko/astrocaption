// The editing actions the canvas and the side panel share (design § 5): whether the document may
// be edited at all, the one offscreen measuring context, and toggling a label on with a placement.

import type { Label, ObjectOut } from '../api'
import { canvasMeasurer, type TextMeasurer } from './metrics'
import { placeNewLabel, placeNewLabels } from './placement'
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
  if (!isUnplaced(label, obj)) {
    state.toggleObject(id)
    return
  }
  state.toggleObject(id, placeNewLabel(state, measure ?? getMeasurer(), id) ?? undefined)
}

/** A label still sitting exactly on its object: how the server stores one that was never placed. */
function isUnplaced(label: Label, obj: ObjectOut): boolean {
  return label.x === obj.x && label.y === obj.y
}

/** "Enable shown": every disabled id in `ids` is enabled in one store change. Labels never
 *  moved off their object are placed, each around the ones placed before it and around the
 *  batch's other labels that keep a stored position (a previous drag, then disabled) — SPEC
 *  § 6.3 — so the whole batch is one undo entry and a measurement that throws leaves the
 *  document untouched. The placer sees the batch as already enabled: a working copy of the
 *  labels map, never the store, until `applyLabels` commits the result. */
export function enableWithPlacement(ids: number[], measure?: TextMeasurer): void {
  const state = useEditor.getState()
  if (!isEditable(state)) return
  const toPlace: number[] = []
  const enabled = new Map(state.labels)
  let changed = 0
  for (const id of ids) {
    const label = state.labels.get(id)
    const obj = state.objects.get(id)
    if (!label || !obj || label.enabled) continue
    enabled.set(id, { ...label, enabled: true, collided: false })
    changed++
    if (isUnplaced(label, obj)) toPlace.push(id)
  }
  if (changed === 0) return
  const placed = placeNewLabels({ ...state, labels: enabled }, measure ?? getMeasurer(), toPlace)
  const updated: Label[] = []
  for (const id of ids) {
    const label = enabled.get(id)
    if (!label || label === state.labels.get(id)) continue
    const p = placed.get(id)
    updated.push(p ? { ...label, x: p.x, y: p.y, collided: p.collided } : label)
  }
  if (updated.length > 0) state.applyLabels(updated)
}

/** "Disable shown": every enabled id in `ids` is disabled in one store change; positions stay. */
export function disableAll(ids: number[]): void {
  const state = useEditor.getState()
  if (!isEditable(state)) return
  const updated: Label[] = []
  for (const id of ids) {
    const label = state.labels.get(id)
    if (label?.enabled) updated.push({ ...label, enabled: false })
  }
  if (updated.length > 0) state.applyLabels(updated)
}
