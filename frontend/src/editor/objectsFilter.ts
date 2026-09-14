// The Objects tab's search and type filter (design § 5). Pure, so the filtering rules are tested
// without a DOM: the tab owns only the query string and the chip set.

import type { ObjectOut } from '../api'

/** The type buckets the tab offers. `ngc`, `ic`, `bright` and `hd` are nova's own annotation
 *  types; everything else nova sends (messier, sdss, tycho2, …) lands in `other`. */
export type Chip = 'ngc' | 'ic' | 'bright' | 'hd' | 'other'

export const CHIPS: readonly Chip[] = ['ngc', 'ic', 'bright', 'hd', 'other']

export const CHIP_LABELS: Record<Chip, string> = {
  ngc: 'NGC',
  ic: 'IC',
  bright: 'Bright stars',
  hd: 'HD stars',
  other: 'Other',
}

/** `hd` is off to begin with (#37): a narrow field can return dozens of HD stars, most of them
 *  duplicates of a brighter row. The labels themselves are kept — only this list hides them. */
export const DEFAULT_CHIPS: ReadonlySet<Chip> = new Set<Chip>(['ngc', 'ic', 'bright', 'other'])

export function chipFor(type: string): Chip {
  const t = type.toLowerCase()
  return (CHIPS as readonly string[]).includes(t) ? (t as Chip) : 'other'
}

/** The rows to show: objects whose type is in `chips` and whose *any* catalogue name contains
 *  `query` (case-insensitive substring — searching "198" has to find HD 198639 by its full name,
 *  not only by the primary name the preference picked). Input order is preserved. */
export function filterObjects(objects: ObjectOut[], query: string, chips: ReadonlySet<Chip>): ObjectOut[] {
  const q = query.trim().toLowerCase()
  return objects.filter(
    (o) => chips.has(chipFor(o.type)) && (q === '' || o.catalog_names.some((n) => n.toLowerCase().includes(q))),
  )
}
