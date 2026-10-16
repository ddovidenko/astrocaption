import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { readListQuery, writeListQuery, type ListQuery } from './listQuery'

/** The list page's search and chips, read from the URL and written back with history replace
 *  (SPEC § 5.5: the URL is their only home). `change` takes a patch and merges it onto the URL
 *  as it is when the patch lands, not as it was when the caller rendered: the debounced search
 *  box fires after a chip pressed inside its pause has already changed the URL, and the search
 *  must land on top of that press. (`params` is memoised on `location.search`, so `query`'s
 *  identity changes only when the URL does.) */
export function useListQuery(): [ListQuery, (patch: Partial<ListQuery>) => void] {
  const [params, setParams] = useSearchParams()
  const query = useMemo(() => readListQuery(params), [params])
  const latest = useRef(params)
  useEffect(() => {
    latest.current = params
  })
  const change = useCallback(
    (patch: Partial<ListQuery>) => {
      const current = latest.current
      setParams(writeListQuery(current, { ...readListQuery(current), ...patch }), { replace: true })
    },
    [setParams],
  )
  return [query, change]
}
