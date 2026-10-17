import type { ListStatus, ObjectKind, PageQuery } from '../api'
import { KINDS } from '../editor/objectsFilter'

/** The search and filters of a list page (SPEC § 5.5, § 8). The URL is its only home: both
 *  pages read it with `readListQuery` and write it back with `writeListQuery`, so a result is
 *  linkable and a reload lands on the same list. `since` and `until` are upload days in UTC,
 *  `YYYY-MM-DD`, as the API and a native date input both spell them. */
export interface ListQuery {
  q: string
  status: ListStatus | null
  published: boolean | null
  kind: ObjectKind | null
  since: string | null
  until: string | null
}

export const EMPTY_QUERY: ListQuery = { q: '', status: null, published: null, kind: null, since: null, until: null }

/** The owner's status chips, in display order; `solving` is every row the page polls. */
export const STATUS_LABELS: Record<ListStatus, string> = { solving: 'Solving', failed: 'Failed', solved: 'Solved' }

function statusOf(value: string | null): ListStatus | null {
  return value !== null && value in STATUS_LABELS ? (value as ListStatus) : null
}

function publishedOf(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null
}

function kindOf(value: string | null): ObjectKind | null {
  return value !== null && (KINDS as readonly string[]).includes(value) ? (value as ObjectKind) : null
}

/** A day as the API takes it; anything else (a hand-edited URL) reads as no bound. */
const DAY = /^\d{4}-\d{2}-\d{2}$/

function dayOf(value: string | null): string | null {
  return value !== null && DAY.test(value) ? value : null
}

/** The query a URL names; unknown values read as unset rather than erroring. */
export function readListQuery(params: URLSearchParams): ListQuery {
  return {
    q: (params.get('q') ?? '').trim(),
    status: statusOf(params.get('status')),
    published: publishedOf(params.get('published')),
    kind: kindOf(params.get('kind')),
    since: dayOf(params.get('since')),
    until: dayOf(params.get('until')),
  }
}

/** `params` with `query` written in and the cursor dropped: a changed filter is a new result
 *  set, and the old `before` belonged to the old one. The filter keys are removed first and
 *  re-added in one fixed order, so the same query is always the same URL whichever filter was
 *  touched first; anything else in the URL is kept. */
export function writeListQuery(params: URLSearchParams, query: ListQuery): URLSearchParams {
  const out = new URLSearchParams(params)
  out.delete('before')
  for (const [key] of entries(query)) out.delete(key)
  for (const [key, value] of entries(query)) {
    if (value !== null) out.set(key, value)
  }
  return out
}

export function isFiltered(query: ListQuery): boolean {
  return entries(query).some(([, value]) => value !== null)
}

/** The API's view of the query: only what is set. */
export function toPageQuery(query: ListQuery): PageQuery {
  const page: PageQuery = {}
  const q = query.q.trim()
  if (q) page.q = q
  if (query.status) page.status = query.status
  if (query.published !== null) page.published = query.published
  if (query.kind) page.kind = query.kind
  if (query.since) page.since = query.since
  if (query.until) page.until = query.until
  return page
}

/** The Show more link: the current filters, then the cursor, so a followed link stays inside
 *  the result set (SPEC § 5.5). */
export function pageHref(query: ListQuery, before: string): string {
  const params = writeListQuery(new URLSearchParams(), query)
  params.set('before', before)
  return `?${params}`
}

/** The query's URL keys and string values, in URL order; null for an unset one. */
function entries(query: ListQuery): [string, string | null][] {
  const q = query.q.trim()
  return [
    ['q', q || null],
    ['status', query.status],
    ['published', query.published === null ? null : String(query.published)],
    ['kind', query.kind],
    ['since', query.since],
    ['until', query.until],
  ]
}
