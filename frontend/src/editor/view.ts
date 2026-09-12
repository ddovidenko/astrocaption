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
