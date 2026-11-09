import { useEffectEvent, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import ColorField from '../style/ColorField'
import { usePressAway } from '../style/pressAway'
import { disableAll, renameLabel } from './editing'
import { ALIAS_OPTIONS, LEADER_OPTIONS, useLabelControls } from './labelControls'
import { labelText, type Box } from './metrics'
import MixedSelect from './MixedSelect'
import { useEditor } from './store'
import { useTaggedDraft } from './taggedDraft'
import { revealAbove } from './view'

const MARGIN = 8

/** The per-label controls of a compact editor (SPEC § 6.5): a short bar docked under the photo,
 *  and a sheet above it for what does not fit. The floating strip (`LabelToolbar`) is wider than a
 *  phone and sits where a finger is working; this is the same model (`useLabelControls`), so every
 *  control applies to every selected label and is one undo entry, laid out for a thumb.
 *
 *  The bar: size, colour, Hide (what Delete does on a keyboard) and More. The sheet: Rename (what
 *  a double-click does with a mouse; an inline field at the label's on-screen size would be
 *  smaller than 16 px and make iOS zoom the page), then Aliases, Leader, Pin, Reset position and
 *  Clear overrides. It is a child of the dock, drawn above it over the bottom of the photo, not a
 *  child of the canvas: every touch on the canvas is cancelled for the gesture layer.
 *
 *  `box` is the selection's union box in original pixels, as the strip receives it. */
export default function LabelDock({
  box,
  onError,
}: {
  box: Box
  /** An action that failed outright; the canvas shows it as one of its notices. */
  onError?: (message: string) => void
}) {
  const controls = useLabelControls(onError)
  const selectedIds = useEditor((s) => s.selectedIds)
  const labels = useEditor((s) => s.labels)
  const objects = useEditor((s) => s.objects)
  const style = useEditor((s) => s.style)

  // Open for the selection it was opened on: when the selection moves on (a tap on another
  // label), the sheet is simply not open any more, with no effect to reset it.
  const [opened, setOpened, dropOpened] = useTaggedDraft<true>([selectedIds])
  const open = opened !== null

  // Rename is for one label. The draft is tagged with the name it was typed over and with the
  // selection, like the strip's size field: it can never show, or be committed, over another label.
  const only = controls && controls.ids.length === 1 ? controls.ids[0]! : null
  const onlyLabel = only === null ? undefined : labels.get(only)
  const onlyObject = only === null ? undefined : objects.get(only)
  const name =
    onlyLabel && onlyObject && style ? (onlyLabel.text_override ?? labelText(onlyObject, onlyLabel, style).primary) : ''
  const [typedName, setTypedName, dropName] = useTaggedDraft<string>([name, selectedIds])

  const dockRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  /** Stores a name still in the field. A refused one (the document turned read-only) stays in
   *  the field rather than vanishing as though it had stuck. */
  const commitName = () => {
    if (only === null || typedName === null) return
    if (renameLabel(only, typedName, name) !== 'refused') dropName()
  }
  /** `keepName`: whether a name still being typed is stored on the way out. Everything but
   *  Escape and Clear overrides keeps it; a press on a button never blurs the field (the buttons
   *  refuse the focus), and a mouse press elsewhere unmounts it before a blur could fire. */
  const close = (keepName = true) => {
    if (keepName) commitName()
    else dropName()
    dropOpened()
  }

  usePressAway(dockRef, open, () => close())

  // Opening the sheet covers the bottom of the photo. If the selection is under it, the photo
  // moves up by just enough to show it; it does not move back on closing (the owner may have
  // panned since). The canvas ends where the dock begins, so the sheet covers its lowest
  // `height` pixels.
  const reveal = useEffectEvent(() => {
    const el = sheetRef.current
    if (!el) return
    const s = useEditor.getState()
    const next = revealAbove(s.view, box.bottom, s.viewport.h - el.getBoundingClientRect().height, MARGIN)
    if (next !== s.view) s.setView(next)
  })
  useLayoutEffect(() => {
    if (open) reveal()
  }, [open])

  if (!controls) return null

  const noFocus = (e: MouseEvent) => e.preventDefault()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return
    // Spent here: the canvas's own Escape would clear the selection in the same keystroke.
    e.stopPropagation()
    close(false)
  }
  const pinState = controls.pin.mixed ? 'mixed' : controls.pin.pressed ? 'on' : 'off'

  return (
    <div ref={dockRef} className="label-dock" role="toolbar" aria-label="Selected labels" onKeyDown={onKeyDown}>
      {open && (
        <div ref={sheetRef} className="label-sheet" role="group" aria-label="More label options">
          {only !== null && (
            <label className="label-sheet-row">
              <span>Rename</span>
              <input
                type="text"
                aria-label="Rename"
                value={typedName ?? name}
                onChange={(e) => setTypedName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  commitName()
                }}
              />
            </label>
          )}
          <label className="label-sheet-row">
            <span>Aliases</span>
            <MixedSelect label="Aliases" value={controls.aliases.value} options={ALIAS_OPTIONS} onChange={controls.aliases.onChange} />
          </label>
          <label className="label-sheet-row">
            <span>Leader</span>
            <MixedSelect label="Leader" value={controls.leader.value} options={LEADER_OPTIONS} onChange={controls.leader.onChange} />
          </label>
          <button
            type="button"
            className="label-sheet-row"
            aria-label="Pin in place"
            aria-pressed={controls.pin.pressed}
            title="A pinned label keeps its place when the layout is auto-arranged"
            onMouseDown={noFocus}
            onClick={controls.pin.toggle}
          >
            <span>Pin in place</span>
            <span className="label-sheet-value">{pinState}</span>
          </button>
          <button
            type="button"
            className="label-sheet-row"
            title="Place again with the placer and unpin"
            onMouseDown={noFocus}
            onClick={() => {
              close()
              controls.resetPosition()
            }}
          >
            Reset position
          </button>
          <button
            type="button"
            className="label-sheet-row"
            title="Back to the global size, colour, aliases, leader and name"
            onMouseDown={noFocus}
            onClick={() => {
              // The name goes back to the catalogue's with the rest: one typed here is dropped.
              close(false)
              controls.clearOverrides()
            }}
          >
            Clear overrides
          </button>
        </div>
      )}
      <div className="label-dock-bar">
        <span className="label-dock-stepper">
          <button type="button" className="secondary" aria-label="Smaller" onMouseDown={noFocus} onClick={() => controls.step(-1)}>
            −
          </button>
          <input {...controls.sizeField} />
          <button type="button" className="secondary" aria-label="Larger" onMouseDown={noFocus} onClick={() => controls.step(1)}>
            +
          </button>
        </span>
        <ColorField label="Text colour" {...controls.color} />
        <span className="label-dock-gap" />
        <button type="button" className="secondary" onMouseDown={noFocus} onClick={() => disableAll(controls.ids)}>
          Hide
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={open}
          onMouseDown={noFocus}
          onClick={() => (open ? close() : setOpened(true))}
        >
          More
        </button>
      </div>
    </div>
  )
}
