import { useEffectEvent, useLayoutEffect, useRef, type CSSProperties, type MouseEvent } from 'react'
import ColorField from '../style/ColorField'
import { useEscapeKey, usePressAway } from '../style/pressAway'
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
 *  The bar: size, colour, Hide (what Delete does on a keyboard) and More. Two sheets, one open at
 *  a time, each drawn above the dock over the bottom of the photo and positioned against it (they
 *  are inside the dock, not the canvas: every touch on the canvas is cancelled for the gesture
 *  layer). The colour swatch opens the picker as one (`ColorField`'s sheet presentation, rendered
 *  inside the bar; it keeps its own press-away, Escape and commit rules). More opens the other: Rename (what a double-click does with a mouse;
 *  an inline field at the label's on-screen size would be smaller than 16 px and make iOS zoom the
 *  page), then Aliases, Leader, Pin, Reset position and Clear overrides.
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

  // Which sheet is open, for the selection it was opened on: when the selection moves on (a tap
  // on another label), the sheet is simply not open any more, with no effect to reset it.
  const [sheet, setSheet, dropSheet] = useTaggedDraft<'more' | 'color'>([selectedIds])
  const moreOpen = sheet === 'more'

  // Rename is for one label. The draft is tagged with the name it was typed over and with the
  // selection, like the strip's size field: it can never show, or be committed, over another label.
  const only = controls && controls.ids.length === 1 ? controls.ids[0]! : null
  const onlyLabel = only === null ? undefined : labels.get(only)
  const onlyObject = only === null ? undefined : objects.get(only)
  const name = onlyLabel && onlyObject && style ? labelText(onlyObject, onlyLabel, style).primary : ''
  const [typedName, setTypedName, dropName] = useTaggedDraft<string>([name, selectedIds])

  const dockRef = useRef<HTMLDivElement>(null)

  /** Stores a name still in the field, as leaving the field does. */
  const commitName = () => {
    if (only === null || typedName === null) return
    renameLabel(only, typedName, name)
    dropName()
  }
  /** `keepName`: whether a name still being typed is stored on the way out. Everything but
   *  Escape and Clear overrides keeps it; a press on a button never blurs the field (the buttons
   *  refuse the focus), and a mouse press elsewhere unmounts it before a blur could fire. (A press
   *  on the canvas is the gesture layer's: it ends the edit before it moves the selection.) */
  const close = (keepName = true) => {
    if (keepName) commitName()
    else dropName()
    dropSheet()
  }

  usePressAway(dockRef, moreOpen, () => close())

  // Escape closes the sheet wherever the focus is (More refuses the focus, so it is usually
  // still on the page), dropping a name that was being typed.
  useEscapeKey(moreOpen, () => close(false))

  // The dock takes the bottom of the canvas when it appears (the canvas is a flex sibling and
  // gets shorter), and a sheet covers more of it when it opens. Each time, a selection that
  // would be under the new cover is moved up by just enough to show; nothing moves back
  // afterwards (the owner may have panned since). `cover` is what has just taken the canvas's
  // lowest pixels, as many as it is tall: for the dock, the store still holds the canvas's height
  // from before it lost them; a sheet lies over the canvas from where the dock begins.
  const reveal = useEffectEvent((cover: HTMLElement | null) => {
    if (!cover) return
    const s = useEditor.getState()
    const clear = s.viewport.h - cover.getBoundingClientRect().height
    if (clear < MIN_CLEAR) return
    const next = revealAbove(s.view, box.bottom, clear, MARGIN)
    if (next !== s.view) s.setView(next)
  })
  const shown = controls !== null
  useLayoutEffect(() => reveal(dockRef.current), [shown])
  useLayoutEffect(() => reveal(dockRef.current?.querySelector<HTMLElement>('.label-sheet, .color-sheet') ?? null), [sheet])

  if (!controls) return null

  const noFocus = (e: MouseEvent) => e.preventDefault()
  // Neither sheet is ever taller than the canvas it lies over: on a short screen it scrolls instead.
  const sheetCap = { '--sheet-max': `${Math.max(0, canvasHeight - MARGIN)}px` } as CSSProperties

  return (
    <div ref={dockRef} className="label-dock" role="toolbar" aria-label="Selected labels" style={sheetCap}>
      {moreOpen && (
        <div className="label-sheet" role="group" aria-label="More label options">
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
            <span className="label-sheet-value">{controls.pin.value}</span>
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
        <ColorField
          // Remounted, closed, when the selection changes under it with no press to close it (a
          // keyboard undo pruning a multi-selection): the same exit the More sheet takes.
          key={[...selectedIds].join()}
          label="Text colour"
          presentation="sheet"
          {...controls.color}
          // Opening it takes More's place, with a name still being typed stored first; closing
          // (by any of the picker's own routes) frees the place again. The picker cannot be open
          // while More is, so there is nothing to guard here.
          onOpen={() => {
            commitName()
            setSheet('color')
          }}
          onClose={dropSheet}
        />
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
          aria-pressed={moreOpen}
          onMouseDown={noFocus}
          // A press on More while the colour sheet is open is a press outside the picker: it has
          // already closed (committing) by the time this click runs.
          onClick={() => (moreOpen ? close() : setSheet('more'))}
        >
          More
        </button>
      </div>
    </div>
  )
}
