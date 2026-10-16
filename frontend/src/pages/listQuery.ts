import type { ListStatus, PageQuery } from '../api'

export type { ListStatus }

/** The search and filters of a list page (SPEC § 5.5, § 8). The URL is its only home: both
 *  pages read it with `readListQuery` and write it back with `writeListQuery`, so a result is
 *  linkable and a reload lands on the same list. */
export interface ListQuery {
  q: string
  status: ListStatus | null
  published: boolean | null
}

export const EMPTY_QUERY: ListQuery = { q: '', status: null, published: null }

const STATUSES: readonly ListStatus[] = ['solving', 'failed', 'solved']

function statusOf(value: string | null): ListStatus | null {
  return (STATUSES as readonly string[]).includes(value ?? '') ? (value as ListStatus) : null
}

function publishedOf(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null
}

/** The query a URL names; unknown values read as unset rather than erroring. */
export function readListQuery(params: URLSearchParams): ListQuery {
  return {
    q: (params.get('q') ?? '').trim(),
    status: statusOf(params.get('status')),
    published: publishedOf(params.get('published')),
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
  return page
}

/** The Show more link: the current filters, then the cursor, so a followed link stays inside
 *  the result set (SPEC § 5.5). */
export function pageHref(query: ListQuery, before: string): string {
  const parts = entries(query)
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  parts.push(`before=${encodeURIComponent(before)}`)
  return `?${parts.join('&')}`
}

/** The query's URL keys and string values, in URL order; null for an unset one. */
function entries(query: ListQuery): [string, string | null][] {
  const q = query.q.trim()
  return [
    ['q', q || null],
    ['status', query.status],
    ['published', query.published === null ? null : String(query.published)],
  ]
}
