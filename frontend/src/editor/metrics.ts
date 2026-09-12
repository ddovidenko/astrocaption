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

/** `obj.primary_name` already follows the image's name preference: the server ranks names
 *  (models.primary_name), so a preference change means re-fetching the objects. */
export function labelText(obj: ObjectOut, label: Label, style: StyleConfig): LabelLines {
  const override = (label.text_override ?? '').trim()
  const primary = override || obj.primary_name
  const show = label.show_aliases ?? style.show_aliases
  const aliases = obj.catalog_names.filter((n) => n !== obj.primary_name)
  return { primary, alias: show && aliases.length > 0 ? aliases.join(ALIAS_SEP) : null }
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

export interface LeaderSegment {
  from: [number, number]
  to: [number, number]
  gap: number
}

/** From the marker edge to the closest point of `box`, or null when the box reaches the marker. */
export function leaderSegment(cx: number, cy: number, r: number, box: Box): LeaderSegment | null {
  const nx = Math.min(Math.max(cx, box.left), box.right)
  const ny = Math.min(Math.max(cy, box.top), box.bottom)
  const dx = nx - cx
  const dy = ny - cy
  const dist = Math.hypot(dx, dy)
  if (dist <= r) return null
  const ux = dx / dist
  const uy = dy / dist
  return { from: [cx + ux * r, cy + uy * r], to: [nx, ny], gap: dist - r }
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
