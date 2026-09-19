import { describe, expect, it } from 'vitest'
import collision from '../../../tests/fixtures/placement/collision_forced.json'
import edge from '../../../tests/fixtures/placement/edge_left_fallback.json'
import fixed from '../../../tests/fixtures/placement/fixed_obstacles.json'
import huge from '../../../tests/fixtures/placement/huge_marker_centre_label.json'
import random0 from '../../../tests/fixtures/placement/random_0.json'
import random1 from '../../../tests/fixtures/placement/random_1.json'
import random2 from '../../../tests/fixtures/placement/random_2.json'
import single from '../../../tests/fixtures/placement/single_right.json'
import stacked from '../../../tests/fixtures/placement/stacked_same_position.json'
import type { Box, Circle } from './metrics'
import {
  PAD_FACTOR,
  boxesOverlap,
  placeLabels,
  placeNewLabel,
  placeNewLabels,
  type Placement,
  type PlacementItem,
} from './placement'
import { scaleUnit, measureLabel } from './metrics'
import { useEditor } from './store'
import { makeDoc, withThirdObject } from './testDoc'

interface Vector {
  name: string
  width: number
  height: number
  items: PlacementItem[]
  fixed_boxes: Box[]
  fixed_circles: Circle[]
  expected: Placement[]
}
const VECTORS = [collision, edge, fixed, huge, random0, random1, random2, single, stacked] as unknown as Vector[]

describe('placeLabels', () => {
  for (const v of VECTORS) {
    it(`reproduces ${v.name}`, () => {
      const got = placeLabels(v.width, v.height, v.items, v.fixed_boxes, v.fixed_circles)
      expect(got.length).toBe(v.expected.length)
      got.forEach((p, i) => {
        const want = v.expected[i]!
        expect(p.id).toBe(want.id)
        expect(p.collided).toBe(want.collided)
        expect(Math.abs(p.x - want.x)).toBeLessThanOrEqual(1e-9)
        expect(Math.abs(p.y - want.y)).toBeLessThanOrEqual(1e-9)
      })
    })
  }
})

describe('placeNewLabel', () => {
  const measure = () => 100 // every string 100 px wide; heights come from the size

  it('places a never-placed label next to its marker, clear of the enabled boxes', () => {
    const doc = makeDoc() // objects 1 and 2 close together; label 1 enabled and placed, label 2 disabled at its object
    useEditor.getState().load(doc)
    const state = useEditor.getState()
    const obj2 = state.objects.get(2)!
    const placed = placeNewLabel(state, measure, 2)
    expect(placed).not.toBeNull()
    expect([placed!.x, placed!.y]).not.toEqual([obj2.x, obj2.y])
    const label1 = state.labels.get(1)!
    const box1 = measureLabel(measure, state.style!, label1, state.objects.get(1)!)
    const box2 = measureLabel(measure, state.style!, state.labels.get(2)!, obj2)
    const pad = PAD_FACTOR * scaleUnit(doc.image.width, doc.image.height)
    expect(
      boxesOverlap(
        { left: label1.x, top: label1.y, right: label1.x + box1.width, bottom: label1.y + box1.height },
        { left: placed!.x, top: placed!.y, right: placed!.x + box2.width, bottom: placed!.y + box2.height },
        pad,
      ),
    ).toBe(false)
  })

  it('throws for an unknown object', () => {
    useEditor.getState().load(makeDoc())
    expect(() => placeNewLabel(useEditor.getState(), measure, 999)).toThrow(/999/)
  })
})

describe('placeNewLabels', () => {
  const measure = () => 100
  it('places later ids around the ones placed earlier in the same call', () => {
    useEditor.getState().reset()
    // Two disabled labels on top of each other at the same object position.
    useEditor.getState().load(withThirdObject(makeDoc(), { x: 1560, y: 1010 }))
    const out = placeNewLabels(useEditor.getState(), measure, [2, 3])
    expect(out.size).toBe(2)
    const a = out.get(2)!
    const b = out.get(3)!
    expect([a.x, a.y]).not.toEqual([b.x, b.y])
  })
  it('skips ids the state does not hold', () => {
    useEditor.getState().reset()
    useEditor.getState().load(makeDoc())
    expect(placeNewLabels(useEditor.getState(), measure, [2, 99]).has(99)).toBe(false)
  })

  it('an enabled label that is not being placed is an obstacle at its stored position', () => {
    useEditor.getState().reset()
    // Object 3's label sits away from its object, as after a drag.
    useEditor.getState().load(withThirdObject(makeDoc()))
    const state = useEditor.getState()

    // Where 2 lands with nothing in the way.
    const unblocked = placeNewLabels(state, measure, [2]).get(2)!

    // A working copy with 3 enabled exactly on that spot (the store itself is not written).
    const labels = new Map(state.labels)
    labels.set(3, { ...state.labels.get(3)!, enabled: true, x: unblocked.x, y: unblocked.y })

    const blocked = placeNewLabels({ ...state, labels }, measure, [2]).get(2)!
    expect([blocked.x, blocked.y]).not.toEqual([unblocked.x, unblocked.y])
  })
})
