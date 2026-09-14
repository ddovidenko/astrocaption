import { useState } from 'react'
import { api, formatBytes, pageError, type ExportOut } from '../api'
import { flushSave } from './autosave'
import { useEditor } from './store'

/** Read-only solve facts plus the export button (design § 5). Publish, re-solve and delete stay
 *  on the image card. */
export default function ImageTab() {
  const image = useEditor((s) => s.image)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportOut | null>(null)

  if (!image) return null
  const cal = image.calibration

  async function exportNow(id: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      // The export renders what the server has stored, so anything still queued has to land
      // first; a save that fails or conflicts stops the export rather than exporting stale work.
      const status = await flushSave()
      if (status !== 'saved') {
        setError(
          useEditor.getState().save.message ??
            (status === 'conflict'
              ? 'This image was changed elsewhere. Reload before exporting.'
              : 'Your last changes could not be saved, so the export was not started.'),
        )
        return
      }
      setResult(await api.exportImage(id, null, 1))
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tab-body">
      <dl className="facts">
        <dt>Field centre</dt>
        <dd>{cal ? `RA ${cal.ra.toFixed(3)}°, Dec ${cal.dec.toFixed(3)}°` : '—'}</dd>
        <dt>Field size</dt>
        <dd>{cal ? `${(cal.radius * 2).toFixed(3)}° across` : '—'}</dd>
        <dt>Rotation</dt>
        <dd>{cal ? `${cal.orientation.toFixed(2)}°` : '—'}</dd>
        <dt>Pixel scale</dt>
        <dd>{cal ? `${cal.pixscale.toFixed(2)}″/px` : '—'}</dd>
        <dt>Image</dt>
        <dd>
          {image.width} × {image.height} px, {image.object_count} objects
        </dd>
      </dl>
      {image.nova_status_url && (
        <p className="meta">
          <a href={image.nova_status_url} target="_blank" rel="noreferrer">
            nova status
          </a>
          {image.nova_job_log_url && (
            <a href={image.nova_job_log_url} target="_blank" rel="noreferrer">
              nova job log
            </a>
          )}
        </p>
      )}
      <div className="tab-actions">
        <button disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={() => void exportNow(image.id)}>
          {busy ? 'Rendering…' : 'Export'}
        </button>
      </div>
      <p className="field-note">
        Exports at full resolution and matches the original JPEG's encoding. Other sizes and
        qualities are on the image card.
      </p>
      {error && <p className="error">{error}</p>}
      {result && (
        <p className="meta">
          <a href={result.export_url}>Download full-resolution export</a>
          <span>
            {result.width} × {result.height} px, {formatBytes(result.bytes)}, {result.encoding}
          </span>
        </p>
      )}
    </div>
  )
}
