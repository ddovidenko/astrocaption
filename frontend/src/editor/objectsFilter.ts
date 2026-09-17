// The Objects tab's search and kind filter (SPEC § 6.3). Pure, so the filtering rules are tested
// without a DOM: the tab owns only the query string and the filter object.

import type { ObjectKind, ObjectOut } from '../api'

export const KINDS: readonly ObjectKind[] = ['galaxy', 'nebula', 'cluster', 'star', 'other']

export const KIND_LABELS: Record<ObjectKind, string> = {
  galaxy: 'Galaxies',
  nebula: 'Nebulae',
  cluster: 'Clusters',
  star: 'Stars',
  other: 'Other',
}

export interface ObjectsFilter {
  kinds: ReadonlySet<ObjectKind>
  /** Whether nova's `hd` rows show inside the `star` kind. Off to begin with (#37): a narrow
   *  field can return dozens of HD stars, most of them duplicates of a brighter row. The labels
   *  themselves are kept — only this list hides them. */
  hd: boolean
}

export const DEFAULT_FILTER: ObjectsFilter = { kinds: new Set<ObjectKind>(KINDS), hd: false }

export function isHd(o: ObjectOut): boolean {
  return o.type.toLowerCase() === 'hd'
}

/** The rows to show: objects whose kind is on (an `hd` row also needs the toggle) and whose *any*
 *  catalogue name contains `query` (case-insensitive substring — searching "198" has to find
 *  HD 198639 by its full name, not only by the primary name the preference picked). Input order
 *  is preserved. */
export function filterObjects(objects: ObjectOut[], query: string, filter: ObjectsFilter): ObjectOut[] {
  const q = query.trim().toLowerCase()
  return objects.filter(
    (o) =>
      filter.kinds.has(o.kind) &&
      (filter.hd || !isHd(o)) &&
      (q === '' || o.catalog_names.some((n) => n.toLowerCase().includes(q))),
  )
}
