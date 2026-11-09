import { useMemo, type InputHTMLAttributes } from 'react'
import type { Label, LeaderMode } from '../api'
import { isEditable, resetPositions } from './editing'
import { clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE } from './metrics'
import { useEditor } from './store'
import { useTaggedDraft } from './taggedDraft'

// What the per-label controls do, without where they sit (SPEC § 6.2, § 6.5): the floating strip
// over the canvas (`LabelToolbar`) and the docked bar of a compact editor (`LabelDock`) are two
// layouts of this one model, so a control behaves the same in both and is one undo entry in both.

export const MIXED = 'mixed'

export const ALIAS_OPTIONS = [
  { value: 'inherit', label: 'inherit' },
  { value: 'on', label: 'on' },
  { value: 'off', label: 'off' },
]
export const LEADER_OPTIONS = [
  { value: 'auto', label: 'auto' },
  { value: 'on', label: 'on' },
  { value: 'off', label: 'off' },
]

/** One value when every selected label agrees, MIXED otherwise. */
function common<T>(labels: Label[], pick: (l: Label) => T): T | typeof MIXED {
  const first = pick(labels[0]!)
  return labels.every((l) => pick(l) === first) ? first : MIXED
}

export interface LabelControls {
  /** The selected, enabled labels every control applies to. */
  ids: number[]
  /** Spread onto the size `<input>`: the draft it shows, its bounds and every handler (typing,
   *  Enter and blur to commit, the arrows as held previews, undo and redo handed to the editor). */
  sizeField: InputHTMLAttributes<HTMLInputElement>
  /** − / +: one commit for the selection, each label from its own effective size. */
  step(delta: number): void
  /** Spread onto `<ColorField label="Text colour" />`. */
  color: {
    value: string
    fallback: string
    mixed: boolean
    onChange(hex: string): void
    onCommit(hex?: string): void
    onClear(): void
  }
  aliases: { value: string; onChange(value: string): void }
  leader: { value: string; onChange(value: string): void }
  /** `mixed`: some of the selection is pinned and some is not (`pressed` is then false). */
  pin: { label: string; pressed: boolean; mixed: boolean; toggle(): void }
  /** Places the selection again with the placer and unpins it. The placer measures text, so it
   *  can throw; then nothing was moved and `onError` is told. */
  resetPosition(): void
  /** Back to the global size, colour, aliases, leader and name. */
  clearOverrides(): void
  /** A signature of everything that changes how wide the controls are (see the comment where it
   *  is built): what a layout that measures itself re-measures on. */
  contentKey: string
}

/** The controls for the current selection, or null when there is nothing to show: no style yet, a
 *  read-only document, or no enabled label selected. `onError` receives an action that failed
 *  outright; the controls themselves have no room for an error line. */
export function useLabelControls(onError?: (message: string) => void): LabelControls | null {
  const selectedIds = useEditor((s) => s.selectedIds)
  const labels = useEditor((s) => s.labels)
  const style = useEditor((s) => s.style)
  const editable = useEditor(isEditable)

  const selected = useMemo(
    () => [...selectedIds].map((id) => labels.get(id)).filter((l): l is Label => l !== undefined && l.enabled),
    [selectedIds, labels],
  )
  const empty = selected.length === 0

  // The size field is a draft: committed on Enter or blur, clamped and rounded into the bounds. It is
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

  // What a layout that measures its own width re-measures on: a signature of the content, not
  // `selected` itself: a drag replaces every selected `Label` object on every frame, and keying on them would
  // put a `getBoundingClientRect` — a forced layout — in the middle of each one (#105). The size
  // guard keeps a settled measurement from looping.
  //
  // The signature covers everything that moves the width: the size field's text and the global
  // size behind its placeholder (`style`), the swatch's " default"/" mixed" note — which is why
  // *having* a colour override counts, not which colour it is — the two selects' values, the pin
  // button's wording and whether there is a toolbar at all. The live picker draft is deliberately
  // not in it: a drag changes the swatch's hex, not its layout, and would remeasure per frame.
  const contentKey = `${shownSize}|${color === MIXED}|${shownColor === ''}|${aliases}|${leader}|${pinLabel}|${editable}`

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
    // The same bounds the Style tab's size field enforces, but applied the way − / + apply them:
    // a typed 900 commits 500 and 12.5 commits 13, and the field shows the committed value at
    // once. The toolbar has no room for a validation line, so a dropped edit would say nothing
    // (#103). Only text the number input let through that is still not a number is dropped.
    const n = Number(text)
    if (!Number.isFinite(n)) return
    update(ids, { font_size: clampFontSize(n) })
  }
  const step = (delta: number) => {
    // The stepper acts on the stored sizes, so a draft typed against them is spent — and a draft
    // left standing would keep showing over a `shownSize` that stays blank on a mixed selection.
    dropTyped()
    const s = useEditor.getState()
    // One commit for the set: each label steps from its own effective size.
    const updated = selected.map((l) => ({
      ...l,
      font_size: clampFontSize((l.font_size ?? s.style!.font_size) + delta),
    }))
    // At the clamp every label already holds the size it would step to. `applyLabels` has no
    // same-value dedupe of its own, so committing here would be an undo entry and a save for a
    // click that changed nothing.
    if (updated.every((l, i) => l.font_size === selected[i]!.font_size)) return
    s.applyLabels(updated)
  }

  // ArrowUp / ArrowDown in the field (#144): preview frames, committed as one entry when the key
  // comes up or the field loses focus, the way a wheel resize commits on its mouseup, so holding
  // the key is one change rather than one per repeat (which would flush the 100-entry history). A
  // number typed but not yet committed is the base to step from, as in a native number field.
  const stepPreview = (delta: number) => {
    const typedSize = typed === null || typed.trim() === '' ? NaN : Number(typed)
    dropTyped()
    const s = useEditor.getState()
    for (const id of ids) {
      const label = s.labels.get(id)
      if (!label) continue
      const from = Number.isFinite(typedSize) ? typedSize : (label.font_size ?? style.font_size)
      s.updateLabels([id], { font_size: clampFontSize(from + delta) }, false)
    }
  }
  const commitPreview = () => useEditor.getState().commitPreview()

  return {
    ids,
    sizeField: {
      type: 'number',
      'aria-label': 'Font size',
      min: MIN_FONT_SIZE,
      max: MAX_FONT_SIZE,
      placeholder: String(style.font_size),
      value: draft,
      onChange: (e) => {
        // Chromium reports an empty value for a number input holding something it cannot parse
        // ('e', a lone '-'), with `badInput` set. Reading that as a cleared field would wipe the
        // selection's size overrides on a keystroke; keeping the last draft leaves the typing
        // where it was.
        if (e.target.validity.badInput) return
        setTyped(e.target.value)
      },
      onBlur: () => {
        commitPreview()
        commitSize()
      },
      onKeyDown: (e) => {
        // Undo/redo: the editor's shortcuts leave keys to a focused toolbar field, and after arrow
        // steps the focus is still here, so the field hands them to the editor's history itself —
        // unless a number is being typed, whose own undo is the input's. A held arrow's run is
        // committed first: the history does not move under a live preview.
        const key = e.key.toLowerCase()
        const undo = key === 'z' && !e.shiftKey
        const redo = key === 'y' || (key === 'z' && e.shiftKey)
        if ((e.ctrlKey || e.metaKey) && !e.altKey && (undo || redo) && draft === shownSize) {
          e.preventDefault()
          commitPreview()
          const s = useEditor.getState()
          if (undo) s.undoLast()
          else s.redoLast()
          return
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          commitSize()
          e.currentTarget.blur()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          // The native step would only move the draft, which waits for Enter or blur (#144).
          // The spinner is hidden in CSS.
          e.preventDefault()
          stepPreview(e.key === 'ArrowUp' ? 1 : -1)
        }
      },
      onKeyUp: (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') commitPreview()
      },
    },
    step,
    // A drag only moves the draft, so the picker surface tracks the pointer; the close commits
    // it as one entry (a close with no drag carries no draft and commits nothing, and a draft
    // that landed back on the stored colour is a patch `updateLabels` drops). A typed hex
    // arrives with the commit and is committed on the keystroke; "Use default" clears the
    // override and cancels the draft outright — ColorField fires one terminal callback per
    // close, so a clear never also arrives here as a commit. Every path drops the draft, so
    // the stored value shows again.
    color: {
      value: colorDraft ?? shownColor,
      fallback: style.text_color,
      mixed: color === MIXED,
      onChange: setPicked,
      onCommit: (hex) => {
        const next = hex ?? colorDraft
        if (next) update(ids, { color: next })
        dropPicked()
      },
      onClear: () => {
        dropPicked()
        update(ids, { color: null })
      },
    },
    aliases: {
      value: aliases === MIXED ? MIXED : aliases === null ? 'inherit' : aliases ? 'on' : 'off',
      onChange: (v) => update(ids, { show_aliases: v === 'inherit' ? null : v === 'on' }),
    },
    leader: { value: leader, onChange: (v) => update(ids, { leader: v as LeaderMode }) },
    pin: {
      label: pinLabel,
      pressed: pinned === true,
      mixed: pinned === MIXED,
      toggle: () => update(ids, { pinned: pinned !== true }),
    },
    resetPosition: () => {
      try {
        resetPositions(ids)
      } catch (err) {
        // The placer measures text, so a browser that cannot open a 2D context (or a font
        // that fails to load) throws here. Nothing was written: `resetPositions` applies its
        // labels in one store change at the very end.
        console.error('reset position failed', err)
        onError?.('The labels could not be placed again; nothing was moved.')
      }
    },
    clearOverrides: () =>
      update(ids, { font_size: null, color: null, show_aliases: null, leader: 'auto', text_override: null }),
    contentKey,
  }
}
