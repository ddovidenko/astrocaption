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
export default function LabelToolbar({
  box,
  onError,
}: {
  box: Box
  /** A toolbar action that failed outright; the canvas shows it as one of its notices. The
   *  toolbar itself has no room for an error line. */
  onError?: (message: string) => void
}) {
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
  // `style` the size placeholder, and `editable` whether there is anything to measure at all.
  // The guard keeps a settled measurement from looping.
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width !== size.w || rect.height !== size.h) setSize({ w: rect.width, h: rect.height })
  }, [size.w, size.h, selected, style, editable])

  // The size field is a draft: committed on Enter or blur, reverted on an invalid value. Rather
  // than being reset from an effect (react-hooks/set-state-in-effect) it carries the selection and
  // the stored size it was typed against, so it goes stale — and the stored value shows again —
  // the moment either moves on. Every path that acts on the draft drops it (`setTyped(null)`),
  // because the tag alone cannot: an undo that puts the stored size back where the draft started
  // would match the tag again and revive a draft the owner has already committed and undone.
  const fontSize = selected.length > 0 ? common(selected, (l) => l.font_size) : MIXED
  const shownSize = fontSize === MIXED || fontSize === null ? '' : String(fontSize)
  const [typed, setTyped] = useState<{ from: string; ids: ReadonlySet<number>; text: string } | null>(null)
  const draft = typed && typed.from === shownSize && typed.ids === selectedIds ? typed.text : shownSize
  const setDraft = (text: string) => setTyped({ from: shownSize, ids: selectedIds, text })

  // The colour is a draft too, tagged the same way, so the picker surface follows the pointer
  // while a drag is in flight and only the close commits it (StyleTab's shape).
  const color = selected.length > 0 ? common(selected, (l) => l.color) : MIXED
  const shownColor = color === MIXED ? '' : (color ?? '')
  const [picked, setPicked] = useState<{ from: string; ids: ReadonlySet<number>; hex: string } | null>(null)
  const colorDraft = picked && picked.from === shownColor && picked.ids === selectedIds ? picked.hex : null
  // Set by "Use default", consumed by the close that ColorField fires right after it (see onCommit).
  const clearedRef = useRef(false)

  if (!style || !editable || selected.length === 0) return null

  const ids = selected.map((l) => l.object_id)
  const update = useEditor.getState().updateLabels

  const commitSize = () => {
    // Nothing was typed against what the field already shows (a focus and a blur, say): there is
    // no edit to commit. Without this, a blur on a mixed selection — whose field shows blank
    // because the sizes differ, not because anyone cleared it — would read as a clear and wipe
    // every override in the selection.
    if (draft === shownSize) {
      setTyped(null)
      return
    }
    const text = draft.trim()
    // Committed, reverted or ignored, the draft is spent either way: the field goes back to
    // mirroring the store.
    setTyped(null)
    if (text === '') {
      update(ids, { font_size: null })
      return
    }
    const n = Number(text)
    if (!Number.isInteger(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) return
    update(ids, { font_size: n })
  }
  const step = (delta: number) => {
    // The stepper acts on the stored sizes, so a draft typed against them is spent — and a draft
    // left standing would keep showing over a `shownSize` that stays blank on a mixed selection.
    setTyped(null)
    const s = useEditor.getState()
    // One commit for the set: each label steps from its own effective size.
    const updated = selected.map((l) => ({
      ...l,
      font_size: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, (l.font_size ?? s.style!.font_size) + delta)),
    }))
    // At the clamp every label already holds the size it would step to. `applyLabels` has no
    // same-value dedupe of its own, so committing here would be an undo entry and a save for a
    // click that changed nothing.
    if (updated.every((l, i) => l.font_size === selected[i]!.font_size)) return
    s.applyLabels(updated)
  }

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
        onChange={(e) => {
          // Chromium reports an empty value for a number input holding something it cannot parse
          // ('e', a lone '-'), with `badInput` set. Reading that as a cleared field would wipe the
          // selection's size overrides on a keystroke; keeping the last draft leaves the typing
          // where it was.
          if (e.target.validity.badInput) return
          setDraft(e.target.value)
        }}
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
      {/* A drag only moves the draft, so the picker surface tracks the pointer; the close commits
          it as one entry (a close with no drag carries no draft and commits nothing, and a draft
          that landed back on the stored colour is a patch `updateLabels` drops). A typed hex
          arrives with the commit and is committed on the keystroke; "Use default" clears the
          override and cancels the draft outright. Every path drops the draft, so the stored value
          shows again. */}
      <ColorField
        label="Text colour"
        value={colorDraft ?? shownColor}
        fallback={style.text_color}
        mixed={color === MIXED}
        onChange={(hex) => setPicked({ from: shownColor, ids: selectedIds, hex })}
        onCommit={(hex) => {
          // A clear is immediately followed by the popover's own close, which calls the *previous*
          // render's onCommit — one that still closes over the drag's draft. `clearedRef` makes
          // that trailing bare close a no-op, so "Use default" cannot resurrect what it cleared.
          const cleared = clearedRef.current
          clearedRef.current = false
          if (cleared && hex === undefined) return
          const next = hex ?? colorDraft
          if (next) update(ids, { color: next })
          setPicked(null)
        }}
        onClear={() => {
          clearedRef.current = true
          setPicked(null)
          update(ids, { color: null })
        }}
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
        onClick={() => {
          try {
            resetPositions(ids)
          } catch (err) {
            // The placer measures text, so a browser that cannot open a 2D context (or a font
            // that fails to load) throws here. Nothing was written: `resetPositions` applies its
            // labels in one store change at the very end.
            console.error('reset position failed', err)
            onError?.('The labels could not be placed again; nothing was moved.')
          }
        }}
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
