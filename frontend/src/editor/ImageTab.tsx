import { useEffect, useState } from 'react'
import { api, formatBytes, pageError, type ExportOut } from '../api'
import { exportOf, exportState, relativeTime } from '../exportStatus'
import { flushSave } from './autosave'
import { useEditor } from './store'
import { fallbackSentence } from './styleTab'

/** Read-only solve facts plus the export button (design § 5). Publish, re-solve and delete stay
 *  on the image card. */
export default function ImageTab() {
  const image = useEditor((s) => s.image)
  const fallback = useEditor((s) => s.fontFallback)
  // Not `isEditable`: that also allows a failed re-solve, which the editor may still edit and save
  // but the export endpoint refuses ("Image is not solved yet."). The button says so by being
  // disabled rather than by failing.
  const solved = useEditor((s) => s.image?.solve_status === 'solved')
  // For the export line (#91): the stored document's hash moves with every save that lands,
  // and anything not saved yet is already a change the last export cannot hold.
  const annotationsHash = useEditor((s) => s.contentHash)
  const saveStatus = useEditor((s) => s.save.status)
  const unsaved = saveStatus !== 'saved'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExportOut | null>(null)
  const exported = image ? exportOf(image) : null
  const state = exportState(exported, annotationsHash, unsaved)
  // "Exported 3 minutes ago" keeps moving while the tab sits idle; the other two sentences do not
  // depend on the clock, so the tick runs only while that one shows.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (state !== 'current') return
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [state])

  if (!image) return null
  const cal = image.calibration
  let exportLine = 'Not exported yet'
  if (exported) exportLine = state === 'stale' ? 'Changes since the last export' : `Exported ${relativeTime(exported.at)}`
  // Export is the next step when the document has moved on — unless the save is in conflict or
  // failed, when exportNow can only report that; the toolbar's Reload / Retry is the step then.
  const emphasise = state === 'stale' && saveStatus !== 'conflict' && saveStatus !== 'error'

  async function exportNow(id: string): Promise<void> {
    if (!solved) return
    setBusy(true)
    setError(null)
    // A failed export must not leave the previous run's download link on screen to be clicked.
    setResult(null)
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
      const out = await api.exportImage(id, null, 1)
      setResult(out)
      // The image now carries this export; a later failed export clears `result` (its download
      // link must go) but not this, so the line keeps the last one that succeeded.
      useEditor.getState().markExported(out.exported_at, out.exported_hash)
    } catch (err) {
      setError(pageError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tab-body">
      {fallback && <p className="notice">{fallbackSentence(fallback)}</p>}
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
      <p className={state === 'stale' ? 'meta export-state stale' : 'meta export-state'} data-testid="export-state">
        {exportLine}
      </p>
      <div className="tab-actions">
        <button
          className={emphasise ? undefined : 'secondary'}
          disabled={busy || !solved}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void exportNow(image.id)}
        >
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
