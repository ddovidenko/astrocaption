import { describe, expect, it } from 'vitest'
import type { ObjectKind, ObjectOut } from '../api'
import { DEFAULT_FILTER, KINDS, filterObjects, isHd } from './objectsFilter'

/** The `nova-narrow` field (1° Pelican): 8 objects, five of them `hd` — the shape #37 is about. */
function narrowField(): ObjectOut[] {
  const rows: [number, string, string, ObjectKind][] = [
    [1, 'HD 198896', 'hd', 'star'],
    [2, 'HD 198639', 'hd', 'star'],
    [3, 'HD 198931', 'hd', 'star'],
    [4, 'HD 199081', 'hd', 'star'],
    [5, 'HD 199178', 'hd', 'star'],
    [6, '56 Cyg', 'bright', 'star'],
    [7, '57 Cyg', 'bright', 'star'],
    [8, 'IC 5070', 'ic', 'nebula'],
  ]
  return rows.map(([id, name, type, kind]) => ({
    id,
    catalog_names: [name],
    primary_name: name,
    type,
    kind,
    x: id * 10,
    y: id * 10,
    radius: kind === 'nebula' ? 903.19 : 0,
  }))
}

const names = (objects: ObjectOut[]) => objects.map((o) => o.primary_name)
const withHd = { ...DEFAULT_FILTER, hd: true }

describe('isHd', () => {
  it('is nova’s hd type, case-insensitively', () => {
    expect(isHd(narrowField()[0]!)).toBe(true)
    expect(isHd({ ...narrowField()[0]!, type: 'HD' })).toBe(true)
    expect(isHd(narrowField()[6]!)).toBe(false)
  })
})

describe('filterObjects', () => {
  it('shows every kind but hides the HD rows by default (#37)', () => {
    expect(DEFAULT_FILTER.hd).toBe(false)
    expect([...DEFAULT_FILTER.kinds]).toEqual(KINDS)
    expect(names(filterObjects(narrowField(), '', DEFAULT_FILTER))).toEqual(['56 Cyg', '57 Cyg', 'IC 5070'])
  })

  it('shows all eight once the HD toggle is on', () => {
    expect(filterObjects(narrowField(), '', withHd)).toHaveLength(8)
  })

  it('hides HD rows with the other stars when the star kind is off, whatever the toggle says', () => {
    const kinds = new Set<ObjectKind>(['nebula'])
    expect(names(filterObjects(narrowField(), '', { kinds, hd: true }))).toEqual(['IC 5070'])
  })

  it('searches case-insensitively within the shown kinds', () => {
    expect(names(filterObjects(narrowField(), 'cyg', DEFAULT_FILTER))).toEqual(['56 Cyg', '57 Cyg'])
  })

  it('matches a substring of the catalogue number', () => {
    expect(names(filterObjects(narrowField(), '198', withHd))).toEqual(['HD 198896', 'HD 198639', 'HD 198931'])
  })

  it('searches every catalogue name, not just the primary one', () => {
    const objects: ObjectOut[] = [
      { id: 1, catalog_names: ['NGC 1976', 'M 42'], primary_name: 'M 42', type: 'ngc', kind: 'nebula', x: 0, y: 0, radius: 40 },
    ]
    expect(filterObjects(objects, 'ngc 19', DEFAULT_FILTER)).toHaveLength(1)
  })

  it('ignores surrounding whitespace and keeps the input order', () => {
    expect(names(filterObjects(narrowField(), '  Cyg  ', DEFAULT_FILTER))).toEqual(['56 Cyg', '57 Cyg'])
  })

  it('shows nothing when every kind is off', () => {
    expect(filterObjects(narrowField(), '', { kinds: new Set(), hd: true })).toEqual([])
  })
})

// An enabled label is always listed, whatever the chips say: the chips decide which *disabled*
// rows are offered, so HD can be switched on to enable one star and off again to drop the rest.
describe('filterObjects with enabled labels', () => {
  const enabled = new Set([2, 8]) // HD 198639 and IC 5070 are drawn on the canvas
  it('lists an enabled hd row with the HD chip off', () => {
    expect(names(filterObjects(narrowField(), '', DEFAULT_FILTER, enabled))).toEqual(['HD 198639', '56 Cyg', '57 Cyg', 'IC 5070'])
  })
  it('lists an enabled row of a kind whose chip is off', () => {
    const kinds = new Set<ObjectKind>(['nebula'])
    expect(names(filterObjects(narrowField(), '', { kinds, hd: false }, enabled))).toEqual(['HD 198639', 'IC 5070'])
  })
  it('still applies the search to enabled rows', () => {
    expect(names(filterObjects(narrowField(), 'cyg', DEFAULT_FILTER, enabled))).toEqual(['56 Cyg', '57 Cyg'])
  })
})
