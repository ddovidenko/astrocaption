import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, ApiError, describeError, type GalleryItem } from '../api'
import GalleryCard from './GalleryCard'

const NOT_PUBLISHED = 'This image is not published.'

/** One published image at preview size with the same hover swap, plus the download (§ 5.5). */
export default function GalleryImagePage() {
  const { id = '' } = useParams()
  const [item, setItem] = useState<GalleryItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // No reset of item/error at the top: react-hooks/set-state-in-effect forbids calling
    // setState synchronously in the effect body. A param change shows the previous picture
    // until the next one arrives, per the task brief's fallback.
    let cancelled = false
    api
      .galleryImage(id)
      .then((got) => {
        if (!cancelled) {
          setItem(got)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // One 404 covers unpublished, unknown and "gallery off"; the visitor only needs the first.
        setError(err instanceof ApiError && err.status === 404 ? NOT_PUBLISHED : describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const back = <Link to="/gallery">Back to the gallery</Link>
  if (error) {
    return (
      <section className="gallery-view">
        <p className="error">{error}</p>
        <p>{back}</p>
      </section>
    )
  }
  if (!item) return <p className="meta">Loading…</p>
  return (
    <section className="gallery-view">
      <h2>{item.title}</h2>
      <GalleryCard item={item} plain={item.preview_url} annotated={item.annotated_preview_url} />
      <p className="actions">
        <a href={item.export_url}>
          Download annotated image ({item.width} × {item.height})
        </a>
        {back}
      </p>
    </section>
  )
}
