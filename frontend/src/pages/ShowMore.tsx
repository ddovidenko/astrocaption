import { EMPTY_QUERY, pageHref, type ListQuery } from './listQuery'

/** The pager (SPEC § 5.5, § 8): one "Show more" that appends the next page. A real link to
 *  `?…&before=<id>` carrying the current search and filters, so a crawler that runs the app
 *  can follow the chain inside the result set, while a click is handled here and never leaves
 *  the page. Nothing on the last page. */
export default function ShowMore({
  next,
  busy,
  error,
  onMore,
  query = EMPTY_QUERY,
}: {
  next: string | null
  busy: boolean
  error: string | null
  onMore: () => void
  query?: ListQuery
}) {
  if (next === null) return null
  return (
    <p className="show-more">
      <a
        className="button secondary"
        href={pageHref(query, next)}
        aria-disabled={busy}
        onClick={(e) => {
          e.preventDefault()
          if (!busy) onMore()
        }}
      >
        {busy ? 'Loading…' : 'Show more'}
      </a>
      {error && <span className="error">{error}</span>}
    </p>
  )
}
