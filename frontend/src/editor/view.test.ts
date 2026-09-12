import { describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, actualSize, fitView, toScreen, toWorld, zoomAt } from './view'

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
