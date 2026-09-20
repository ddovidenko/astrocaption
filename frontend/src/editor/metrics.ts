// Layout arithmetic shared by the canvas (milestone-3 PR 4) and the tests. Mirrors
// backend/app/render.py and placement.anchor_box; tests/fixtures/render/vectors.json pins both
// sides (CLAUDE.md hard rule: preview and export must produce the same layout). Every number the
// canvas draws with comes from here.
//
// Font inputs come only from GET /annotations (the style's font_file) and GET /fonts (the ascent
// table), never from the image record, the config defaults or a cached document (#62): the
// server resolves a font that is no longer bundled to the default, and the browser must draw
// with the same one. A /fonts/<file> 404 would fall back to a system font silently.
import type { FontOut, Label, ObjectOut, StyleConfig } from '../api'
import { aliasNames, primaryName } from './names'

export const MIN_FONT_SIZE = 6
export const MAX_FONT_SIZE = 200
export const ALIAS_SCALE = 0.7
export const LINE_HEIGHT = 1.2
export const ALIAS_SEP = ' · '
/** Auto leaders appear when the box is farther than 12·s from the marker edge, s = max(W, H) / 1000. */
export const LEADER_GAP_FACTOR = 12
const SQRT_HALF = Math.sqrt(0.5)

/** Python's round(): halves go to the even neighbour (15 × 0.7 = 10.5 → 10), unlike Math.round. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

export function effectiveFontSize(label: Label, style: StyleConfig): number {
  return label.font_size ?? style.font_size
}

export function aliasFontSize(size: number): number {
  return Math.max(MIN_FONT_SIZE, roundHalfEven(size * ALIAS_SCALE))
}

export function lineHeight(size: number): number {
  return Math.ceil(size * LINE_HEIGHT)
}

export function scaleUnit(width: number, height: number): number {
  return Math.max(width, height) / 1000
}

export function markerRadius(obj: ObjectOut, style: StyleConfig): number {
  return Math.max(obj.radius, style.marker_min_radius)
}

/** The drawn ring: what the placer keeps text boxes off and a leader routes around. */
export function markerRing(obj: ObjectOut, style: StyleConfig): Circle {
  return { x: obj.x, y: obj.y, r: markerRadius(obj, style) }
}

/** The radius to give a centred canvas stroke so the ring lands where Pillow puts it: Pillow's
 *  `ImageDraw.ellipse(..., width=w)` grows the outline INWARD from the bounding box (the ring
 *  occupies radii r−w…r) while Konva centres the stroke on the radius, so the stroke has to sit
 *  half a width inside the geometric radius. The geometric radius (`markerRadius`) still drives
 *  leader starts, the hover ring and hit-testing. */
export function markerStrokeRadius(obj: ObjectOut, style: StyleConfig): number {
  return Math.max(0, markerRadius(obj, style) - style.marker_width / 2)
}

/** Pillow's ascent at `size`: the baseline sits that far below the label's top edge (`y`). */
export function ascentFor(font: FontOut, size: number): number {
  const ascent = font.ascents[size - MIN_FONT_SIZE]
  if (ascent === undefined) throw new RangeError(`no ascent for ${font.file} at ${size}px`)
  return ascent
}

export interface LabelLines {
  primary: string
  alias: string | null
}

/** Both lines from the object's raw names and the *store's* style (names.ts): a preference or
 *  cap change re-measures at once, and the export builds the same lines from the same rules
 *  (#64). `obj.primary_name` is the server's ranking at fetch time, used by the plain export
 *  page only. */
export function labelText(obj: ObjectOut, label: Label, style: StyleConfig): LabelLines {
  const override = (label.text_override ?? '').trim()
  const primary = override || primaryName(obj.catalog_names, style.name_preference)
  const show = label.show_aliases ?? style.show_aliases
  const aliases = show ? aliasNames(obj.catalog_names, style.name_preference, style.max_aliases) : []
  return { primary, alias: aliases.length > 0 ? aliases.join(ALIAS_SEP) : null }
}

/** The CSS family name for a bundled font file: its stem, so browser and export name the same file. */
export function fontFamilyFor(file: string): string {
  return file.replace(/\.ttf$/i, '')
}

/** The canvas `font` shorthand for `file` at `size`, shared by the measurer and the paint shape
 *  so the two can never build different strings. */
export function fontShorthand(size: number, file: string): string {
  return `${size}px "${fontFamilyFor(file)}"`
}

/** Advance width of `text` set in `fontFile` at `size` px, in original-image pixels. */
export type TextMeasurer = (text: string, fontFile: string, size: number) => number

/** The canvas measurer. `geometricPrecision` turns hinting off so widths agree with Pillow's
 *  getlength within 0.5 px at every size (design § 1); default canvas text rounds to whole
 *  pixels and drifts up to 27 % at small sizes. The font must be loaded (FontFace) first.
 *  The font's FontFace must already be loaded: `measureText` on an unloaded family silently uses
 *  a fallback font, and `document.fonts.check()` cannot detect that (it returns true for an
 *  unregistered family), so the editor awaits `document.fonts.load()` before its first draw. */
export function canvasMeasurer(ctx: CanvasRenderingContext2D): TextMeasurer {
  if (!('textRendering' in CanvasRenderingContext2D.prototype)) {
    throw new Error('this browser cannot measure text the way the export does (no canvas textRendering)')
  }
  return (text, fontFile, size) => {
    ctx.textRendering = 'geometricPrecision' // per call: a ctx.restore() would otherwise reset it
    ctx.font = fontShorthand(size, fontFile)
    return ctx.measureText(text).width
  }
}

export interface LabelBox {
  width: number
  height: number
  primarySize: number
  aliasSize: number
  line1Height: number
  line2Height: number
}

export function measureLabel(measure: TextMeasurer, style: StyleConfig, label: Label, obj: ObjectOut): LabelBox {
  const text = labelText(obj, label, style)
  const size = effectiveFontSize(label, style)
  const aliasSize = aliasFontSize(size)
  let width = measure(text.primary, style.font_file, size)
  const line1Height = lineHeight(size)
  let line2Height = 0
  if (text.alias !== null) {
    width = Math.max(width, measure(text.alias, style.font_file, aliasSize))
    line2Height = lineHeight(aliasSize)
  }
  return {
    width: Math.ceil(width),
    height: line1Height + line2Height,
    primarySize: size,
    aliasSize,
    line1Height,
    line2Height,
  }
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Circle {
  x: number
  y: number
  r: number
}

export interface LeaderSegment {
  from: [number, number]
  to: [number, number]
  gap: number
}

/** True when the circle's outline passes through `box` (inflated by `pad`). Mirrors
 *  placement.box_crosses_ring; it lives here rather than in placement.ts because that module
 *  imports this one and `routeLeader` needs it.
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

/** Whether the segment a–b cuts the ring's outline (inflated by `pad`). The counterpart of
 *  placement's `boxCrossesRing`, kept here rather than in placement.ts because placement.ts
 *  imports this module. Mirrors placement.segment_crosses_ring: squared distances only, since
 *  Math.hypot and Python's hypot are not bit-identical and a value on the threshold must fall
 *  on the same side in both renderers. */
export function segmentCrossesRing(a: [number, number], b: [number, number], c: Circle, pad: number): boolean {
  const ax = a[0] - c.x
  const ay = a[1] - c.y
  const bx = b[0] - c.x
  const by = b[1] - c.y
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq))
  const px = ax + t * dx
  const py = ay + t * dy
  const nearestSq = px * px + py * py
  const farthestSq = Math.max(ax * ax + ay * ay, bx * bx + by * by)
  const outer = c.r + pad
  const inner = c.r - pad
  return nearestSq < outer * outer && (inner <= 0 || farthestSq > inner * inner)
}

/** Segment from the marker edge towards (px, py) and the gap between them; null when the point
 *  lies within the marker. Mirrors render._leader_to. */
function leaderTo(cx: number, cy: number, r: number, px: number, py: number): LeaderSegment | null {
  const dx = px - cx
  const dy = py - cy
  const dist = Math.hypot(dx, dy)
  if (dist <= r) return null
  return { from: [cx + (dx / dist) * r, cy + (dy / dist) * r], to: [px, py], gap: dist - r }
}

/** From the marker edge to the closest point of `box`, or null when the box reaches the marker.
 *  Its gap alone decides an `auto` leader (`leaderVisible`). */
export function leaderSegment(cx: number, cy: number, r: number, box: Box): LeaderSegment | null {
  const nx = Math.min(Math.max(cx, box.left), box.right)
  const ny = Math.min(Math.max(cy, box.top), box.bottom)
  return leaderTo(cx, cy, r, nx, ny)
}

/** Alternative leader endpoints, in preference order: the edge midpoints (top, right, bottom,
 *  left), then the corners (top-left, top-right, bottom-right, bottom-left), of the faces that
 *  face the marker; a segment to the far side would cross the text. */
function facingCandidates(cx: number, cy: number, box: Box): [number, number][] {
  const mx = (box.left + box.right) / 2
  const my = (box.top + box.bottom) / 2
  const above = cy < box.top
  const right = cx > box.right
  const below = cy > box.bottom
  const left = cx < box.left
  const faces: [boolean, [number, number]][] = [
    [above, [mx, box.top]],
    [right, [box.right, my]],
    [below, [mx, box.bottom]],
    [left, [box.left, my]],
    [above || left, [box.left, box.top]],
    [above || right, [box.right, box.top]],
    [below || right, [box.right, box.bottom]],
    [below || left, [box.left, box.bottom]],
  ]
  return faces.filter(([visible]) => visible).map(([, point]) => point)
}

export interface RoutedLeader {
  from: [number, number]
  to: [number, number]
}

/** The leader to draw (#14): `seg` (the `leaderSegment` to the nearest point) unless it crosses
 *  one of the `obstacles` rings, then the first of `facingCandidates` whose segment crosses
 *  none, and `seg` again when every candidate does; a ring whose outline runs through the box
 *  itself never blocks. Mirrors render.route_leader. */
export function routeLeader(
  seg: LeaderSegment,
  cx: number,
  cy: number,
  r: number,
  box: Box,
  allObstacles: readonly Circle[],
  pad: number,
): RoutedLeader {
  // A ring whose outline already runs through the box (the owner dragged the label onto it;
  // M 42's arc through a label near the Trapezium) is not an obstacle: the leader cannot make
  // that worse.
  const obstacles = allObstacles.filter((c) => !boxCrossesRing(box, c, pad))
  const crosses = (from: [number, number], to: [number, number]) =>
    obstacles.some((c) => segmentCrossesRing(from, to, c, pad))
  if (!crosses(seg.from, seg.to)) return { from: seg.from, to: seg.to }
  for (const [px, py] of facingCandidates(cx, cy, box)) {
    const cand = leaderTo(cx, cy, r, px, py)
    if (cand === null) continue // cannot happen: the nearest point is already outside the marker
    if (!crosses(cand.from, cand.to)) return { from: cand.from, to: cand.to }
  }
  return { from: seg.from, to: seg.to }
}

export function leaderVisible(label: Label, gap: number, s: number): boolean {
  if (label.leader === 'on') return true
  if (label.leader === 'off') return false
  return gap > LEADER_GAP_FACTOR * s
}

export type Anchor =
  | 'right'
  | 'left'
  | 'below'
  | 'above'
  | 'below-right'
  | 'below-left'
  | 'above-right'
  | 'above-left'

/** The placer's search order (SPEC § 6.4). */
export const ANCHORS: readonly Anchor[] = [
  'right',
  'left',
  'below',
  'above',
  'below-right',
  'below-left',
  'above-right',
  'above-left',
]

/** Text box of size `w × h` placed at `anchor` around (cx, cy) at distance `offset`. */
export function anchorBox(anchor: Anchor, cx: number, cy: number, offset: number, w: number, h: number): Box {
  let left: number
  let top: number
  const d = offset * SQRT_HALF
  switch (anchor) {
    case 'right':
      left = cx + offset
      top = cy - h / 2
      break
    case 'left':
      left = cx - offset - w
      top = cy - h / 2
      break
    case 'below':
      left = cx - w / 2
      top = cy + offset
      break
    case 'above':
      left = cx - w / 2
      top = cy - offset - h
      break
    case 'below-right':
      left = cx + d
      top = cy + d
      break
    case 'below-left':
      left = cx - d - w
      top = cy + d
      break
    case 'above-right':
      left = cx + d
      top = cy - d - h
      break
    case 'above-left':
      left = cx - d - w
      top = cy - d - h
      break
    default:
      throw new RangeError(`unknown anchor ${String(anchor)}`) // mirrors placement.anchor_box
  }
  return { left, top, right: left + w, bottom: top + h }
}
