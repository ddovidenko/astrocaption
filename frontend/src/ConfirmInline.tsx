import { useEffect, useId } from 'react'

/** An inline "are you sure?" in place of a browser dialog (SPEC § 5.2): the question and the two
 *  answers in one labelled group, rendered where the button that opened it was.
 *
 *  Cancel takes the focus, not the confirm button. The click that opened the group leaves the
 *  hand on Enter, and an Enter by habit must never be the destructive answer — the owner has to
 *  aim at it. Escape cancels: from inside the group, and at document level too, so a group the
 *  owner tabbed or clicked away from can still be dismissed rather than left stranded.
 */
export default function ConfirmInline({
  question,
  confirmLabel,
  onConfirm,
  onCancel,
  disabled = false,
}: {
  question: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  disabled?: boolean
}) {
  const questionId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <span
      className="confirm"
      role="group"
      aria-label={confirmLabel}
      // The document listener above would catch this too; stopping here keeps it to one call.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <span id={questionId}>{question}</span>
      <button className="danger" onClick={onConfirm} disabled={disabled} aria-describedby={questionId}>
        {confirmLabel}
      </button>
      <button className="secondary" onClick={onCancel} disabled={disabled} autoFocus>
        Cancel
      </button>
    </span>
  )
}
