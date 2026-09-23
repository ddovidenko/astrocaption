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

/** The rows to show: every object whose label is enabled (the list always describes what the
 *  canvas draws), plus the disabled ones whose kind is on (an `hd` row also needs the toggle) —
 *  so HD can be switched on to enable one star and off again to drop the rest — and in both
 *  cases whose *any* catalogue name contains `query` (case-insensitive substring — searching
 *  "198" has to find HD 198639 by its full name, not only by the primary name the preference
 *  picked). Input order is preserved. */
export function filterObjects(
  objects: ObjectOut[],
  query: string,
  filter: ObjectsFilter,
  enabled: ReadonlySet<number> = new Set(),
): ObjectOut[] {
  const q = query.trim().toLowerCase()
  return objects.filter(
    (o) =>
      (enabled.has(o.id) || (filter.kinds.has(o.kind) && (filter.hd || !isHd(o)))) &&
      (q === '' || o.catalog_names.some((n) => n.toLowerCase().includes(q))),
  )
}

const STORAGE_PREFIX = 'astrocaption.objects-filter.'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // a private window or blocked site data: the accessor itself can throw
  }
}

/** The chips this browser last left on `imageId`, or the defaults. A per-viewer convenience
 *  (SPEC § 6.3): storage that is missing, refusing or holding something unreadable means the
 *  defaults, never an error. `store` is injectable for the node tests. */
export function loadFilter(imageId: string, store: Storage | null = storage()): ObjectsFilter {
  try {
    const raw = store?.getItem(STORAGE_PREFIX + imageId)
    if (!raw) return DEFAULT_FILTER
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FILTER
    const { kinds, hd } = parsed as { kinds?: unknown; hd?: unknown }
    if (!Array.isArray(kinds) || typeof hd !== 'boolean') return DEFAULT_FILTER
    if (!kinds.every((k): k is ObjectKind => (KINDS as readonly unknown[]).includes(k))) return DEFAULT_FILTER
    return { kinds: new Set(kinds), hd }
  } catch {
    return DEFAULT_FILTER
  }
}

export function saveFilter(imageId: string, filter: ObjectsFilter, store: Storage | null = storage()): void {
  try {
    store?.setItem(STORAGE_PREFIX + imageId, JSON.stringify({ kinds: [...filter.kinds], hd: filter.hd }))
  } catch {
    // quota or a refusing storage: the chips just start from the defaults next time
  }
}
