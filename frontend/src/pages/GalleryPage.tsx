import { useEffect, useState } from 'react'
import { api, describeError, type GalleryItem, type HealthOut } from '../api'
import GalleryCard from './GalleryCard'

/** The public gallery (SPEC § 5.5): published images newest first, hover to see the
 *  annotations. The same page serves the owner at /gallery, so what they see is what visitors
 *  see. With the gallery switched off it never calls the API: the shell already knows. */
export default function GalleryPage({ health }: { health: HealthOut }) {
  const enabled = health.public_gallery_enabled
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api
      .gallery()
      .then((list) => {
        if (!cancelled) setItems(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

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
