// Deterministic label auto-placement (SPEC § 6.4). Line-by-line port of
// backend/app/placement.py: pure geometry, no font dependency, and the shared vectors in
// tests/fixtures/placement/ pin this module and the Python original to identical output
// (CLAUDE.md hard rule: preview and export must produce the same layout).
//
// All coordinates are original-image pixels. `s = max(W, H) / 1000` is the scale unit.
// A larger object's marker only blocks its ring line: labels may sit inside a big nebula's
// circle, they just must not cross the drawn outline. An object whose own circle spills past
// the frame (M 31 filling the field) is labelled at its centre, as if it were a point.
import {
  ANCHORS,
  anchorBox,
  markerRadius,
  measureLabel,
  scaleUnit,
  type Box,
  type Circle,
  type TextMeasurer,
} from './metrics'
import { enabledLabels, type EditorState } from './store'

/** Defined in metrics.ts (this module imports it, so the shared type lives there). */
export type { Circle }

export const GAP_FACTOR = 6.0
export const PAD_FACTOR = 4.0
export const RING_STEP_FACTOR = 40.0
export const MAX_RINGS = 4

/** An enabled label to place: marker centre, marker radius and text box size. */
export interface PlacementItem {
  id: number
  x: number
  y: number
  radius: number
  w: number
  h: number
}

export interface Placement {
  id: number
  x: number
  y: number
  collided: boolean
}

export function boxesOverlap(a: Box, b: Box, pad: number): boolean {
  return a.left < b.right + pad && b.left < a.right + pad && a.top < b.bottom + pad && b.top < a.bottom + pad
}

/** True when the circle's outline passes through `box` (inflated by `pad`).
 *
 *  A box entirely inside a large marker (e.g. a star label inside M 42's circle) or entirely
 *  outside it is fine; sitting on the drawn ring is not. */
export function boxCrossesRing(box: Box, c: Circle, pad: number): boolean {
  const nx = Math.min(Math.max(c.x, box.left), box.right)
  const ny = Math.min(Math.max(c.y, box.top), box.bottom)
  const nearest = Math.hypot(c.x - nx, c.y - ny)
  const fx = Math.abs(c.x - box.left) > Math.abs(c.x - box.right) ? box.left : box.right
  const fy = Math.abs(c.y - box.top) > Math.abs(c.y - box.bottom) ? box.top : box.bottom
  const farthest = Math.hypot(c.x - fx, c.y - fy)
  return nearest < c.r + pad && farthest > c.r - pad
}

export function boxInside(box: Box, width: number, height: number): boolean {
  return box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height
}

export function ringInsideFrame(it: PlacementItem, width: number, height: number): boolean {
  return it.radius <= Math.min(it.x, it.y, width - it.x, height - it.y)
}

/** First anchor (ring by ring) whose box fits the frame and clears every obstacle. */
function search(
  it: PlacementItem,
  radius: number,
  width: number,
  height: number,
  gap: number,
  pad: number,
  step: number,
  accepted: readonly Box[],
  markers: readonly Circle[],
): Box | null {
  for (let ring = 0; ring <= MAX_RINGS; ring++) {
    const offset = radius + gap + ring * step
    for (const anchor of ANCHORS) {
      const box = anchorBox(anchor, it.x, it.y, offset, it.w, it.h)
      if (!boxInside(box, width, height)) continue
      if (accepted.some((other) => boxesOverlap(box, other, pad))) continue
      if (markers.some((c) => boxCrossesRing(box, c, pad))) continue
      return box
    }
  }
  return null
}

/** Place every item; returns placements in the same order as `items`.
 *
 *  `fixedBoxes` / `fixedCircles` are obstacles that are never moved (labels the owner already
 *  positioned, and their markers), used when re-solving. */
export function placeLabels(
  width: number,
  height: number,
  items: PlacementItem[],
  fixedBoxes: Box[] = [],
  fixedCircles: Circle[] = [],
): Placement[] {
  const s = scaleUnit(width, height)
  const gap = GAP_FACTOR * s
  const pad = PAD_FACTOR * s
  const step = RING_STEP_FACTOR * s

  const order = [...items].sort((a, b) => b.radius - a.radius || a.id - b.id)
  const accepted: Box[] = [...fixedBoxes]
  const markers: Circle[] = [...fixedCircles]
  const result = new Map<number, Placement>()

  for (const it of order) {
    let chosen = search(it, it.radius, width, height, gap, pad, step, accepted, markers)
    if (chosen === null && !ringInsideFrame(it, width, height)) {
      // The catalogue circle spills past the frame, so no slot exists outside it.
      // Label the centre instead: a box inside a big marker is fine, only the ring
      // line is protected, and the renderer draws no leader for it.
      chosen = search(it, 0.0, width, height, gap, pad, step, accepted, markers)
    }
    const collided = chosen === null
    if (chosen === null) {
      chosen = anchorBox('right', it.x, it.y, it.radius + gap, it.w, it.h)
    }
    accepted.push(chosen)
    markers.push({ x: it.x, y: it.y, r: it.radius })
    result.set(it.id, { id: it.id, x: chosen.left, y: chosen.top, collided })
  }

  return items.map((it) => result.get(it.id)!)
}

/** A placed label as the obstacle the next placement must avoid: its text box and its marker. */
function obstacle(x: number, y: number, w: number, h: number, c: Circle): { box: Box; circle: Circle } {
  return { box: { left: x, top: y, right: x + w, bottom: y + h }, circle: c }
}

/** Places the labels for `ids`, in that order, each against every other enabled label's box and
 *  marker *and* the ids placed before it in this call: what "Enable shown" needs so the whole
 *  batch is one change. Every enabled label in `state` that is not itself being placed is an
 *  obstacle at its stored position, so a caller that wants a batch to block one another hands in
 *  a state where the batch is already enabled. Ids without an object or a label are skipped. */
export function placeNewLabels(
  state: EditorState,
  measure: TextMeasurer,
  ids: number[],
): Map<number, { x: number; y: number; collided: boolean }> {
  const out = new Map<number, { x: number; y: number; collided: boolean }>()
  const { image, style } = state
  if (!image || !style) return out
  const wanted = new Set(ids)
  const fixedBoxes: Box[] = []
  const fixedCircles: Circle[] = []
  const block = (o: { box: Box; circle: Circle }) => {
    fixedBoxes.push(o.box)
    fixedCircles.push(o.circle)
  }
  for (const other of enabledLabels(state)) {
    if (wanted.has(other.object_id)) continue
    const o = state.objects.get(other.object_id)
    if (!o) continue
    const b = measureLabel(measure, style, other, o)
    block(obstacle(other.x, other.y, b.width, b.height, { x: o.x, y: o.y, r: markerRadius(o, style) }))
  }
  for (const id of ids) {
    const obj = state.objects.get(id)
    const label = state.labels.get(id)
    if (!obj || !label) continue
    const box = measureLabel(measure, style, label, obj)
    const circle = { x: obj.x, y: obj.y, r: markerRadius(obj, style) }
    const [p] = placeLabels(
      image.width,
      image.height,
      [{ id, x: obj.x, y: obj.y, radius: circle.r, w: box.width, h: box.height }],
      fixedBoxes,
      fixedCircles,
    )
    if (!p) continue
    out.set(id, { x: p.x, y: p.y, collided: p.collided })
    block(obstacle(p.x, p.y, box.width, box.height, circle))
  }
  return out
}

/** The object's label measured with the current style, placed against every other enabled
 *  label's box and marker. Throws for an id the document does not hold — unreachable from the
 *  toggle path, which checks first, so a miss is a bug and must not enable the label unplaced. */
export function placeNewLabel(
  state: EditorState,
  measure: TextMeasurer,
  id: number,
): { x: number; y: number; collided: boolean } {
  const placed = placeNewLabels(state, measure, [id]).get(id)
  if (!placed) throw new Error(`placeNewLabel: object ${id} has no label to place`)
  return placed
}
