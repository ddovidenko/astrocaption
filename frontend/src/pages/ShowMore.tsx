/** The pager (SPEC § 5.5, § 8): one "Show more" that appends the next page. A real link to
 *  `?before=<id>`, so a crawler that runs the app can follow the chain of pages, while a click
 *  is handled here and never leaves the page. Nothing on the last page. */
export default function ShowMore({
  next,
  busy,
  error,
  onMore,
}: {
  next: string | null
  busy: boolean
  error: string | null
  onMore: () => void
}) {
  if (next === null) return null
  return (
    <p className="show-more">
      <a
        className="button secondary"
        href={`?before=${encodeURIComponent(next)}`}
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
