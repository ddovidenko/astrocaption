import { useCallback, useEffect, useState } from 'react'
import { api, describeError, isPageGone, type GalleryItem, type HealthOut, type PageQuery } from '../api'
import { dayLabel } from '../day'
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
  const { query, start, change: changeQuery, current, dropStart } = useListQuery()
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
        // The page a followed Show more link named is gone (its image was unpublished): the
        // cursor leaves the URL, and this effect lists from the top (#227).
        if (isPageGone(err) && start) {
          dropStart()
          return
        }
        // The cards on screen belong to the previous search; leaving them under the error
        // would let Show more append this search's rows to them.
        setItems(null)
        setNext(null)
        setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, start, page, dropStart])

  const showMore = useCallback(async () => {
    if (next === null) return
    setMore({ busy: true, error: null })
    // The URL moved on (a new search) while this page was in flight: the effect owns the list
    // now, and this page belongs to the old search. Dropped, and the link stays for another tap.
    const movedOn = () => current().query !== query
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
      // Only a gone cursor (410) means the list is stale; any other failure is shown as it is.
      if (!isPageGone(err)) {
        setMore({ busy: false, error: describeError(err) })
        return
      }
      // The cursor image was unpublished meanwhile: start over from the page the URL names.
      // When that page is gone as well, the cursor leaves the URL and the effect lists from
      // the top (#227).
      try {
        const result = await api.gallery(page(start))
        if (!movedOn()) {
          setItems(result.items)
          setNext(result.next)
        }
        setMore({ busy: false, error: null })
      } catch (restart) {
        if (movedOn()) {
          setMore({ busy: false, error: null })
        } else if (isPageGone(restart) && start) {
          dropStart()
          setMore({ busy: false, error: null })
        } else {
          setMore({ busy: false, error: describeError(restart) })
        }
      }
    }
  }, [next, start, page, query, current, dropStart])

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
            <time className="day" dateTime={item.created_at}>
              {dayLabel(item.created_at)}
            </time>
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
