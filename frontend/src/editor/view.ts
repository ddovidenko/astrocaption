/** The stage transform: world units are original-image pixels; `scale` is screen px per
 *  world px and (x, y) is where world (0, 0) lands on the screen (SPEC § 6.1). */
export interface View {
  scale: number
  x: number
  y: number
}

export const MIN_SCALE = 0.02
export const MAX_SCALE = 8

/** The whole image visible with `padding` screen px around it, centred. */
export function fitView(imageW: number, imageH: number, viewportW: number, viewportH: number, padding = 24): View {
  const availW = Math.max(1, viewportW - 2 * padding)
  const availH = Math.max(1, viewportH - 2 * padding)
  const scale = Math.min(availW / imageW, availH / imageH)
  return { scale, x: (viewportW - imageW * scale) / 2, y: (viewportH - imageH * scale) / 2 }
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale))
}

/** Scale by `factor` about the screen point (cx, cy): the world point under the cursor stays under it. */
export function zoomAt(view: View, cx: number, cy: number, factor: number, min = MIN_SCALE, max = MAX_SCALE): View {
  const scale = clampScale(view.scale * factor, min, max)
  const k = scale / view.scale
  return { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k }
}

/** A point in stage-container pixels. */
export interface ScreenPoint {
  x: number
  y: number
}

/** One frame of a two-finger gesture (SPEC § 6.5): `prevMid`/`prevDist` are the midpoint of the
 *  two touches and the distance between them on the previous frame, `mid`/`dist` now. The world
 *  point that was under the old midpoint ends up under the new one, and the scale follows the
 *  spread of the fingers, clamped like `zoomAt`. Two fingers on one spot (a zero distance) say
 *  nothing about scale, so the view comes back untouched rather than as NaN. */
export function pinchView(
  view: View,
  prevMid: ScreenPoint,
  prevDist: number,
  mid: ScreenPoint,
  dist: number,
  min = MIN_SCALE,
  max = MAX_SCALE,
): View {
  if (!(prevDist > 0) || !(dist > 0) || !Number.isFinite(dist / prevDist)) return view
  const zoomed = zoomAt(view, prevMid.x, prevMid.y, dist / prevDist, min, max)
  return { scale: zoomed.scale, x: zoomed.x + (mid.x - prevMid.x), y: zoomed.y + (mid.y - prevMid.y) }
}

/** Something now covers the bottom of the canvas from `visibleBottom` (stage-container pixels)
 *  down: the docked label bar's sheet (SPEC § 6.5). Pans the view up by the least that puts the
 *  image row `worldBottom` (original pixels; the selection's lower edge) `margin` screen pixels
 *  clear of it, and hands back the same view when it already is. Never pans down. */
export function revealAbove(view: View, worldBottom: number, visibleBottom: number, margin: number): View {
  const over = worldBottom * view.scale + view.y + margin - visibleBottom
  return over > 0 ? { ...view, y: view.y - over } : view
}

export function toWorld(view: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale }
}

export function toScreen(view: View, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y }
}

/** One original pixel per screen pixel, keeping the current centre of the viewport in place. */
export function actualSize(view: View, viewportW: number, viewportH: number): View {
  return zoomAt(view, viewportW / 2, viewportH / 2, 1 / view.scale)
}
