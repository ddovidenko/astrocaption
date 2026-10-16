import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, describeError, type GalleryItem, type HealthOut, type PageQuery } from '../api'
import GalleryCard from './GalleryCard'
import ListFilters from './ListFilters'
import { isFiltered, toPageQuery } from './listQuery'
import ShowMore from './ShowMore'
import { useListQuery } from './useListQuery'

/** The public gallery (SPEC § 5.5): published images newest first, 24 at a time with Show more,
 *  hover to see the annotations. The same page serves the owner at /gallery, so what they see is
 *  what visitors see. With the gallery switched off it never calls the API: the shell already
 *  knows. The URL holds the search (`?q=`) and a followed Show more link's `?before=`; a
 *  typed search replaces the URL (no history entry per keystroke) and drops the cursor. */
export default function GalleryPage({ health }: { health: HealthOut }) {
  const enabled = health.public_gallery_enabled
  const [params] = useSearchParams()
  const start = params.get('before')
  const [query, changeQuery, currentQuery] = useListQuery()
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
    // The URL moved on (a new search) while this page was in flight: the effect owns the list
    // now, and this page belongs to the old search. Dropped, and the link stays for another tap.
    const movedOn = () => currentQuery() !== query
    try {
      const result = await api.gallery(page(next))
      if (movedOn()) {
        setMore({ busy: false, error: null })
        return
      }
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
        if (movedOn()) {
          setMore({ busy: false, error: null })
          return
        }
        if (result) {
          setItems(result.items)
          setNext(result.next)
          setMore({ busy: false, error: null })
          return
        }
      }
      setMore({ busy: false, error: describeError(err) })
    }
  }, [next, start, page, query, currentQuery])

  if (!enabled) {
    return (
      <section className="gallery-off">
        {!health.authenticated && <p className="meta">Nothing to see here yet.</p>}
        {health.authenticated && <p className="meta">The public gallery is switched off in Config.</p>}
      </section>
    )
  }
  const body = () => {
    if (error) return <p className="error">{error}</p>
    if (items === null) return <p className="meta">Loading…</p>
    if (items.length === 0) {
      return <p className="gallery-empty">{isFiltered(query) ? 'Nothing matches.' : 'Nothing published yet.'}</p>
    }
    return (
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
    )
  }
  return (
    <>
      <ListFilters query={query} onChange={changeQuery} label="Search the gallery" />
      {body()}
      <ShowMore next={next} busy={more.busy} error={more.error} onMore={() => void showMore()} query={query} />
    </>
  )
}
