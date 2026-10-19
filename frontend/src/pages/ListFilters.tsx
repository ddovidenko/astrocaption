import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
 *  visibility groups. The groups sit under the search box in one panel; on a phone (≤ 640 px, by
 *  CSS) they are collapsed behind a Filters button that counts what is set, so the first card
 *  stays above the fold (#229). The button is rendered everywhere and hidden by CSS above that
 *  width, so the open state is only ever consulted on a phone. */
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
  const [open, setOpen] = useState(false)
  const groupsId = useId()
  // What the collapsed groups hold: the chips and the dates, not the text in the box above.
  const hidden = [query.kind, query.status, query.published, query.since, query.until].filter((v) => v !== null).length
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
    <div className={open ? 'list-filters open' : 'list-filters'} role="search">
      <div className="filter-row">
        <input
          ref={box}
          type="search"
          aria-label={label}
          placeholder={label}
          maxLength={SEARCH_MAX_LENGTH}
          defaultValue={query.q}
          onChange={(e) => later({ q: e.target.value.trim() })}
        />
        <button
          type="button"
          className="secondary filters-toggle"
          aria-expanded={open}
          aria-controls={groupsId}
          aria-label={hidden > 0 ? `Filters, ${hidden} active` : 'Filters'}
          data-active={hidden > 0}
          onClick={() => setOpen((o) => !o)}
        >
          Filters
          {hidden > 0 && <span className="count">{hidden}</span>}
        </button>
      </div>
      <div className="filter-groups" id={groupsId}>
        {owner && (
          <>
            <Group label="Status">
              {Object.entries(STATUS_LABELS).map(([value, text]) => (
                <Chip
                  key={value}
                  pressed={query.status === value}
                  onClick={() => onChange({ status: query.status === value ? null : (value as ListQuery['status']) })}
                >
                  {text}
                </Chip>
              ))}
            </Group>
            <Group label="Visibility">
              {PUBLISHED_LABELS.map(([value, text]) => (
                <Chip key={text} pressed={query.published === value} onClick={() => onChange({ published: query.published === value ? null : value })}>
                  {text}
                </Chip>
              ))}
            </Group>
          </>
        )}
        <Group label="Kind">
          {KINDS.map((kind) => (
            <Chip key={kind} pressed={query.kind === kind} onClick={() => onChange({ kind: query.kind === kind ? null : kind })}>
              {KIND_LABELS[kind]}
            </Chip>
          ))}
        </Group>
        <Group label="Uploaded" range>
          <label>
            <span className="date-word">From</span>
            <input ref={since} type="date" defaultValue={query.since ?? ''} onChange={(e) => later({ since: dayOf(e.target.value) })} />
          </label>
          <label>
            <span className="date-word">To</span>
            <input ref={until} type="date" defaultValue={query.until ?? ''} onChange={(e) => later({ until: dayOf(e.target.value) })} />
          </label>
        </Group>
        {isFiltered(query) && (
          <button type="button" className="secondary clear" onClick={clear}>
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

/** One labelled group of the bar: chips, or (`range`) the two date inputs joined into one
 *  segmented control. The visible label names the group for assistive tech too. */
function Group({ label, range = false, children }: { label: string; range?: boolean; children: ReactNode }) {
  const id = useId()
  return (
    <div className="filter-group" role="group" aria-labelledby={id}>
      <span className="group-label" id={id}>
        {label}
      </span>
      {range ? <span className="date-range">{children}</span> : <div className="chips">{children}</div>}
    </div>
  )
}
