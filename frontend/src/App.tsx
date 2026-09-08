import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, formatBytes, isBusy, statusLabel, type ExportOut, type HealthOut, type ImageOut } from './api'

const POLL_MS = 3000

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

export default function App() {
  const [health, setHealth] = useState<HealthOut | null>(null)
  const [images, setImages] = useState<ImageOut[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setImages(await api.listImages())
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then((h) => {
        if (!cancelled) setHealth(h)
      })
      .catch(() => undefined)
    api
      .listImages()
      .then((list) => {
        if (!cancelled) setImages(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const busy = images.some((img) => isBusy(img.solve_status))
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [busy, refresh])

  useEffect(() => {
    if (health?.site_title) document.title = health.site_title
  }, [health])

  return (
    <>
      <header>
        <h1>{health?.site_title ?? 'AstroCaption'}</h1>
        {health && <span className="version">v{health.version}</span>}
      </header>
      <main>
        {health && !health.nova_api_key_set && (
          <div className="notice">
            No nova.astrometry.net API key is configured. Set <code>NOVA_API_KEY</code> (or{' '}
            <code>nova_api_key</code> in <code>data/config.json</code>) and restart; uploads will
            fail to solve until then.
          </div>
        )}
        <UploadPanel onUploaded={refresh} />
        {error && <p className="error">{error}</p>}
        <section className="images">
          {images.length === 0 && <p className="meta">No images yet. Upload a finished JPG to start.</p>}
          {images.map((img) => (
            <ImageCard key={img.id} image={img} onChange={refresh} />
          ))}
        </section>
      </main>
    </>
  )
}

function UploadPanel({ onUploaded }: { onUploaded: () => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await api.upload(file, title)
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      await onUploaded()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setUploading(false)
    }
  }

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
          {uploading ? 'Uploading…' : 'Upload & solve'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function ImageCard({ image, onChange }: { image: ImageOut; onChange: () => Promise<void> }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focal, setFocal] = useState('')
  const [pixel, setPixel] = useState('')
  const [quality, setQuality] = useState<number | null>(null)
  const [scale, setScale] = useState(1)
  const [lastExport, setLastExport] = useState<ExportOut | null>(null)

  async function run(action: () => Promise<unknown>) {
    setWorking(true)
    setError(null)
    try {
      await action()
      await onChange()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setWorking(false)
    }
  }

  const resolve = () => {
    const f = Number(focal)
    const p = Number(pixel)
    const hints = f > 0 && p > 0 ? { focal_length_mm: f, pixel_size_um: p } : undefined
    return run(() => api.resolve(image.id, hints))
  }
  const exportNow = () =>
    run(async () => {
      setLastExport(await api.exportImage(image.id, quality, scale))
    })
  const remove = () => {
    if (!window.confirm(`Delete "${image.title}" and its export?`)) return
    return run(() => api.deleteImage(image.id))
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
        {image.solve_error && <p className="error">{image.solve_error}</p>}
        {error && <p className="error">{error}</p>}
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
            </>
          )}
          {!busy && (
            <>
              {image.solve_status === 'failed' && (
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
              )}
              <button className="secondary" onClick={resolve} disabled={working}>
                Re-solve
              </button>
            </>
          )}
          <button className="danger" onClick={remove} disabled={working}>
            Delete
          </button>
        </div>
        {image.annotated_preview_url && image.export_url && (
          <div className="export">
            <p className="meta">
              <a href={image.export_url}>Download full-resolution export</a>
              <span>exported {image.exported_at}</span>
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
