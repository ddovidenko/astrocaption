import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { readListQuery, writeListQuery, type ListQuery } from './listQuery'

/** The list page's search and chips, read from the URL and written back with history replace
 *  (SPEC § 5.5: the URL is their only home). `change` takes a patch and merges it onto the URL
 *  as it is when the patch lands, not as it was when the caller rendered: the debounced search
 *  box fires after a chip pressed inside its pause has already changed the URL, and the search
 *  must land on top of that press. `current` answers the same question for anything else that
 *  outlives its render (a card action's refresh, an upload, a Show more page in flight): the
 *  query the URL names now. `params` is memoised on `location.search`, so `query`'s identity
 *  changes only when the URL does, and `current() !== query` means "the URL moved on". */
export function useListQuery(): [ListQuery, (patch: Partial<ListQuery>) => void, () => ListQuery] {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => readListQuery(params), [params])
  const latest = useRef(params)
  const live = useRef(query)
  useEffect(() => {
    latest.current = params
    live.current = query
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
  const current = useCallback(() => live.current, [])
  return [query, change, current]
}
