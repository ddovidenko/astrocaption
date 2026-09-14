import { useEffect, useId, useRef } from 'react'

/** An inline "are you sure?" in place of a browser dialog (SPEC § 5.2): the question and the two
 *  answers in one labelled group, rendered where the button that opened it was.
 *
 *  Cancel takes the focus, not the confirm button. The click that opened the group leaves the
 *  hand on Enter, and an Enter by habit must never be the destructive answer — the owner has to
 *  aim at it. Escape cancels: wherever the focus is, so a group the owner tabbed or clicked away
 *  from can still be dismissed rather than left stranded.
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

  // One document-level listener for the group's lifetime: an Escape inside the group bubbles
  // to it as well, so no group handler is needed. The ref keeps the latest `onCancel` (callers
  // pass a fresh arrow each render) without re-subscribing on every render.
  const cancelRef = useRef(onCancel)
  useEffect(() => {
    cancelRef.current = onCancel
  }, [onCancel])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <span className="confirm" role="group" aria-label={confirmLabel}>
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
