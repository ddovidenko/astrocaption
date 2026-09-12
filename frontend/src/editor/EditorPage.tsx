import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { pageError } from '../api'
import EditorCanvas, { type CanvasControls } from './EditorCanvas'
import { loadEditor } from './load'
import { useEditor } from './store'

export default function EditorPage() {
  const { id } = useParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(pageError(err))
        setLoading(false)
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
  if (!image) return null // the session was lost; the shell is already redirecting

  return (
    <>
      <div className="editor-toolbar">
        <Link to="/">← Images</Link>
        <strong>{image.title}</strong>
        <span className="meta">{Math.round(scale * 100)} %</span>
        <button className="secondary" onClick={() => controlsRef.current?.fit()}>
          Fit
        </button>
        <button className="secondary" onClick={() => controlsRef.current?.actual()}>
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
