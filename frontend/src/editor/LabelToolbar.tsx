import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Label, LeaderMode } from '../api'
import ColorField from '../style/ColorField'
import { isEditable, resetPositions } from './editing'
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type Box } from './metrics'
import { useEditor } from './store'
import { toScreen } from './view'

const MARGIN = 8
const MIXED = 'mixed'

/** One value when every selected label agrees, MIXED otherwise. */
function common<T>(labels: Label[], pick: (l: Label) => T): T | typeof MIXED {
  const first = pick(labels[0]!)
  return labels.every((l) => pick(l) === first) ? first : MIXED
}

/** The floating per-label toolbar (SPEC § 6.2, design § A): an HTML overlay above the selection's
 *  union box, positioned through the view transform and kept inside the canvas. Every control
 *  applies to every selected label and commits one history entry per interaction; a control whose
 *  values differ shows blank (the stepper) or "mixed" (the selects). The buttons never take the
 *  focus (`onMouseDown` preventDefault), so the canvas shortcuts keep working after a click. */
export default function LabelToolbar({ box }: { box: Box }) {
  const selectedIds = useEditor((s) => s.selectedIds)
  const labels = useEditor((s) => s.labels)
  const style = useEditor((s) => s.style)
  const view = useEditor((s) => s.view)
  const viewport = useEditor((s) => s.viewport)
  const editable = useEditor(isEditable)

  const selected = useMemo(
    () => [...selectedIds].map((id) => labels.get(id)).filter((l): l is Label => l !== undefined && l.enabled),
    [selectedIds, labels],
  )

  // Own size, for the clamping below. Measured after layout and re-measured when what the toolbar
  // shows could have changed width: `selected` drives the pin label and the "mixed" options,
  // `style` the size placeholder. The guard keeps a settled measurement from looping.
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width !== size.w || rect.height !== size.h) setSize({ w: rect.width, h: rect.height })
  }, [size.w, size.h, selected, style])

  // The size field is a draft: committed on Enter or blur, reverted on an invalid value. It
  // follows the selection: a new selection (or an undo) shows the stored value again. The draft
  // carries what it was typed against instead of being reset from an effect
  // (react-hooks/set-state-in-effect): once the selection or the stored size moves on, the draft
  // is stale and the stored value shows again, with no extra render.
  const fontSize = selected.length > 0 ? common(selected, (l) => l.font_size) : MIXED
  const shownSize = fontSize === MIXED || fontSize === null ? '' : String(fontSize)
  const [typed, setTyped] = useState<{ from: string; ids: ReadonlySet<number>; text: string } | null>(null)
  const draft = typed && typed.from === shownSize && typed.ids === selectedIds ? typed.text : shownSize
  const setDraft = (text: string) => setTyped({ from: shownSize, ids: selectedIds, text })

  if (!style || !editable || selected.length === 0) return null

  const ids = selected.map((l) => l.object_id)
  const update = useEditor.getState().updateLabels

  const commitSize = () => {
    const text = draft.trim()
    if (text === '') {
      update(ids, { font_size: null })
      return
    }
    const n = Number(text)
    if (!Number.isInteger(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) {
      setTyped(null) // back to the stored value
      return
    }
    update(ids, { font_size: n })
  }
  const step = (delta: number) => {
    const s = useEditor.getState()
    // One commit for the set: each label steps from its own effective size.
    const updated = selected.map((l) => ({
      ...l,
      font_size: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, (l.font_size ?? s.style!.font_size) + delta)),
    }))
    s.applyLabels(updated)
  }

  const color = common(selected, (l) => l.color)
  const aliases = common(selected, (l) => l.show_aliases)
  const leader = common(selected, (l) => l.leader)
  const pinned = common(selected, (l) => l.pinned)
  const pinLabel = pinned === MIXED ? 'Pin (mixed)' : pinned ? 'Pinned' : 'Pin'

  // Above the union box, inside the canvas; below it when there is no room above.
  const topLeft = toScreen(view, box.left, box.top)
  const bottomRight = toScreen(view, box.right, box.bottom)
  let top = topLeft.y - size.h - MARGIN
  if (top < MARGIN) top = Math.min(bottomRight.y + MARGIN, Math.max(MARGIN, viewport.h - size.h - MARGIN))
  const left = Math.max(MARGIN, Math.min(topLeft.x, viewport.w - size.w - MARGIN))
  const noFocus = (e: MouseEvent) => e.preventDefault()

  return (
    <div ref={ref} className="label-toolbar" role="toolbar" aria-label="Selected labels" style={{ left, top }}>
      <button type="button" className="secondary" aria-label="Smaller" onMouseDown={noFocus} onClick={() => step(-1)}>
        −
      </button>
      <input
        type="number"
        aria-label="Font size"
        min={MIN_FONT_SIZE}
        max={MAX_FONT_SIZE}
        placeholder={String(style.font_size)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitSize}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitSize()
            e.currentTarget.blur()
          }
        }}
      />
      <button type="button" className="secondary" aria-label="Larger" onMouseDown={noFocus} onClick={() => step(1)}>
        +
      </button>
      {/* A picker *drag* changes the draft only (`onChange` is a no-op here) and the popover's
          close carries no hex, so a drag alone commits nothing: without a draft to hand back on
          close, the toolbar commits only what it can name — a typed hex and "Use default". */}
      <ColorField
        label="Text colour"
        value={color === MIXED ? '' : (color ?? '')}
        fallback={style.text_color}
        onChange={() => {}}
        onCommit={(hex) => {
          if (hex !== undefined) update(ids, { color: hex })
        }}
        onClear={() => update(ids, { color: null })}
      />
      <select
        aria-label="Aliases"
        value={aliases === MIXED ? MIXED : aliases === null ? 'inherit' : aliases ? 'on' : 'off'}
        onChange={(e) => {
          const v = e.target.value
          update(ids, { show_aliases: v === 'inherit' ? null : v === 'on' })
        }}
      >
        {aliases === MIXED && (
          <option value={MIXED} disabled>
            Aliases: mixed
          </option>
        )}
        <option value="inherit">Aliases: inherit</option>
        <option value="on">Aliases: on</option>
        <option value="off">Aliases: off</option>
      </select>
      <select aria-label="Leader" value={leader} onChange={(e) => update(ids, { leader: e.target.value as LeaderMode })}>
        {leader === MIXED && (
          <option value={MIXED} disabled>
            Leader: mixed
          </option>
        )}
        <option value="auto">Leader: auto</option>
        <option value="on">Leader: on</option>
        <option value="off">Leader: off</option>
      </select>
      <button
        type="button"
        className="secondary"
        aria-pressed={pinned === true}
        title="A pinned label keeps its place when the layout is auto-arranged"
        onMouseDown={noFocus}
        onClick={() => update(ids, { pinned: pinned !== true })}
      >
        {pinLabel}
      </button>
      <button
        type="button"
        className="secondary"
        title="Place again with the placer and unpin"
        onMouseDown={noFocus}
        onClick={() => resetPositions(ids)}
      >
        Reset position
      </button>
      <button
        type="button"
        className="secondary"
        title="Back to the global size, colour, aliases, leader and name"
        onMouseDown={noFocus}
        onClick={() => update(ids, { font_size: null, color: null, show_aliases: null, leader: 'auto', text_override: null })}
      >
        Clear overrides
      </button>
    </div>
  )
}
