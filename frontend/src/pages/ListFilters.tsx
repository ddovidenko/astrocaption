import { useEffect, useRef } from 'react'
import { SEARCH_MAX_LENGTH } from '../api'
import Chip from '../Chip'
import { KIND_LABELS, KINDS } from '../editor/objectsFilter'
import { dayOf, EMPTY_QUERY, isFiltered, STATUS_LABELS, type ListQuery } from './listQuery'

/** How long typing pauses before the search runs and lands in the URL. */
export const SEARCH_DEBOUNCE_MS = 250

const PUBLISHED_LABELS: readonly [boolean, string][] = [
  [true, 'Published'],
  [false, 'Unpublished'],
]

/** The search box and filter chips above a list (SPEC § 5.5). The page owns the query (it
 *  lives in the URL); this only reports patches: the box's text and the dates after a short
 *  pause (typing a date emits a value per digit of the year), a chip at once, Clear as the
 *  empty query. Within a group one chip is pressed at most, and pressing it again clears it.
 *  Everyone gets the kind chips and the upload-day range; the owner's page adds the status and
 *  visibility groups. */
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
  // The date inputs follow the same rule: a half-typed date reads as '' and must not be
  // overwritten by a controlled re-render mid-entry.
  const box = useRef<HTMLInputElement>(null)
  const since = useRef<HTMLInputElement>(null)
  const until = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<Partial<ListQuery>>({})
  useEffect(() => {
    if (box.current && box.current.value.trim() !== query.q) box.current.value = query.q
  }, [query.q])
  useEffect(() => {
    if (since.current && since.current.value !== (query.since ?? '')) since.current.value = query.since ?? ''
  }, [query.since])
  useEffect(() => {
    if (until.current && until.current.value !== (query.until ?? '')) until.current.value = query.until ?? ''
  }, [query.until])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Everything typed inside one pause lands as one patch.
  function later(patch: Partial<ListQuery>) {
    pending.current = { ...pending.current, ...patch }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const patch = pending.current
      pending.current = {}
      onChange(patch)
    }, SEARCH_DEBOUNCE_MS)
  }

  // Text typed inside the pause has not reached the query yet, so the box effect above would
  // not empty it, and the timer would put it back onto the cleared URL. A half-typed date is
  // the same: it reads as '' (so the query holds nothing to clear) while the picker still
  // shows its digits.
  function clear() {
    window.clearTimeout(timer.current)
    pending.current = {}
    for (const input of [box, since, until]) if (input.current) input.current.value = ''
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
        onChange={(e) => later({ q: e.target.value.trim() })}
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
      <div className="chips" role="group" aria-label="Object kind">
        {KINDS.map((kind) => (
          <Chip key={kind} pressed={query.kind === kind} onClick={() => onChange({ kind: query.kind === kind ? null : kind })}>
            {KIND_LABELS[kind]}
          </Chip>
        ))}
      </div>
      <span className="date-range">
        <label>
          <span className="date-word">From</span>
          <input ref={since} type="date" defaultValue={query.since ?? ''} onChange={(e) => later({ since: dayOf(e.target.value) })} />
        </label>
        <label>
          <span className="date-word">To</span>
          <input ref={until} type="date" defaultValue={query.until ?? ''} onChange={(e) => later({ until: dayOf(e.target.value) })} />
        </label>
      </span>
      {isFiltered(query) && (
        <button type="button" className="secondary" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  )
}
