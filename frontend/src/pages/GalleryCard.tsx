import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { GalleryItem } from '../api'

/** True on a touch-first device, where hover does not exist and a tap has to do its job. */
export function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/** The gallery's hover-to-reveal picture (SPEC § 5.5): `plain` underneath, `annotated` on top,
 *  faded in while a mouse hovers. On a touch screen the first tap reveals and, when the card is
 *  a link, the second tap follows it; without a link a tap simply toggles. Both bitmaps keep the
 *  same box, so the swap never reflows the grid. */
export default function GalleryCard({
  item,
  plain,
  annotated,
  to,
  children,
}: {
  item: GalleryItem
  plain: string
  annotated: string
  to?: string
  children?: ReactNode
}) {
  const [revealed, setRevealed] = useState(false)

  const onPointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') setRevealed(true)
  }
  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') setRevealed(false)
  }
  const onClick = (e: React.MouseEvent) => {
    if (!isCoarsePointer()) return
    if (to && revealed) return // second tap: let the link navigate
    e.preventDefault()
    setRevealed((r) => !r)
  }

  const picture = (
    <figure className="gallery-picture" style={{ aspectRatio: `${item.width} / ${item.height}` }}>
      <img src={plain} alt={item.title} loading="lazy" />
      <img
        className={revealed ? 'overlay revealed' : 'overlay'}
        src={annotated}
        alt={`${item.title}, annotated`}
        loading="lazy"
      />
      {children && <figcaption>{children}</figcaption>}
    </figure>
  )
  const handlers = { onPointerEnter, onPointerLeave, onClick }
  return to ? (
    <Link className="gallery-card" to={to} {...handlers}>
      {picture}
    </Link>
  ) : (
    <div className="gallery-card" {...handlers}>
      {picture}
    </div>
  )
}
