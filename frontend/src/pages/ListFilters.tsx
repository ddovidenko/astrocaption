import { useEffect, useRef } from 'react'
import { SEARCH_MAX_LENGTH } from '../api'
import Chip from '../Chip'
import { EMPTY_QUERY, isFiltered, STATUS_LABELS, type ListQuery } from './listQuery'

/** How long typing pauses before the search runs and lands in the URL. */
export const SEARCH_DEBOUNCE_MS = 250

const PUBLISHED_LABELS: readonly [boolean, string][] = [
  [true, 'Published'],
  [false, 'Unpublished'],
]

/** The search box and filter chips above a list (SPEC § 5.5). The page owns the query (it
 *  lives in the URL); this only reports patches: the box's text after a short pause, a chip
 *  at once, Clear as the empty query. Within a group one chip is pressed at most, and pressing
 *  it again clears it. The owner's page gets the status and visibility groups; the gallery none. */
export default function ListFilters({
  query,
  onChange,
  owner = false,
  label,
}: {
  query: ListQuery
  onChange: (patch: Partial<ListQuery>) => void
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
    timer.current = window.setTimeout(() => onChange({ q: value.trim() }), SEARCH_DEBOUNCE_MS)
  }

  // Text typed inside the pause has not reached the query yet, so the box effect above would
  // not empty it, and the timer would put it back onto the cleared URL.
  function clear() {
    window.clearTimeout(timer.current)
    if (box.current) box.current.value = ''
    onChange(EMPTY_QUERY)
  }

  return (
    <div className="list-filters" role="search">
      <input
        ref={box}
        type="search"
        aria-label={label}
        placeholder={label}
        maxLength={SEARCH_MAX_LENGTH}
        defaultValue={query.q}
        onChange={(e) => typed(e.target.value)}
      />
      {owner && (
        <>
          <div className="chips" role="group" aria-label="Solve status">
            {Object.entries(STATUS_LABELS).map(([value, text]) => (
              <Chip
                key={value}
                pressed={query.status === value}
                onClick={() => onChange({ status: query.status === value ? null : (value as ListQuery['status']) })}
              >
                {text}
              </Chip>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Visibility">
            {PUBLISHED_LABELS.map(([value, text]) => (
              <Chip key={text} pressed={query.published === value} onClick={() => onChange({ published: query.published === value ? null : value })}>
                {text}
              </Chip>
            ))}
          </div>
        </>
      )}
      {isFiltered(query) && (
        <button type="button" className="secondary" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  )
}
