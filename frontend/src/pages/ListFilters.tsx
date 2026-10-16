import { useEffect, useRef } from 'react'
import { EMPTY_QUERY, isFiltered, type ListQuery, type ListStatus } from './listQuery'

/** How long typing pauses before the search runs and lands in the URL. */
export const SEARCH_DEBOUNCE_MS = 250

const STATUS_CHIPS: readonly [ListStatus, string][] = [
  ['solving', 'Solving'],
  ['failed', 'Failed'],
  ['solved', 'Solved'],
]
const PUBLISHED_CHIPS: readonly [boolean, string][] = [
  [true, 'Published'],
  [false, 'Unpublished'],
]

/** The search box and filter chips above a list (SPEC § 5.5). The page owns the query (it
 *  lives in the URL); this only reports changes: the box after a short pause, a chip at once,
 *  Clear with the empty query. Within a group one chip is pressed at most, and pressing it
 *  again clears it. The owner's page gets the status and visibility groups; the gallery none. */
export default function ListFilters({
  query,
  onChange,
  owner = false,
  label,
}: {
  query: ListQuery
  onChange: (next: ListQuery) => void
  owner?: boolean
  label: string
}) {
  // Uncontrolled, as the Objects tab's box is (#90): the DOM owns the text while the owner
  // types, and the query only writes it back when it changed elsewhere (Clear, back button).
  const box = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (box.current && box.current.value.trim() !== query.q) box.current.value = query.q
  }, [query.q])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function typed(value: string) {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onChange({ ...query, q: value.trim() }), SEARCH_DEBOUNCE_MS)
  }

  return (
    <div className="list-filters" role="search">
      <input
        ref={box}
        type="search"
        aria-label={label}
        placeholder={label}
        defaultValue={query.q}
        onChange={(e) => typed(e.target.value)}
      />
      {owner && (
        <>
          <div className="chips" aria-label="Solve status">
            {STATUS_CHIPS.map(([value, text]) => (
              <Chip
                key={value}
                pressed={query.status === value}
                onClick={() => onChange({ ...query, status: query.status === value ? null : value })}
              >
                {text}
              </Chip>
            ))}
          </div>
          <div className="chips" aria-label="Visibility">
            {PUBLISHED_CHIPS.map(([value, text]) => (
              <Chip
                key={text}
                pressed={query.published === value}
                onClick={() => onChange({ ...query, published: query.published === value ? null : value })}
              >
                {text}
              </Chip>
            ))}
          </div>
        </>
      )}
      {isFiltered(query) && (
        <button type="button" className="secondary" onClick={() => onChange(EMPTY_QUERY)}>
          Clear
        </button>
      )}
    </div>
  )
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  )
}
