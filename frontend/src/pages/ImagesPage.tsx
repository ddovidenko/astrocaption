import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  ApiError,
  PAGE_LIMIT,
  api,
  formatBytes,
  hasLayout,
  isBusy,
  pageError,
  statusLabel,
  type ConfigOut,
  type ExportOut,
  type HealthOut,
  type ImageOut,
  type Page,
} from '../api'
import { elapsed, exportOf, exportState, relativeTime } from '../exportStatus'
import ConfirmInline from '../ConfirmInline'
import ShowMore from './ShowMore'

const POLL_MS = 3000

export default function ImagesPage({
  health,
  refreshHealth,
}: {
  health: HealthOut
  refreshHealth: () => Promise<HealthOut | null>
}) {
  const [images, setImages] = useState<ImageOut[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [config, setConfig] = useState<ConfigOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  // When the list was last fetched: the clock the cards read the age of a solving row from
  // (#80), moved on by every refresh (every 3 s while a solve runs), never during a render.
  const [now, setNow] = useState(0)
  // Refreshes overlap: the 3-second poll, an action's own refresh and a card's finally block
  // all call it, and a slow answer arriving after a fast one would put the old list back (a
  // deleted card reappearing, a solved row going back to Solving…). Only the newest applies.
  // Show more takes a number too, so it and a refresh in flight cannot both apply.
  const seq = useRef(0)
  // How many cards are on screen, for a refresh to fetch the same number again rather than
  // fold the list back to the first page.
  const shown = useRef(0)
  useEffect(() => {
    shown.current = images.length
  }, [images])

  const applyPage = useCallback((page: Page<ImageOut>) => {
    setImages(page.items)
    setNext(page.next)
  }, [])

  // One refresh covers all three: a nova key added in config.json, or a config.json that
  // just broke, must reach the banners as promptly as the image rows do.
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const [page, cfg] = await Promise.all([
        listFirst(Math.max(PAGE_LIMIT, shown.current)),
        api.config(),
        refreshHealth(),
      ])
      if (mine !== seq.current) return
      applyPage(page)
      setConfig(cfg)
      setNow(Date.now())
      setError(null)
    } catch (err) {
      if (mine === seq.current) setError(pageError(err))
    }
  }, [applyPage, refreshHealth])

  // The first load obeys the same "newest answer wins" rule as `refresh`. Not `void refresh()`:
  // react-hooks/set-state-in-effect forbids a setState-wrapping call in an effect body.
  useEffect(() => {
    const mine = ++seq.current
    Promise.all([api.listImages(), api.config()])
      .then(([page, cfg]) => {
        if (mine !== seq.current) return
        applyPage(page)
        setConfig(cfg)
        setNow(Date.now())
      })
      .catch((err: unknown) => {
        if (mine === seq.current) setError(pageError(err))
      })
  }, [applyPage])

  const showMore = useCallback(async () => {
    if (next === null) return
    setMore({ busy: true, error: null })
    const mine = ++seq.current
    try {
      const page = await api.listImages({ before: next })
      // A refresh that applied meanwhile rebuilt the list from the top; appending to it could
      // skip or repeat a card, so this page is dropped and the link stays for another tap.
      if (mine !== seq.current) {
        setMore({ busy: false, error: null })
        return
      }
      setImages((current) => [...current, ...page.items])
      setNext(page.next)
      setMore({ busy: false, error: null })
    } catch (err) {
      // The cursor image was deleted meanwhile (another tab): the list is stale, start it over.
      if (err instanceof ApiError && err.status === 422) {
        setMore({ busy: false, error: null })
        void refresh()
        return
      }
      setMore({ busy: false, error: pageError(err) })
    }
  }, [next, refresh])

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
          <ImageCard
            key={img.id}
            image={img}
            onChange={refresh}
            staleAfterSeconds={config?.solve_timeout_seconds ?? null}
            now={now}
          />
        ))}
      </section>
      <ShowMore next={next} busy={more.busy} error={more.error} onMore={() => void showMore()} />
    </>
  )
}

/** The first `count` images as one page: pages of at most 100 (the server's cap) joined, so a
 *  refresh keeps every card the owner has shown. */
async function listFirst(count: number): Promise<Page<ImageOut>> {
  const items: ImageOut[] = []
  let before: string | null = null
  do {
    const page: Page<ImageOut> = await api.listImages({ limit: Math.min(100, count - items.length), before })
    items.push(...page.items)
    before = page.next
  } while (before !== null && items.length < count)
  return { items, next: before }
}

export function UploadPanel({
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
  const abortRef = useRef<AbortController | null>(null)

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
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await api.upload(file, title, (sent, total) => setProgress({ sent, total }), controller.signal)
      setTitle('')
      if (fileRef.current) fileRef.current.value = ''
      await onUploaded()
    } catch (err) {
      // Cancelled by the owner (#80): their doing, nothing to report.
      if (!controller.signal.aborted) setError(pageError(err))
    } finally {
      abortRef.current = null
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
        <div className="upload-status">
          <progress
            className="upload-progress"
            aria-label="Upload progress"
            value={progress?.sent ?? 0}
            max={progress?.total ?? 1}
          />
          {/* Only while bytes are still going out: once they are all sent the server stores the
              file whatever the browser does, so a Cancel then would only lie. */}
          {!sent && (
            <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

export function ImageCard({
  image,
  onChange,
  staleAfterSeconds,
  now,
}: {
  image: ImageOut
  onChange: () => Promise<void>
  /** The worker's solve timeout from the config, null until it is known (then nothing is called stuck). */
  staleAfterSeconds: number | null
  /** The page's clock (when the list was last fetched), so the card never reads one in render. */
  now: number
}) {
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
  const setPublished = (published: boolean) => run(() => api.setPublished(image.id, published))
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
  // A row in `solving` with no word for a whole timeout is stuck (#80): the worker is not on it
  // (a solve in progress always reports within the deadline), so Re-solve is offered again. The
  // server applies the same rule and refuses if the worker does still own the row.
  const stuck =
    image.solve_status === 'solving' &&
    staleAfterSeconds !== null &&
    now - Date.parse(image.updated_at) > staleAfterSeconds * 1000
  const publishToggle = image.published ? (
    <button className="secondary" onClick={() => setPublished(false)} disabled={working}>
      Unpublish
    </button>
  ) : image.solve_status === 'solved' ? (
    <button
      className="secondary"
      onClick={() => setPublished(true)}
      disabled={working || !image.export_url}
      title={image.export_url ? 'Show this image in the public gallery' : 'Export the image first'}
    >
      Publish
    </button>
  ) : null
  const exported =
    image.export_url && image.annotated_preview_url && image.exported_at
      ? { url: image.export_url, preview: image.annotated_preview_url, at: image.exported_at }
      : null
  return (
    <article className="card">
      <div>
        <h3 title={image.title}>{image.title}</h3>
        <div className="meta">
          <span className={`badge ${image.solve_status}`}>{statusLabel(image.solve_status)}</span>
          {busy && <span>since {relativeTime(image.updated_at, now)}</span>}
          {image.published && <span className="badge published">Published</span>}
          <span>
            {image.width} × {image.height} px
          </span>
          {hasLayout(image) && <span>{image.object_count} objects</span>}
          {image.calibration && (
            <span>
              RA {image.calibration.ra.toFixed(3)}°, Dec {image.calibration.dec.toFixed(3)}°,{' '}
              {image.calibration.pixscale.toFixed(2)}″/px
            </span>
          )}
          {(image.nova_status_url || image.nova_job_log_url) && (
            <span className="nova-links">
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
            </span>
          )}
        </div>
        {image.solve_error && <p className="error">{image.solve_error}</p>}
        {shownError && <p className="error">{shownError}</p>}
        {stuck && (
          <p className="meta">
            No word from the solver for {elapsed(image.updated_at, now)}; if it is stuck, start it again.
          </p>
        )}
        <div className="actions">
          {stuck && (
            <button className="secondary" onClick={resolve} disabled={working}>
              Re-solve
            </button>
          )}
          {hasLayout(image) && (
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
          {publishToggle}
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
        {/* No thumbnail of the original (#141): the annotated preview is the card's only picture,
            and the original is a download, there from upload on. */}
        <div className="downloads">
          <p className="meta">
            <a href={image.original_url} download={image.original_name}>
              Download original
            </a>
            {exported && (
              <>
                <a href={exported.url}>Download full-resolution export</a>
                <span>exported {relativeTime(exported.at)}</span>
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
              </>
            )}
          </p>
          {exported && (
            <a href={exported.url}>
              <img src={exported.preview} alt={`${image.title} annotated`} />
            </a>
          )}
        </div>
      </div>
    </article>
  )
}
