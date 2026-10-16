import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, describeError, type GalleryItem, type HealthOut, type PageQuery } from '../api'
import GalleryCard from './GalleryCard'
import ListFilters from './ListFilters'
import { isFiltered, readListQuery, toPageQuery, writeListQuery, type ListQuery } from './listQuery'
import ShowMore from './ShowMore'

/** The public gallery (SPEC § 5.5): published images newest first, 24 at a time with Show more,
 *  hover to see the annotations. The same page serves the owner at /gallery, so what they see is
 *  what visitors see. With the gallery switched off it never calls the API: the shell already
 *  knows. The URL holds the search (`?q=`) and a followed Show more link's `?before=`; a
 *  typed search replaces the URL (no history entry per keystroke) and drops the cursor. */
export default function GalleryPage({ health }: { health: HealthOut }) {
  const enabled = health.public_gallery_enabled
  const [params, setParams] = useSearchParams()
  const start = params.get('before')
  // `readListQuery` builds a fresh object per render; round-tripping it through one string
  // gives an identity that changes only when the query does, safe as an effect dependency.
  const queryKey = JSON.stringify(readListQuery(params))
  const query = useMemo(() => JSON.parse(queryKey) as ListQuery, [queryKey])
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })

  const page = useCallback((before: string | null): PageQuery => ({ ...toPageQuery(query), before }), [query])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api
      .gallery(page(start))
      .then((result) => {
        if (cancelled) return
        setItems(result.items)
        setNext(result.next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // The cards on screen belong to the previous search; leaving them under the error
        // would let Show more append this search's rows to them.
        setItems(null)
        setNext(null)
        setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, start, page])

  const showMore = useCallback(async () => {
    if (next === null) return
    setMore({ busy: true, error: null })
    try {
      const result = await api.gallery(page(next))
      setItems((shown) => [...(shown ?? []), ...result.items])
      setNext(result.next)
      setMore({ busy: false, error: null })
    } catch (err) {
      // The cursor image was unpublished meanwhile: the list is stale, start it over from the
      // page the URL names, or from the top when that cursor is gone as well.
      if (err instanceof ApiError && err.status === 422) {
        const result = await api
          .gallery(page(start))
          .catch(() => (start ? api.gallery(page(null)) : null))
          .catch(() => null)
        if (result) {
          setItems(result.items)
          setNext(result.next)
          setMore({ busy: false, error: null })
          return
        }
      }
      setMore({ busy: false, error: describeError(err) })
    }
  }, [next, start, page])

  const changeQuery = useCallback(
    (nextQuery: ListQuery) => setParams(writeListQuery(params, nextQuery), { replace: true }),
    [params, setParams],
  )

  if (!enabled) {
    return (
      <section className="gallery-off">
        {!health.authenticated && <p className="meta">Nothing to see here yet.</p>}
        {health.authenticated && <p className="meta">The public gallery is switched off in Config.</p>}
      </section>
    )
  }
  return (
    <>
      <ListFilters query={query} onChange={changeQuery} label="Search the gallery" />
      {error && <p className="error">{error}</p>}
      {!error && items === null && <p className="meta">Loading…</p>}
      {!error && items !== null && items.length === 0 && (
        <p className="gallery-empty">{isFiltered(query) ? 'Nothing matches.' : 'Nothing published yet.'}</p>
      )}
      {items !== null && items.length > 0 && (
        <section className="gallery" aria-label="Gallery">
          {items.map((item) => (
            <GalleryCard
              key={item.id}
              item={item}
              plain={item.thumb_url}
              annotated={item.annotated_preview_url}
              to={`/gallery/${item.id}`}
              frame="uniform"
            >
              {item.title}
            </GalleryCard>
          ))}
        </section>
      )}
      <ShowMore next={next} busy={more.busy} error={more.error} onMore={() => void showMore()} query={query} />
    </>
  )
}
