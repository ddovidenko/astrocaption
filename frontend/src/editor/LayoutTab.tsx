import { useMemo, useState } from 'react'
import { ApiError, api, pageError, type Label } from '../api'
import { flushSave } from './autosave'
import { isEditable } from './editing'
import { documentForSave, enabledLabels, useEditor } from './store'

/** Auto-arrange and Reset positions (design § 5). Both send the document the editor is holding to
 *  `POST /autoarrange`, which places it and hands the labels back without storing them; applying
 *  the answer marks the document dirty and the autosave writes it. */
export default function LayoutTab() {
  const imageId = useEditor((s) => s.image?.id ?? null)
  const labels = useEditor((s) => s.labels)
  const editable = useEditor(isEditable)
  const [busy, setBusy] = useState<'arrange' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const collided = useMemo(() => {
    let n = 0
    for (const label of labels.values()) if (label.enabled && label.collided) n++
    return n
  }, [labels])

  /** Flushes the autosave, then runs `prepare` (Reset moves the labels home in the store) and
   *  sends the resulting document to the placer.
   *
   *  The flush comes first because `/autoarrange` checks the version the same way a save does: a
   *  click while a save is still in flight would send the stale version, and the 409 that answers
   *  it would become a sticky conflict the owner never caused — with Reset's flattened layout
   *  already in the store and no way left to save it. */
  async function arrange(what: 'arrange' | 'reset', prepare?: () => void): Promise<void> {
    if (!imageId) return
    setBusy(what)
    setError(null)
    try {
      const status = await flushSave()
      if (status !== 'saved') {
        setError(useEditor.getState().save.message ?? 'The layout could not be saved.')
        return
      }
      prepare?.()
      const res = await api.autoarrange(imageId, documentForSave(useEditor.getState()))
      useEditor.getState().applyLabels(res.labels)
    } catch (err) {
      // A 409 is the same stale-document story the autosave tells, so it goes to the toolbar's
      // save state (Reload) rather than being repeated as a tab error.
      if (err instanceof ApiError && err.status === 409) useEditor.getState().markConflict(err.message)
      else setError(pageError(err))
    } finally {
      setBusy(null)
    }
  }

  const reset = () => {
    if (!window.confirm('Put every enabled label back at its object and auto-arrange?')) return
    void arrange('reset', () => {
      const state = useEditor.getState()
      const home: Label[] = []
      for (const label of enabledLabels(state)) {
        const obj = state.objects.get(label.object_id)
        // Labels whose object is gone are left exactly as they are; the canvas hides them and
        // the save path writes them back untouched.
        if (obj) home.push({ ...label, x: obj.x, y: obj.y, collided: false })
      }
      state.applyLabels(home)
    })
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
        <button className="secondary" disabled={!editable || busy !== null} onMouseDown={(e) => e.preventDefault()} onClick={reset}>
          {busy === 'reset' ? 'Resetting…' : 'Reset positions'}
        </button>
      </div>
      <p className="meta">{collided === 1 ? '1 label overlaps' : `${collided} labels overlap`}</p>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
