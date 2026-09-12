import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { pageError } from '../api'
import EditorCanvas, { type CanvasControls } from './EditorCanvas'
import { loadEditor } from './load'
import { useEditor } from './store'

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
  const controlsRef = useRef<CanvasControls | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    loadEditor(id)
      .then((doc) => {
        if (cancelled) return
        useEditor.getState().load(doc)
        setResult({ id, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setResult({ id, error: pageError(err) })
      })
    return () => {
      cancelled = true
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
          onClick={() => controlsRef.current?.fit()}
        >
          Fit
        </button>
        <button
          className="secondary"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => controlsRef.current?.actual()}
        >
          100 %
        </button>
      </div>
      {image.solve_status !== 'solved' && (
        <div className="notice">
          This image is being re-solved; the layout shown is the previous one and cannot be edited
          until it finishes.
        </div>
      )}
      <EditorCanvas controlsRef={controlsRef} />
    </>
  )
}
