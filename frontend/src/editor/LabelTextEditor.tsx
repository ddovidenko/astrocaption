import { useEffect, useRef, useState } from 'react'
import { fontFamilyFor, labelText } from './metrics'
import { useEditor } from './store'
import { toScreen } from './view'

interface Props {
  id: number
  /** The label's top-left, its measured width and its primary size, in original pixels. */
  x: number
  y: number
  width: number
  fontSize: number
  onClose: () => void
}

/** The double-click text editor (SPEC § 6.2): one input over the label, in the label's font at
 *  the label's on-screen size. Enter (or leaving the field) commits the trimmed text as
 *  `text_override`, a blank clears it, Escape cancels. Geometry comes in as original pixels and
 *  is converted here, at the edge. */
export default function LabelTextEditor({ id, x, y, width, fontSize, onClose }: Props) {
  const view = useEditor((s) => s.view)
  const style = useEditor((s) => s.style)
  const label = useEditor((s) => s.labels.get(id))
  const obj = useEditor((s) => s.objects.get(id))
  const initial = label && obj && style ? (label.text_override ?? labelText(obj, label, style).primary) : ''
  const [draft, setDraft] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  // What the field opened on. A close that changed nothing must commit nothing: without this, an
  // untouched open on a label with no override would store its catalogue name as an override.
  const initialRef = useRef(initial)
  // Whether a commit or a cancel already closed us: the blur that follows must not commit again.
  const doneRef = useRef(false)
  // The store refused the commit (a solve started while the field was open). The field stays open
  // with what was typed still in it, rather than closing as though the name had been stored.
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // An undo (or a re-solve) can take the label out of the document while the field is open. There
  // is nothing left to rename, so close: `editingId` must not keep pointing at it.
  const gone = !label
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  if (!style || !label) return null

  const finish = (commit: boolean) => {
    if (doneRef.current) return
    const text = draft.trim()
    if (commit && text !== initialRef.current.trim()) {
      const before = useEditor.getState().changeSeq
      useEditor.getState().updateLabels([id], { text_override: text === '' ? null : text })
      if (useEditor.getState().changeSeq === before) {
        // The editable gate turned it down. Say so in plain language and keep the field open: a
        // silent close would look exactly like a rename that stuck.
        setRefused(true)
        return
      }
    }
    doneRef.current = true
    onClose()
  }

  const at = toScreen(view, x, y)
  return (
    <>
      <input
        ref={ref}
        className="label-text-editor"
        aria-label="Label text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(false)
          }
          // Every other key stays in the field: the canvas shortcuts ignore a focused input.
        }}
        onBlur={() => finish(true)}
        style={{
          left: `${at.x}px`,
          top: `${at.y}px`,
          minWidth: `${Math.max(80, width * view.scale + 24)}px`,
          fontSize: `${fontSize * view.scale}px`,
          fontFamily: `"${fontFamilyFor(style.font_file)}"`,
        }}
      />
      {refused && (
        <p
          className="error label-text-editor-error"
          style={{ left: `${at.x}px`, top: `${at.y + fontSize * view.scale + 8}px` }}
        >
          The name could not be changed while the image is being solved.
        </p>
      )}
    </>
  )
}
