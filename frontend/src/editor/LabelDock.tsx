import { useEffect, useEffectEvent, useLayoutEffect, useRef, type MouseEvent } from 'react'
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
/** The least of the canvas a sheet must leave uncovered for moving the selection into it to be
 *  worth doing; under this (a phone on its side) the sheet scrolls and the photo stays put. */
const MIN_CLEAR = 48

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
  const canvasHeight = useEditor((s) => s.viewport.h)

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

  // The name in the field right now, for the one way out that no handler below sees: the
  // selection moving on under it. A mouse press on another label selects that label before the
  // press reaches anything here, and by then this render's draft is already derived away.
  const pending = useRef<{ id: number; text: string; name: string } | null>(null)
  useEffect(() => {
    pending.current = only !== null && typedName !== null ? { id: only, text: typedName, name } : null
  })
  useEffect(
    () => () => {
      // Runs before the effect above has caught up with the new selection, so this is still the
      // old one's name. Only for a label that is still there: one an undo took away, or a document
      // that turned read-only, gets nothing written on top of it.
      const left = pending.current
      pending.current = null
      if (left && useEditor.getState().labels.get(left.id)?.enabled) renameLabel(left.id, left.text, left.name)
    },
    [selectedIds],
  )

  /** Stores a name still in the field, as leaving the field does. */
  const commitName = () => {
    pending.current = null
    if (only === null || typedName === null) return
    renameLabel(only, typedName, name)
    dropName()
  }
  /** `keepName`: whether a name still being typed is stored on the way out. Everything but
   *  Escape and Clear overrides keeps it; a press on a button never blurs the field (the buttons
   *  refuse the focus), and a mouse press elsewhere unmounts it before a blur could fire. */
  const close = (keepName = true) => {
    if (keepName) commitName()
    else {
      pending.current = null
      dropName()
    }
    dropOpened()
  }

  usePressAway(dockRef, open, () => close())

  // Escape closes the sheet wherever the focus is: More refuses the focus, so it is usually still
  // on the page. On the document, like the colour picker's, so it is heard before the canvas's
  // own listener on the window, which would clear the selection in the same keystroke; and both
  // close together when both are open.
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    close(false)
  })
  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [open])

  // The dock takes the bottom of the canvas when it appears (the canvas is a flex sibling and
  // gets shorter), and the sheet covers more of it when it opens. Each time, a selection that
  // would be under it is moved up by just enough to show; nothing moves back afterwards (the
  // owner may have panned since). `covered` is how much of the canvas, as the store knows it, is
  // or is about to be out of sight at the bottom.
  const reveal = (covered: number) => {
    const s = useEditor.getState()
    if (s.viewport.h - covered < MIN_CLEAR) return
    const next = revealAbove(s.view, box.bottom, s.viewport.h - covered, MARGIN)
    if (next !== s.view) s.setView(next)
  }
  // On appearing, the store still holds the canvas's height from before it lost the dock's.
  const onAppear = useEffectEvent(() => {
    if (dockRef.current) reveal(dockRef.current.getBoundingClientRect().height)
  })
  const shown = controls !== null
  useLayoutEffect(() => {
    if (shown) onAppear()
  }, [shown])
  // The sheet lies over the canvas's lowest `height` pixels: the canvas ends where the dock begins.
  const onOpen = useEffectEvent(() => {
    if (sheetRef.current) reveal(sheetRef.current.getBoundingClientRect().height)
  })
  useLayoutEffect(() => {
    if (open) onOpen()
  }, [open])

  if (!controls) return null

  const noFocus = (e: MouseEvent) => e.preventDefault()
  const pinState = controls.pin.mixed ? 'mixed' : controls.pin.pressed ? 'on' : 'off'

  return (
    <div ref={dockRef} className="label-dock" role="toolbar" aria-label="Selected labels">
      {open && (
        <div
          ref={sheetRef}
          className="label-sheet"
          role="group"
          aria-label="More label options"
          // Never taller than the canvas it lies over: on a short screen it scrolls instead.
          style={{ maxHeight: Math.max(0, canvasHeight - MARGIN) }}
        >
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
            <MixedSelect bare label="Aliases" value={controls.aliases.value} options={ALIAS_OPTIONS} onChange={controls.aliases.onChange} />
          </label>
          <label className="label-sheet-row">
            <span>Leader</span>
            <MixedSelect bare label="Leader" value={controls.leader.value} options={LEADER_OPTIONS} onChange={controls.leader.onChange} />
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
        <button
          type="button"
          className="secondary"
          onMouseDown={noFocus}
          onClick={() => {
            // What was still being typed first: Hide refuses the focus, so no field has blurred,
            // and the label should come back from an Undo the way it was left.
            commitName()
            controls.commitSize()
            disableAll(controls.ids)
          }}
        >
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
