import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { readListQuery, writeListQuery, type ListQuery } from './listQuery'

/** Where a list page is: its search and chips (the result set) and `start`, the `before` of a
 *  followed Show more link (the position in it), both from the URL (SPEC § 5.5: its only home). */
export interface ListLocation {
  query: ListQuery
  start: string | null
}

/** The list page's URL state, read from the URL and written back with history replace.
 *  `change` takes a patch and merges it onto the URL as it is when the patch lands, not as it
 *  was when the caller rendered: the debounced search box fires after a chip pressed inside its
 *  pause has already changed the URL, and the search must land on top of that press. A changed
 *  filter drops the cursor (`writeListQuery`). `dropStart` drops only the cursor, for a followed
 *  page that is gone (#227); the pages' load effects then list from the top. `current` answers
 *  the same question for anything that outlives its render (a card action's refresh, an upload,
 *  a Show more page in flight): the location the URL names now. `params` is memoised on
 *  `location.search`, so `query`'s identity changes only when the URL does, and
 *  `current().query !== query` means "the URL moved on". */
export function useListQuery(): {
  query: ListQuery
  start: string | null
  change: (patch: Partial<ListQuery>) => void
  current: () => ListLocation
  dropStart: () => void
} {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => readListQuery(params), [params])
  const start = params.get('before')
  const latest = useRef(params)
  const live = useRef<ListLocation>({ query, start })
  useEffect(() => {
    latest.current = params
    live.current = { query, start }
  })
  const change = useCallback(
    (patch: Partial<ListQuery>) => {
      const next = writeListQuery(latest.current, { ...readListQuery(latest.current), ...patch })
      // Two patches before the next commit (a chip and the box in one tick) must stack.
      latest.current = next
      setParams(next, { replace: true })
    },
    [setParams],
  )
  const dropStart = useCallback(() => {
    // The URL moved on meanwhile and took the cursor with it: nothing to drop, and a same-URL
    // replace would only re-run the load effects.
    if (!latest.current.has('before')) return
    const next = new URLSearchParams(latest.current)
    next.delete('before')
    latest.current = next
    setParams(next, { replace: true })
  }, [setParams])
  const current = useCallback(() => live.current, [])
  return { query, start, change, current, dropStart }
}
