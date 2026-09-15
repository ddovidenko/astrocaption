import { useMemo, useState } from 'react'
import { ApiError, api } from '../api'
import ConfirmInline from '../ConfirmInline'
import { flushSave } from './autosave'
import { isEditable } from './editing'
import { documentForSave, useEditor } from './store'

/** Auto-arrange and Reset positions (design § 5). Both send the document the editor is holding to
 *  `POST /autoarrange`, which places it and hands the labels back without storing them; applying
 *  the answer marks the document dirty and the autosave writes it. */
export default function LayoutTab() {
  const imageId = useEditor((s) => s.image?.id ?? null)
  const labels = useEditor((s) => s.labels)
  const editable = useEditor(isEditable)
  const [busy, setBusy] = useState<'arrange' | 'reset' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const collided = useMemo(() => {
    let n = 0
    for (const label of labels.values()) if (label.enabled && label.collided) n++
    return n
  }, [labels])

  /** Flushes the autosave, then sends the document the editor is holding to the placer and
   *  applies what comes back. Nothing in the store is touched before the response arrives.
   *
   *  The flush comes first because `/autoarrange` checks the version the same way a save does: a
   *  click while a save is still in flight would send the stale version, and the 409 that answers
   *  it would become a sticky conflict the owner never caused. */
  async function arrange(what: 'arrange' | 'reset'): Promise<void> {
    if (!imageId) return
    setBusy(what)
    setError(null)
    try {
      const status = await flushSave()
      if (status !== 'saved') {
        setError(useEditor.getState().save.message ?? 'Unsaved changes could not be saved first.')
        return
      }
      // The placer answers about the document as it was sent. A drag during the round trip would
      // be silently undone by applying it, so the answer is dropped instead.
      const seq = useEditor.getState().changeSeq
      const res = await api.autoarrange(imageId, documentForSave(useEditor.getState()))
      if (useEditor.getState().changeSeq !== seq) {
        setError('Labels moved while the layout was being arranged; nothing was changed. Try again.')
        return
      }
      // The owner may have opened a different image while the request was in flight (`load()`
      // resets `changeSeq` to 0, so the guard above would not catch that); applying image A's
      // labels to image B would be silently wrong, so just walk away.
      if (useEditor.getState().image?.id !== imageId) return
      useEditor.getState().applyLabels(res.labels)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        useEditor.getState().markConflict(err.message)
        setError('The layout was not arranged; see the message in the toolbar.')
      } else if (err instanceof ApiError) {
        // The server's own sentence: plain language by contract (CLAUDE.md), never raw exception text.
        setError(err.message)
      } else {
        // A throw from applying the answer (a store contract violation), not from the request:
        // the cause goes to the console, the page gets a sentence.
        console.error('autoarrange apply failed', err)
        setError('The arranged layout could not be applied; reload the editor.')
      }
    } finally {
      setBusy(null)
    }
  }

  // In M3 this is Auto-arrange behind a confirmation: the server's placer ignores the positions of
  // the labels it places, so "putting them back" first changed nothing it could see. M4's pinned
  // labels are what will make Reset different — it will discard the pins. The confirmation is in
  // the page, like the card's Delete, not a browser dialog (SPEC § 5.2).
  const reset = () => {
    setConfirming(false)
    void arrange('reset')
  }

  return (
    <div className="tab-body">
      <p className="field-note">
        Auto-arrange places every enabled label from scratch; nothing is pinned. Individual labels
        you have dragged are moved too.
      </p>
      <div className="tab-actions">
        <button
          disabled={!editable || busy !== null}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void arrange('arrange')}
        >
          {busy === 'arrange' ? 'Arranging…' : 'Auto-arrange'}
        </button>
        {confirming ? (
          <ConfirmInline
            question="Discard the positions you have dragged and place every enabled label from scratch?"
            confirmLabel="Reset positions"
            onConfirm={reset}
            onCancel={() => setConfirming(false)}
            disabled={busy !== null}
          />
        ) : (
          <button
            className="secondary"
            disabled={!editable || busy !== null}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setConfirming(true)}
          >
            {busy === 'reset' ? 'Resetting…' : 'Reset positions'}
          </button>
        )}
      </div>
      <p className="meta">{collided === 1 ? '1 label overlaps' : `${collided} labels overlap`}</p>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
