import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import ColorField from '../style/ColorField'
import { ALIAS_OPTIONS, LEADER_OPTIONS, useLabelControls } from './labelControls'
import MixedSelect from './MixedSelect'
import { type Box } from './metrics'
import { useEditor } from './store'
import { toScreen } from './view'

const MARGIN = 8

/** The floating per-label toolbar (SPEC § 6.2, design § A): an HTML overlay above the selection's
 *  union box, positioned through the view transform and kept inside the canvas. Every control
 *  applies to every selected label and commits one history entry per interaction; a control whose
 *  values differ shows blank (the stepper) or "mixed" (the selects). The buttons never take the
 *  focus (`onMouseDown` preventDefault), so the canvas shortcuts keep working after a click.
 *  What the controls do lives in `useLabelControls`; a compact editor lays the same ones out as a
 *  docked bar instead (`LabelDock`, SPEC § 6.5). */
export default function LabelToolbar({
  box,
  onError,
}: {
  box: Box
  /** A toolbar action that failed outright; the canvas shows it as one of its notices. The
   *  toolbar itself has no room for an error line. */
  onError?: (message: string) => void
}) {
  const controls = useLabelControls(onError)
  const style = useEditor((s) => s.style)
  const view = useEditor((s) => s.view)
  const viewport = useEditor((s) => s.viewport)

  // Own size, for the clamping below. Measured after layout and re-measured when what the toolbar
  // shows could have changed width: the trigger is the controls' content signature, not the
  // selected labels themselves (a drag replaces them on every frame, and keying on them would put
  // a `getBoundingClientRect` — a forced layout — in the middle of each one, #105). The size guard
  // keeps a settled measurement from looping.
  const contentKey = controls?.contentKey
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width !== size.w || rect.height !== size.h) setSize({ w: rect.width, h: rect.height })
  }, [size.w, size.h, contentKey, style])

  if (!controls) return null

  // Above the union box, inside the canvas; below it when there is no room above.
  const topLeft = toScreen(view, box.left, box.top)
  const bottomRight = toScreen(view, box.right, box.bottom)
  let top = topLeft.y - size.h - MARGIN
  if (top < MARGIN) top = Math.min(bottomRight.y + MARGIN, Math.max(MARGIN, viewport.h - size.h - MARGIN))
  const left = Math.max(MARGIN, Math.min(topLeft.x, viewport.w - size.w - MARGIN))
  const noFocus = (e: MouseEvent) => e.preventDefault()

  return (
    <div ref={ref} className="label-toolbar" role="toolbar" aria-label="Selected labels" style={{ left, top }}>
      <button type="button" className="secondary" aria-label="Smaller" onMouseDown={noFocus} onClick={() => controls.step(-1)}>
        −
      </button>
      <input {...controls.sizeField} />
      <button type="button" className="secondary" aria-label="Larger" onMouseDown={noFocus} onClick={() => controls.step(1)}>
        +
      </button>
      <ColorField label="Text colour" {...controls.color} />
      <MixedSelect label="Aliases" value={controls.aliases.value} options={ALIAS_OPTIONS} onChange={controls.aliases.onChange} />
      <MixedSelect label="Leader" value={controls.leader.value} options={LEADER_OPTIONS} onChange={controls.leader.onChange} />
      <button
        type="button"
        className="secondary"
        aria-pressed={controls.pin.pressed}
        title="A pinned label keeps its place when the layout is auto-arranged"
        onMouseDown={noFocus}
        onClick={controls.pin.toggle}
      >
        {controls.pin.label}
      </button>
      <button
        type="button"
        className="secondary"
        title="Place again with the placer and unpin"
        onMouseDown={noFocus}
        onClick={controls.resetPosition}
      >
        Reset position
      </button>
      <button
        type="button"
        className="secondary"
        title="Back to the global size, colour, aliases, leader and name"
        onMouseDown={noFocus}
        onClick={controls.clearOverrides}
      >
        Clear overrides
      </button>
    </div>
  )
}
