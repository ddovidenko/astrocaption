import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { GalleryItem } from '../api'
import { isCoarsePointer } from './pointer'

/** The gallery's hover-to-reveal picture (SPEC § 5.5): `plain` underneath, `annotated` on top,
 *  faded in while a mouse hovers. On a touch screen the first tap reveals and, when the card is
 *  a link, the second tap follows it; without a link a tap simply toggles. Both bitmaps keep the
 *  same box, so the swap never reflows the grid. `frame` picks the box's aspect ratio: `'image'`
 *  (the default, used by the single-image view) uses the item's own width/height so the box
 *  matches the picture; `'uniform'` (used by the grid) leaves no inline aspect ratio and lets the
 *  CSS give every card the same box, with a portrait picture letterboxed inside on the black
 *  background rather than making its card taller than its neighbours. */
export default function GalleryCard({
  item,
  plain,
  annotated,
  to,
  frame = 'image',
  children,
}: {
  item: GalleryItem
  plain: string
  annotated: string
  to?: string
  frame?: 'uniform' | 'image'
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
    <figure className="gallery-picture">
      <div className="gallery-frame" style={frame === 'image' ? { aspectRatio: `${item.width} / ${item.height}` } : undefined}>
        <img src={plain} alt={item.title} loading="lazy" />
        <img
          className={revealed ? 'overlay revealed' : 'overlay'}
          src={annotated}
          alt={`${item.title}, annotated`}
          loading="lazy"
        />
      </div>
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
