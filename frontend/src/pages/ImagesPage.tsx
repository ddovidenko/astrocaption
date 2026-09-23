import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  ApiError,
  api,
  formatBytes,
  isBusy,
  pageError,
  statusLabel,
  type ConfigOut,
  type ExportOut,
  type HealthOut,
  type ImageOut,
} from '../api'
import { exportOf, exportState, relativeTime } from '../exportStatus'
import ConfirmInline from '../ConfirmInline'

const POLL_MS = 3000

export default function ImagesPage({
  health,
  refreshHealth,
}: {
  health: HealthOut
  refreshHealth: () => Promise<HealthOut | null>
}) {
  const [images, setImages] = useState<ImageOut[]>([])
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Refreshes overlap: the 3-second poll, an action's own refresh and a card's finally block
  // all call it, and a slow answer arriving after a fast one would put the old list back (a
  // deleted card reappearing, a solved row going back to Solving…). Only the newest applies.
  const seq = useRef(0)

  // One refresh covers all three: a nova key added in config.json, or a config.json that
  // just broke, must reach the banners as promptly as the image rows do.
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const [list, cfg] = await Promise.all([api.listImages(), api.config(), refreshHealth()])
      if (mine !== seq.current) return
      setImages(list)
      setConfig(cfg)
      setError(null)
    } catch (err) {
      if (mine === seq.current) setError(pageError(err))
    }
  }, [refreshHealth])

  // The first load obeys the same "newest answer wins" rule as `refresh`. Not `void refresh()`:
  // react-hooks/set-state-in-effect forbids a setState-wrapping call in an effect body.
  useEffect(() => {
    const mine = ++seq.current
    Promise.all([api.listImages(), api.config()])
      .then(([list, cfg]) => {
        if (mine !== seq.current) return
        setImages(list)
        setConfig(cfg)
      })
      .catch((err: unknown) => {
        if (mine === seq.current) setError(pageError(err))
      })
  }, [])

  const busy = images.some((img) => isBusy(img.solve_status))
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  return (
    <>
      {health.config_error && (
        <div className="notice error">
          <code>data/config.json</code> was ignored: {health.config_error}
        </div>
      )}
      {config && !config.nova_api_key_set && (
        <div className="notice">
          No nova.astrometry.net API key is configured. Set <code>NOVA_API_KEY</code> (or{' '}
          <code>nova_api_key</code> in <code>data/config.json</code>); no restart is needed, and
          solves fail until a key is present.
        </div>
      )}
      <UploadPanel onUploaded={refresh} maxUploadMb={config?.max_upload_mb ?? null} />
      {error && <p className="error">{error}</p>}
      <section className="images">
        {images.length === 0 && <p className="meta">No images yet. Upload a finished JPG to start.</p>}
        {images.map((img) => (
          <ImageCard key={img.id} image={img} onChange={refresh} />
        ))}
      </section>
    </>
  )
}

function UploadPanel({
  onUploaded,
  maxUploadMb,
}: {
  onUploaded: () => Promise<void>
  /** From the config the page has loaded; null until it arrives, and then no pre-check. */
  maxUploadMb: number | null
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) return
    // Refuse here rather than spend minutes sending a body the server will reject at the door.
    if (maxUploadMb !== null && file.size > maxUploadMb * 1024 * 1024) {
      setError(`The file is ${formatBytes(file.size)}; the upload limit is ${maxUploadMb} MB.`)
      return
    }
    setUploading(true)
    setProgress(null)
    setError(null)
    try {
      await api.upload(file, title, (sent, total) => setProgress({ sent, total }))
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      await onUploaded()
    } catch (err) {
      setError(pageError(err))
    } finally {
      setUploading(false)
      setProgress(null)
    }
  }

  // Three states, in order: the request is open but no progress event has arrived yet; bytes
  // are going out; and — once they are all out — the server is still writing the file and
  // building the preview and thumbnail, which is the "Processing…" the owner waits through.
  const sent = progress !== null && progress.total > 0 && progress.sent >= progress.total
  const label = !uploading
    ? 'Upload & solve'
    : progress === null
      ? 'Uploading…'
      : sent
        ? 'Processing…'
        : `Uploading… ${Math.floor((progress.sent / progress.total) * 100)}%`

  return (
    <section className="panel">
      <h2>Upload</h2>
      <form className="upload" onSubmit={submit}>
        <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.tif,.tiff" required />
        <input
          type="text"
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" disabled={uploading}>
          {label}
        </button>
      </form>
      {uploading && (
        <progress
          className="upload-progress"
          aria-label="Upload progress"
          value={progress?.sent ?? 0}
          max={progress?.total ?? 1}
        />
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function ImageCard({ image, onChange }: { image: ImageOut; onChange: () => Promise<void> }) {
  const [working, setWorking] = useState(false)
  // The card's own error describes the row as it was when the action ran, so it carries the
  // version it belongs to: once the row changes underneath the card — its own refresh, or the
  // 3-second poll — the sentence is stale and stops being shown. (Clearing it from an effect
  // on `image.updated_at` would say the same thing at the cost of a cascading render.)
  const [error, setError] = useState<{ updatedAt: string; message: string } | null>(null)
  const shownError = error?.updatedAt === image.updated_at ? error.message : null
  const [focal, setFocal] = useState('')
  const [pixel, setPixel] = useState('')
  const [quality, setQuality] = useState<number | null>(null)
  const [scale, setScale] = useState(1)
  const [lastExport, setLastExport] = useState<ExportOut | null>(null)
  const [confirming, setConfirming] = useState(false)

  /** Runs one card action and then refreshes the list — including after a refusal, because a
   *  409 usually means the row already moved on (a solve started elsewhere, the image was
   *  deleted) and the card must show that, not just the sentence. `onChange` is the page's
   *  `refresh`, which never rejects: it reports its own failures as the page-level error. */
  async function run(action: () => Promise<unknown>) {
    setWorking(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      const message = pageError(err)
      if (message !== null) setError({ updatedAt: image.updated_at, message })
    } finally {
      await onChange()
      setWorking(false)
    }
  }

  const resolve = () => {
    const f = Number(focal)
    const p = Number(pixel)
    const hints = f > 0 && p > 0 ? { focal_length_mm: f, pixel_size_um: p } : undefined
    return run(() => api.resolve(image.id, hints))
  }
  const checkAgain = () => run(() => api.checkSolve(image.id))
  const exportNow = () =>
    run(async () => {
      setLastExport(await api.exportImage(image.id, quality, scale))
    })
  const remove = () => {
    setConfirming(false)
    return run(async () => {
      try {
        await api.deleteImage(image.id)
      } catch (err) {
        // Already gone — deleted in another tab, or a retry after the answer was lost. That is
        // the end state that was asked for, so the refresh below is the whole story.
        if (!(err instanceof ApiError && err.status === 404)) throw err
      }
    })
  }

  const busy = isBusy(image.solve_status)
  return (
    <article className="card">
      <a href={image.preview_url} target="_blank" rel="noreferrer">
        <img className="thumb" src={image.thumb_url} alt="" />
      </a>
      <div>
        <h3>{image.title}</h3>
        <div className="meta">
          <span className={`badge ${image.solve_status}`}>{statusLabel(image.solve_status)}</span>
          <span>
            {image.width} × {image.height} px
          </span>
          {image.solve_status === 'solved' && <span>{image.object_count} objects</span>}
          {image.calibration && (
            <span>
              RA {image.calibration.ra.toFixed(3)}°, Dec {image.calibration.dec.toFixed(3)}°,{' '}
              {image.calibration.pixscale.toFixed(2)}″/px
            </span>
          )}
          {image.nova_status_url && (
            <a href={image.nova_status_url} target="_blank" rel="noreferrer">
              nova status
            </a>
          )}
          {image.nova_job_log_url && (
            <a href={image.nova_job_log_url} target="_blank" rel="noreferrer">
              nova job log
            </a>
          )}
        </div>
        {image.nova_status_url && (
          <p className="field-note">
            Each solve uploads a copy to your nova.astrometry.net account (not publicly listed);
            only the latest is linked here. Delete copies on nova — AstroCaption cannot.
          </p>
        )}
        {image.solve_error && <p className="error">{image.solve_error}</p>}
        {shownError && <p className="error">{shownError}</p>}
        <div className="actions">
          {image.solve_status === 'solved' && (
            <>
              <label className="hints">
                JPEG
                <select
                  value={quality ?? ''}
                  onChange={(e) => setQuality(e.target.value === '' ? null : Number(e.target.value))}
                >
                  <option value="">
                    {image.original_format === 'JPEG' ? 'Match original (recommended)' : 'Quality 95 (default)'}
                  </option>
                  {[100, 95, 90, 85, 80].map((q) => (
                    <option key={q} value={q}>
                      Quality {q}
                    </option>
                  ))}
                </select>
              </label>
              <label className="hints">
                Scale
                <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                  <option value={1}>100%</option>
                  <option value={0.5}>50%</option>
                </select>
              </label>
              <button onClick={exportNow} disabled={working}>
                {working ? 'Rendering…' : 'Export'}
              </button>
              <Link className="button" to={`/images/${image.id}`}>
                Edit
              </Link>
            </>
          )}
          {!busy && (
            <>
              {image.solve_status === 'failed' && (
                <>
                  {/* Only a timed-out solve has a job worth resuming; the server decides
                      (ImageOut.check_available) so this button and POST /check agree. */}
                  {image.check_available && (
                    <button
                      className="secondary"
                      onClick={checkAgain}
                      disabled={working}
                      title="Resumes the stored nova job; nothing is uploaded again and scale hints are not used (they apply to Re-solve)"
                    >
                      Check again
                    </button>
                  )}
                  <span className="hints">
                    <input
                      type="number"
                      placeholder="Focal mm"
                      value={focal}
                      onChange={(e) => setFocal(e.target.value)}
                    />
                    <input
                      type="number"
                      placeholder="Pixel µm"
                      step="0.01"
                      value={pixel}
                      onChange={(e) => setPixel(e.target.value)}
                    />
                  </span>
                </>
              )}
              <button className="secondary" onClick={resolve} disabled={working}>
                Re-solve
              </button>
            </>
          )}
          {confirming ? (
            <ConfirmInline
              question={`Delete “${image.title}” and its export?`}
              confirmLabel="Delete"
              onConfirm={remove}
              onCancel={() => setConfirming(false)}
              disabled={working}
            />
          ) : (
            <button className="danger" onClick={() => setConfirming(true)} disabled={working}>
              Delete
            </button>
          )}
        </div>
        {image.annotated_preview_url && image.export_url && (
          <div className="export">
            <p className="meta">
              <a href={image.export_url}>Download full-resolution export</a>
              <span>exported {relativeTime(image.exported_at!)}</span>
              {exportState(exportOf(image), image.annotations_hash) === 'stale' && (
                <span className="badge stale" title="The annotations changed after this export; export again to refresh it">
                  Export out of date
                </span>
              )}
              {lastExport && (
                <span>
                  {formatBytes(lastExport.bytes)}, {lastExport.encoding}
                </span>
              )}
            </p>
            <a href={image.export_url}>
              <img src={image.annotated_preview_url} alt={`${image.title} annotated`} />
            </a>
          </div>
        )}
      </div>
    </article>
  )
}
