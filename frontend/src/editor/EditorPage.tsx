import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { pageError } from '../api'
import { flushSave, retrySave, startAutosave } from './autosave'
import EditorCanvas from './EditorCanvas'
import { loadEditor } from './load'
import SidePanel from './SidePanel'
import { useEditor } from './store'

/** The toolbar's save state (design § 5). Editing stays local after a conflict; only saving
 *  stops, so the sentence offers a reload rather than a retry. */
function SaveStatus() {
  const solved = useEditor((s) => s.image?.solve_status === 'solved')
  const save = useEditor((s) => s.save)
  if (!solved) return <span className="save-status">Read-only while solving</span>
  switch (save.status) {
    case 'saving':
      return <span className="save-status">Saving…</span>
    case 'dirty':
      return <span className="save-status">Unsaved changes</span>
    case 'error':
      return (
        <span className="save-status error">
          {save.message ?? 'The last change could not be saved.'}{' '}
          <button className="secondary" onMouseDown={(e) => e.preventDefault()} onClick={retrySave}>
            Retry
          </button>
        </span>
      )
    case 'conflict':
      return (
        <span className="save-status error">
          {save.message ?? 'This image was changed elsewhere. Reload to continue editing.'}{' '}
          <button
            className="secondary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </span>
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
    loadEditor(id)
      .then((doc) => {
        if (cancelled) return
        useEditor.getState().load(doc)
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
      // still waiting out the debounce: flushSave() reads the payload synchronously, so the save
      // it starts survives the reset below. Its outcome cannot be shown on a page we are leaving;
      // `beforeunload` is what covers a closing tab.
      void flushSave()
      // Stopped after the flush and before the reset, so the emptied document is never saved.
      stop?.()
      useEditor.getState().reset()
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
      {image.solve_status !== 'solved' && (
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
