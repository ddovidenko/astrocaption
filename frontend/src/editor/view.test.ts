import { describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, actualSize, fitView, pinchView, revealAbove, toScreen, toWorld, zoomAt, type View } from './view'

describe('view', () => {
  it('fits a landscape image into the viewport with padding and centres it', () => {
    const v = fitView(3000, 2000, 1224, 600, 24)
    expect(v.scale).toBeCloseTo((600 - 48) / 2000) // height-bound
    expect(v.y).toBeCloseTo(24)
    expect(v.x).toBeCloseTo((1224 - 3000 * v.scale) / 2)
  })

  it('fits a portrait image width-bound', () => {
    // A square (or wider) viewport would make height the binding constraint for a portrait
    // image (contain-fit takes the smaller ratio), so the viewport here is tall enough
    // (height >= 1.5x width, matching the image's 2:3 aspect) that width is the tighter one.
    const v = fitView(2000, 3000, 1000, 2000, 0)
    expect(v.scale).toBeCloseTo(0.5)
    expect(v.x).toBe(0)
    expect(v.y).toBeCloseTo((2000 - 3000 * 0.5) / 2)
  })

  it('zooms about the cursor so the world point under it stays put', () => {
    const v = { scale: 0.5, x: 100, y: 50 }
    const before = toWorld(v, 400, 300)
    const z = zoomAt(v, 400, 300, 1.25, MIN_SCALE, MAX_SCALE)
    expect(z.scale).toBeCloseTo(0.625)
    const after = toWorld(z, 400, 300)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps the scale to the allowed range', () => {
    const v = { scale: 7, x: 0, y: 0 }
    expect(zoomAt(v, 0, 0, 10, MIN_SCALE, MAX_SCALE).scale).toBe(MAX_SCALE)
    expect(zoomAt({ scale: 0.03, x: 0, y: 0 }, 0, 0, 0.1, MIN_SCALE, MAX_SCALE).scale).toBe(MIN_SCALE)
  })

  it('round-trips world and screen', () => {
    const v = { scale: 0.4, x: 12, y: -7 }
    const s = toScreen(v, 1500, 1000)
    const w = toWorld(v, s.x, s.y)
    expect(w.x).toBeCloseTo(1500)
    expect(w.y).toBeCloseTo(1000)
  })

  it('actualSize snaps to scale 1 keeping the viewport centre fixed', () => {
    const v = { scale: 0.4, x: 12, y: -7 }
    const centreBefore = toWorld(v, 600, 400)
    const a = actualSize(v, 1200, 800)
    expect(a.scale).toBeCloseTo(1)
    const centreAfter = toWorld(a, 600, 400)
    expect(centreAfter.x).toBeCloseTo(centreBefore.x)
    expect(centreAfter.y).toBeCloseTo(centreBefore.y)
  })
})

// Two fingers on the photo (SPEC § 6.5): the world point under the old midpoint follows the new
// one, and the spread between the fingers scales the view.
describe('pinchView', () => {
  const v: View = { scale: 0.5, x: 100, y: 50 }

  it('is the identity when nothing moved', () => {
    expect(pinchView(v, { x: 200, y: 200 }, 80, { x: 200, y: 200 }, 80)).toEqual(v)
  })

  it('keeps the world point under the midpoint while zooming', () => {
    const out = pinchView(v, { x: 200, y: 200 }, 80, { x: 200, y: 200 }, 160)
    expect(out.scale).toBeCloseTo(1)
    expect(toWorld(out, 200, 200)).toEqual(toWorld(v, 200, 200))
  })

  it('pans with the midpoint', () => {
    const out = pinchView(v, { x: 200, y: 200 }, 80, { x: 230, y: 180 }, 80)
    expect(out).toEqual({ scale: 0.5, x: 130, y: 30 })
  })

  it('zooms and pans in one step', () => {
    const out = pinchView(v, { x: 200, y: 200 }, 80, { x: 230, y: 180 }, 160)
    const w = toWorld(v, 200, 200)
    expect(toScreen(out, w.x, w.y)).toEqual({ x: 230, y: 180 })
  })

  it('clamps at both limits and still follows the midpoint', () => {
    expect(pinchView(v, { x: 0, y: 0 }, 1, { x: 0, y: 0 }, 1e6).scale).toBe(MAX_SCALE)
    expect(pinchView(v, { x: 0, y: 0 }, 1e6, { x: 0, y: 0 }, 1).scale).toBe(MIN_SCALE)
  })

  it('returns the view unchanged for a zero or non-finite distance', () => {
    expect(pinchView(v, { x: 1, y: 1 }, 0, { x: 9, y: 9 }, 50)).toBe(v)
    expect(pinchView(v, { x: 1, y: 1 }, 50, { x: 9, y: 9 }, 0)).toBe(v)
    expect(pinchView(v, { x: 1, y: 1 }, NaN, { x: 9, y: 9 }, 50)).toBe(v)
  })
})

// Something covers the bottom of the canvas (the docked bar's sheet, SPEC § 6.5): the view pans up
// by the least that keeps a point clear of it.
describe('revealAbove', () => {
  const v: View = { scale: 0.5, x: 10, y: 100 }

  it('leaves the view alone when the point is already clear of the cover', () => {
    expect(revealAbove(v, 400, 400, 8)).toBe(v) // the point is at screen y 300
  })

  it('pans up just far enough to put the point a margin above the cover', () => {
    const out = revealAbove(v, 800, 400, 8) // the point is at screen y 500
    expect(out).toEqual({ scale: 0.5, x: 10, y: -8 })
    expect(toScreen(out, 0, 800).y).toBe(392)
  })

  it('counts a point exactly a margin above the cover as clear', () => {
    expect(revealAbove(v, 584, 400, 8)).toBe(v) // screen y 392
  })
})
