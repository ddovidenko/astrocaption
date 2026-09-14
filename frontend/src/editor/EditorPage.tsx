import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { pageError, type ImageOut } from '../api'
import { flushSave, retrySave, startAutosave } from './autosave'
import EditorCanvas from './EditorCanvas'
import { isEditable } from './editing'
import { loadEditor } from './load'
import SidePanel from './SidePanel'
import { useEditor } from './store'

/** A save that needs the owner: the message and its one way out. `onMouseDown` keeps the canvas
 *  shortcuts working after the click (a focused button would take Space as a click). */
function SaveProblem({ message, action, onAction }: { message: string; action: string; onAction: () => void }) {
  return (
    <span className="save-status error">
      {message}{' '}
      <button className="secondary" onMouseDown={(e) => e.preventDefault()} onClick={onAction}>
        {action}
      </button>
    </span>
  )
}

/** The toolbar's save state (design § 5). Editing stays local after a conflict; only saving
 *  stops, so the sentence offers a reload rather than a retry. */
function SaveStatus() {
  // `isEditable`, not `solved`: a failed re-solve still edits and still saves (SPEC § 5).
  const editable = useEditor(isEditable)
  const save = useEditor((s) => s.save)
  if (!editable) return <span className="save-status">Read-only while solving</span>
  switch (save.status) {
    case 'saving':
      return <span className="save-status">Saving…</span>
    case 'dirty':
      return <span className="save-status">Unsaved changes</span>
    case 'error':
      return (
        <SaveProblem message={save.message ?? 'The last change could not be saved.'} action="Retry" onAction={retrySave} />
      )
    case 'conflict':
      return (
        <SaveProblem
          message={save.message ?? 'This image was changed elsewhere. Reload to continue editing.'}
          action="Reload"
          onAction={() => window.location.reload()}
        />
      )
    default:
      return <span className="save-status">Saved</span>
  }
}

export default function EditorPage() {
  const { id } = useParams()
  // Keyed by the id it belongs to: opening another image goes back to "loading" and drops the
  // previous error without a synchronous reset inside the effect.
  const [result, setResult] = useState<{ id: string; error: string | null } | null>(null)
  const settled = result && result.id === id ? result : null
  const loading = Boolean(id) && settled === null
  const error = id ? (settled?.error ?? null) : 'That image could not be found.'
  const image = useEditor((s) => s.image)
  const scale = useEditor((s) => s.view.scale)
  const [panelOpen, setPanelOpen] = useState(true)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    // Started only once the document is in the store, so the controller never sees the empty one.
    let stop: (() => void) | null = null
    // The document this mount loaded: a newer load() of the same image installs a different one.
    let loaded: ImageOut | null = null
    loadEditor(id)
      .then((doc) => {
        if (cancelled) return
        useEditor.getState().load(doc)
        loaded = useEditor.getState().image
        stop = startAutosave(id)
        setResult({ id, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setResult({ id, error: pageError(err) })
      })
    return () => {
      cancelled = true
      // In-app navigation (back to the image list, or on to another image) must not drop a change
      // still waiting out the debounce. The teardown waits for the flush to finish: emptying the
      // store first would hand the save an empty document, and stopping the controller first would
      // cancel the save outright. The outcome cannot be shown on a page we are leaving;
      // `beforeunload` is what covers a closing tab.
      void flushSave().finally(() => {
        // A no-op when a newer startAutosave has already retired this controller.
        stop?.()
        const s = useEditor.getState()
        // Only if the store still holds the document this mount loaded: a later load() — of any
        // image, this one included — already owns it, and a load that failed loaded nothing.
        if (s.image !== null && s.image === loaded) s.reset()
      })
    }
  }, [id])

  if (loading) return <p className="meta">Loading the editor…</p>
  if (error) {
    return (
      <p className="error">
        {error} <Link to="/">Back to images</Link>
      </p>
    )
  }
  // The session was lost and the shell is already redirecting; say so rather than showing nothing.
  if (!image) return <p className="meta">Signing you back in…</p>

  return (
    <>
      <div className="editor-toolbar">
        <Link to="/">← Images</Link>
        <strong>{image.title}</strong>
        <span className="meta">{Math.round(scale * 100)} %</span>
        {/* These act on click and never need the focus; keeping it off them leaves the canvas
            shortcuts alive and stops Space from re-clicking the button. Keyboard focus (Tab)
            still works. */}
        <button
          className="secondary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useEditor.getState().fit()}
        >
          Fit
        </button>
        <button
          className="secondary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useEditor.getState().actual()}
        >
          100 %
        </button>
        <SaveStatus />
      </div>
      {image.solve_status === 'failed' && (
        <div className="notice">The last re-solve failed; you are editing the previous layout.</div>
      )}
      {(image.solve_status === 'pending' || image.solve_status === 'solving') && (
        <div className="notice">
          This image is being re-solved; the layout shown is the previous one and cannot be edited
          until it finishes.
        </div>
      )}
      <div className={panelOpen ? 'editor-body' : 'editor-body collapsed'}>
        {/* The canvas keeps its own column: its notices are siblings of the stage, and as direct
            grid children they would land in the panel's column. */}
        <div className="editor-pane">
          <EditorCanvas />
        </div>
        <SidePanel open={panelOpen} onToggle={() => setPanelOpen((v) => !v)} />
      </div>
    </>
  )
}
