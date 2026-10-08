import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, describeError, type GalleryItem, type HealthOut } from '../api'
import GalleryCard from './GalleryCard'
import ShowMore from './ShowMore'

/** The public gallery (SPEC § 5.5): published images newest first, 24 at a time with Show more,
 *  hover to see the annotations. The same page serves the owner at /gallery, so what they see is
 *  what visitors see. With the gallery switched off it never calls the API: the shell already
 *  knows. A `?before=` in the URL (a followed Show more link) starts from that page. */
export default function GalleryPage({ health }: { health: HealthOut }) {
  const enabled = health.public_gallery_enabled
  const [params] = useSearchParams()
  const start = params.get('before')
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api
      .gallery({ before: start })
      .then((page) => {
        if (cancelled) return
        setItems(page.items)
        setNext(page.next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, start])

  const showMore = useCallback(async () => {
    if (next === null) return
    setMore({ busy: true, error: null })
    try {
      const page = await api.gallery({ before: next })
      setItems((shown) => [...(shown ?? []), ...page.items])
      setNext(page.next)
      setMore({ busy: false, error: null })
    } catch (err) {
      // The cursor image was unpublished meanwhile: the list is stale, start it over from the
      // page the URL names, or from the top when that cursor is gone as well.
      if (err instanceof ApiError && err.status === 422) {
        const page = await api
          .gallery({ before: start })
          .catch(() => (start ? api.gallery() : null))
          .catch(() => null)
        if (page) {
          setItems(page.items)
          setNext(page.next)
          setMore({ busy: false, error: null })
          return
        }
      }
      setMore({ busy: false, error: describeError(err) })
    }
  }, [next, start])

  if (!enabled) {
    return (
      <section className="gallery-off">
        {!health.authenticated && <p className="meta">Nothing to see here yet.</p>}
        {health.authenticated && <p className="meta">The public gallery is switched off in Config.</p>}
      </section>
    )
  }
  if (error) return <p className="error">{error}</p>
  if (items === null) return <p className="meta">Loading…</p>
  if (items.length === 0) return <p className="gallery-empty">Nothing published yet.</p>
  return (
    <>
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
      <ShowMore next={next} busy={more.busy} error={more.error} onMore={() => void showMore()} />
    </>
  )
}
