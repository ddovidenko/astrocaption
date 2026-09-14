import { describe, expect, it } from 'vitest'
import type { ObjectOut } from '../api'
import { CHIPS, DEFAULT_CHIPS, chipFor, filterObjects } from './objectsFilter'

/** The `nova-narrow` field (1° Pelican): 8 objects, five of them `hd` — the shape #37 is about. */
function narrowField(): ObjectOut[] {
  const rows: [number, string, string][] = [
    [1, 'HD 198896', 'hd'],
    [2, 'HD 198639', 'hd'],
    [3, 'HD 198931', 'hd'],
    [4, 'HD 199081', 'hd'],
    [5, 'HD 199178', 'hd'],
    [6, '56 Cyg', 'bright'],
    [7, '57 Cyg', 'bright'],
    [8, 'IC 5070', 'ic'],
  ]
  return rows.map(([id, name, type]) => ({
    id,
    catalog_names: [name],
    primary_name: name,
    type,
    x: id * 10,
    y: id * 10,
    radius: type === 'ic' ? 903.19 : 0,
  }))
}

const names = (objects: ObjectOut[]) => objects.map((o) => o.primary_name)

describe('chipFor', () => {
  it('keeps nova types that have a chip of their own', () => {
    for (const chip of CHIPS) expect(chipFor(chip)).toBe(chip)
  })

  it('buckets every other nova type as other', () => {
    expect(chipFor('messier')).toBe('other')
    expect(chipFor('sdss')).toBe('other')
  })

  it('is case-insensitive', () => {
    expect(chipFor('NGC')).toBe('ngc')
  })
})

describe('filterObjects', () => {
  it('hides the HD rows by default (#37)', () => {
    const shown = filterObjects(narrowField(), '', DEFAULT_CHIPS)
    expect(names(shown)).toEqual(['56 Cyg', '57 Cyg', 'IC 5070'])
  })

  it('shows all eight once the hd chip is on', () => {
    const chips = new Set([...DEFAULT_CHIPS, 'hd' as const])
    expect(filterObjects(narrowField(), '', chips)).toHaveLength(8)
  })

  it('searches case-insensitively within the shown types', () => {
    expect(names(filterObjects(narrowField(), 'cyg', DEFAULT_CHIPS))).toEqual(['56 Cyg', '57 Cyg'])
  })

  it('matches a substring of the catalogue number', () => {
    const chips = new Set([...DEFAULT_CHIPS, 'hd' as const])
    expect(names(filterObjects(narrowField(), '198', chips))).toEqual(['HD 198896', 'HD 198639', 'HD 198931'])
  })

  it('searches every catalogue name, not just the primary one', () => {
    const objects: ObjectOut[] = [
      { id: 1, catalog_names: ['NGC 1976', 'M 42'], primary_name: 'M 42', type: 'ngc', x: 0, y: 0, radius: 40 },
    ]
    expect(filterObjects(objects, 'ngc 19', DEFAULT_CHIPS)).toHaveLength(1)
  })

  it('ignores surrounding whitespace and keeps the input order', () => {
    expect(names(filterObjects(narrowField(), '  Cyg  ', DEFAULT_CHIPS))).toEqual(['56 Cyg', '57 Cyg'])
  })

  it('shows nothing when every chip is off', () => {
    expect(filterObjects(narrowField(), '', new Set())).toEqual([])
  })
})
