import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Label, LeaderMode } from '../api'
import ColorField from '../style/ColorField'
import { parseNumberField } from '../style/styleForm'
import { isEditable, resetPositions } from './editing'
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type Box } from './metrics'
import { useEditor } from './store'
import { useTaggedDraft } from './taggedDraft'
import { toScreen } from './view'

const MARGIN = 8
const MIXED = 'mixed'

const ALIAS_OPTIONS = [
  { value: 'inherit', label: 'inherit' },
  { value: 'on', label: 'on' },
  { value: 'off', label: 'off' },
]
const LEADER_OPTIONS = [
  { value: 'auto', label: 'auto' },
  { value: 'on', label: 'on' },
  { value: 'off', label: 'off' },
]

/** One value when every selected label agrees, MIXED otherwise. */
function common<T>(labels: Label[], pick: (l: Label) => T): T | typeof MIXED {
  const first = pick(labels[0]!)
  return labels.every((l) => pick(l) === first) ? first : MIXED
}

/** A toolbar select over a selection that may disagree: the "mixed" sentinel is an option only
 *  while it is the value, so the owner can never pick it, and it disappears once they have. Every
 *  option reads "<field>: <choice>", which is also the field's accessible name. */
function MixedSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  /** One of `options`, or MIXED while the selection disagrees. */
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {value === MIXED && (
        <option value={MIXED} disabled>
          {`${label}: ${MIXED}`}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {`${label}: ${o.label}`}
        </option>
      ))}
    </select>
  )
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
  const empty = selected.length === 0

  // The size field is a draft: committed on Enter or blur, reverted on an invalid value. It is
  // tagged with the selection and the stored size it was typed against (see `useTaggedDraft`), so
  // the stored value shows again the moment either moves on, and every path that acts on it drops
  // it (`dropTyped`).
  const fontSize = empty ? MIXED : common(selected, (l) => l.font_size)
  const shownSize = fontSize === MIXED || fontSize === null ? '' : String(fontSize)
  const [typed, setTyped, dropTyped] = useTaggedDraft<string>([shownSize, selectedIds])
  const draft = typed ?? shownSize

  // The colour is a draft too, tagged the same way, so the picker surface follows the pointer
  // while a drag is in flight and only the close commits it (StyleTab's shape).
  const color = empty ? MIXED : common(selected, (l) => l.color)
  const shownColor = color === MIXED ? '' : (color ?? '')
  const [colorDraft, setPicked, dropPicked] = useTaggedDraft<string>([shownColor, selectedIds])

  const aliases = empty ? MIXED : common(selected, (l) => l.show_aliases)
  const leader = empty ? MIXED : common(selected, (l) => l.leader)
  const pinned = empty ? MIXED : common(selected, (l) => l.pinned)
  const pinLabel = pinned === MIXED ? 'Pin (mixed)' : pinned ? 'Pinned' : 'Pin'

  // Own size, for the clamping below. Measured after layout and re-measured when what the toolbar
  // shows could have changed width. The trigger is a signature of that content, not `selected`
  // itself: a drag replaces every selected `Label` object on every frame, and keying on them would
  // put a `getBoundingClientRect` — a forced layout — in the middle of each one (#105). The size
  // guard keeps a settled measurement from looping.
  //
  // The signature covers everything that moves the width: the size field's text and the global
  // size behind its placeholder (`style`), the swatch's " default"/" mixed" note — which is why
  // *having* a colour override counts, not which colour it is — the two selects' values, the pin
  // button's wording and whether there is a toolbar at all. The live picker draft is deliberately
  // not in it: a drag changes the swatch's hex, not its layout, and would remeasure per frame.
  const contentKey = `${shownSize}|${color === MIXED}|${shownColor === ''}|${aliases}|${leader}|${pinLabel}|${editable}`
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width !== size.w || rect.height !== size.h) setSize({ w: rect.width, h: rect.height })
  }, [size.w, size.h, contentKey, style])

  if (!style || !editable || empty) return null

  const ids = selected.map((l) => l.object_id)
  const update = useEditor.getState().updateLabels

  const commitSize = () => {
    // Nothing was typed against what the field already shows (a focus and a blur, say): there is
    // no edit to commit. Without this, a blur on a mixed selection — whose field shows blank
    // because the sizes differ, not because anyone cleared it — would read as a clear and wipe
    // every override in the selection.
    if (draft === shownSize) {
      dropTyped()
      return
    }
    const text = draft.trim()
    // Committed, reverted or ignored, the draft is spent either way: the field goes back to
    // mirroring the store.
    dropTyped()
    if (text === '') {
      update(ids, { font_size: null })
      return
    }
    // The same bounds the Style tab's own size field enforces; out of them, the edit is dropped.
    const n = parseNumberField('font_size', text)
    if (n === null) return
    update(ids, { font_size: n })
  }
  const step = (delta: number) => {
    // The stepper acts on the stored sizes, so a draft typed against them is spent — and a draft
    // left standing would keep showing over a `shownSize` that stays blank on a mixed selection.
    dropTyped()
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
          setTyped(e.target.value)
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
          override and cancels the draft outright — ColorField fires one terminal callback per
          close, so a clear never also arrives here as a commit. Every path drops the draft, so
          the stored value shows again. */}
      <ColorField
        label="Text colour"
        value={colorDraft ?? shownColor}
        fallback={style.text_color}
        mixed={color === MIXED}
        onChange={setPicked}
        onCommit={(hex) => {
          const next = hex ?? colorDraft
          if (next) update(ids, { color: next })
          dropPicked()
        }}
        onClear={() => {
          dropPicked()
          update(ids, { color: null })
        }}
      />
      <MixedSelect
        label="Aliases"
        value={aliases === MIXED ? MIXED : aliases === null ? 'inherit' : aliases ? 'on' : 'off'}
        options={ALIAS_OPTIONS}
        onChange={(v) => update(ids, { show_aliases: v === 'inherit' ? null : v === 'on' })}
      />
      <MixedSelect
        label="Leader"
        value={leader}
        options={LEADER_OPTIONS}
        onChange={(v) => update(ids, { leader: v as LeaderMode })}
      />
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
