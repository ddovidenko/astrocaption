// Typed client for the API. Mirrors backend/app/models.py.

export type SolveStatus = 'pending' | 'solving' | 'solved' | 'failed'

export interface Calibration {
  ra: number
  dec: number
  radius: number
  pixscale: number
  orientation: number
  parity: number
}

export interface ImageOut {
  id: string
  title: string
  original_name: string
  created_at: string
  updated_at: string
  width: number
  height: number
  solve_status: SolveStatus
  solve_error: string | null
  /** The failed solve timed out with a stored nova submission, so Check again can resume it. */
  check_available: boolean
  nova_submission_id: number | null
  nova_job_id: number | null
  nova_status_url: string | null
  nova_job_log_url: string | null
  calibration: Calibration | null
  published: boolean
  object_count: number
  exported_at: string | null
  /** The stored document's content hash (null until a solve stores one) and the hash of the
   *  document the last export rendered (null for one made before it was recorded); `exportState`
   *  compares them (#91). */
  annotations_hash: string | null
  exported_hash: string | null
  original_format: string
  preview_url: string
  thumb_url: string
  original_url: string
  annotated_preview_url: string | null
  export_url: string | null
}

export interface HealthOut {
  status: 'ok'
  version: string
  site_title: string
  setup_required: boolean
  authenticated: boolean
  /** False when the owner switched the public gallery off: the logged-out shell then shows
   *  only the title and a sign-in link, and never calls /api/gallery. */
  public_gallery_enabled: boolean
  config_error: string | null
  /** Field names pinned by environment variables; the setup page shows them disabled. */
  locked: string[]
}

export type NamePreference = 'popular' | 'ngc_ic'

export type LeaderMode = 'auto' | 'on' | 'off'

/** Global style of one image, in original-image pixels. Mirrors StyleConfig. */
export interface StyleConfig {
  font_file: string
  font_size: number
  text_color: string
  marker_color: string
  leader_color: string
  halo: boolean
  halo_color: string
  halo_width: number
  marker_width: number
  marker_min_radius: number
  show_aliases: boolean
  max_aliases: number
  name_preference: NamePreference
}

/** One object's call-out; `x, y` is the top-left of the text box in original pixels. Mirrors Label. */
export interface Label {
  object_id: number
  enabled: boolean
  x: number
  y: number
  font_size: number | null
  text_override: string | null
  color: string | null
  show_aliases: boolean | null
  leader: LeaderMode
  collided: boolean
  /** Kept where the owner put it: a drag pins; Reset position / Reset positions unpin. The
   *  server's placer treats a pinned label as a fixed obstacle. */
  pinned: boolean
}

export interface Annotations {
  image_id: string
  style: StyleConfig
  labels: Label[]
  version: number
  updated_at: string
  /** Set when the stored style names a font file the server no longer bundles: the server
   *  already served the default in its place, and this names the one it replaced. */
  font_fallback: string | null
  /** The stored document's identity by content, on every GET and PUT response (null on an
   *  autoarrange result, which stores nothing); `exportState` compares it with `exported_hash`. */
  content_hash: string | null
}

/** What the editor sends back: its document minus the server-owned fields. Mirrors AnnotationsUpdate. */
export type AnnotationsUpdate = Pick<Annotations, 'style' | 'labels' | 'version'>

export type ObjectKind = 'galaxy' | 'nebula' | 'cluster' | 'star' | 'other'

/** A catalogued object. `primary_name` is the server's ranking under the preference stored at
 *  fetch time (used by the plain export page); the editor ranks `catalog_names` itself with
 *  `names.ts` so a Style-tab preference change updates every name at once (#94). `kind` is the
 *  Objects-tab bucket (nova `bright`/`hd` rows are `star`; OpenNGC classifies the rest). */
export interface ObjectOut {
  id: number
  catalog_names: string[]
  primary_name: string
  type: string
  kind: ObjectKind
  x: number
  y: number
  radius: number
}

/** The owner's default_style: only the fields they chose to override. Mirrors StyleOverrides. */
export type StyleOverrides = Partial<StyleConfig>

/** Built-in values for fields with no override (sizes are per image, so not listed). */
export interface StyleDefaults {
  font_file: string
  text_color: string
  marker_color: string
  leader_color: string
  halo: boolean
  halo_color: string
  show_aliases: boolean
  max_aliases: number
  name_preference: NamePreference
}

export interface ConfigOut {
  site_title: string
  max_upload_mb: number
  public_gallery_enabled: boolean
  nova_api_key_set: boolean
  default_style: StyleOverrides
  style_defaults: StyleDefaults
  locked: string[]
  /** Locked field -> the environment variable that pins it (never its value). */
  locked_by: Record<string, string>
}

/** Partial: absent keeps, `nova_api_key: null` clears; `default_style` replaces the override set. */
export interface ConfigUpdate {
  site_title?: string
  max_upload_mb?: number
  public_gallery_enabled?: boolean
  nova_api_key?: string | null
  default_style?: StyleOverrides
}

export interface FontOut {
  file: string
  family: string
  weight: string
  sample: string
  /** Pillow's ascent at every allowed size, index `size - MIN_FONT_SIZE` (6..200); see editor/metrics.ts. */
  ascents: number[]
}

/** The owner-password bounds, as validate_new_password() enforces them (models.py). Mirrored
 *  here so every password input in the app states the same rule the server will apply. */
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 1024

export interface SetupRequest {
  password: string
  nova_api_key?: string
  site_title?: string
}

export interface ExportOut {
  export_url: string
  annotated_preview_url: string
  width: number
  height: number
  bytes: number
  exported_at: string
  exported_hash: string
  encoding: string
}

/** One published image as the public gallery serves it. Mirrors GalleryItem. All URLs are
 *  under /api/gallery and need no session. */
export interface GalleryItem {
  id: string
  title: string
  width: number
  height: number
  exported_at: string
  thumb_url: string
  preview_url: string
  annotated_preview_url: string
  export_url: string
}

export interface SolveHints {
  focal_length_mm?: number
  pixel_size_um?: number
  scale_tolerance_pct?: number
}

export class ApiError extends Error {
  readonly status: number
  /** Decided once, in `settle()`: this 401 is the shell's cue to send the user to /login. */
  readonly sessionLost: boolean
  constructor(status: number, message: string, sessionLost = false) {
    super(message)
    this.status = status
    this.sessionLost = sessionLost
  }
}

/** Extract a human-readable message from a FastAPI error body. The backend's 422 handler
 *  always answers with a plain string detail, so there is no list form to unpack. */
export function errorMessage(status: number, body: unknown, fallback?: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
  }
  return fallback ?? `Request failed (HTTP ${status})`
}

/** Parse a response body; a 2xx that is not JSON (e.g. the dev server answering with
 *  index.html when the API is unreachable) is an error, not a silent null. */
/** `fallbacks`: per-status sentences for bodies that carry no `detail` (a reverse proxy's own
 *  page); the API's own message always wins. */
export function parseBody(
  status: number,
  ok: boolean,
  text: string,
  sessionLost = false,
  fallbacks?: Record<number, string>,
): unknown {
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      if (ok) {
        throw new ApiError(status, 'The server returned something that is not JSON. Is the API running?')
      }
    }
  }
  if (!ok) throw new ApiError(status, errorMessage(status, body, fallbacks?.[status]), sessionLost)
  return body
}

let onUnauthorized: (() => void) | null = null

/** Called once per session-losing 401, so the shell can send the user to /login. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

/** True when `err` is the ApiError the shell's 401 handler is about to act on; callers that
 *  display page-level errors should skip setting one for it (the shell is already redirecting).
 *  It reads the flag `settle()` set, so the rule lives in exactly one place. */
export function isSessionLossError(err: unknown): boolean {
  return err instanceof ApiError && err.sessionLost
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

/** The message a page should show for `err`, or null when the shell is already redirecting
 *  because the session was lost. */
export function pageError(err: unknown): string | null {
  return isSessionLossError(err) ? null : describeError(err)
}

interface RequestOptions {
  /** A 401 means the session is gone. The login call opts out: its 401 is a wrong password. */
  sessionAware?: boolean
}

/** Turn a finished response into its parsed body, or throw the ApiError it deserves. Both
 *  transports end here, so the 401 rule lives in exactly one place: a session-aware 401 tells
 *  the shell to send the user to /login and marks the error so pages skip their own message. */
function settle<T>(
  status: number,
  text: string,
  sessionAware = true,
  fallbacks?: Record<number, string>,
): T {
  const lost = sessionAware && status === 401
  if (lost) onUnauthorized?.()
  if (status === 204) return undefined as T
  return parseBody(status, status >= 200 && status < 300, text, lost, fallbacks) as T
}

async function request<T>(url: string, init?: RequestInit, { sessionAware = true }: RequestOptions = {}): Promise<T> {
  const res = await fetch(url, init)
  return settle<T>(res.status, await res.text(), sessionAware)
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export type UploadProgress = (sent: number, total: number) => void

/** A big upload over a slow line is normal; only a stall this long is a failure. */
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** Statuses a reverse proxy in front of the app answers itself, with its own HTML page rather
 *  than this API's JSON; the generic "Request failed (HTTP n)" says nothing about what to do.
 *  Used only when the body carried no `detail` — the API's own message always wins. */
const PROXY_UPLOAD_MESSAGES: Record<number, string> = {
  413: 'The file is larger than the upload limit; the server or a reverse proxy refused it.',
  502: 'The server did not answer the upload in time. Try again.',
  504: 'The server did not answer the upload in time. Try again.',
}

/** Multipart POST over XMLHttpRequest — the one browser transport that reports upload
 *  progress — with the same session and error handling as `request()`: a 401 sends the shell to
 *  /login, every body goes through `parseBody`. `XHR` is injectable for tests. */
export function uploadForm<T>(
  url: string,
  form: FormData,
  onProgress?: UploadProgress,
  XHR: typeof XMLHttpRequest = XMLHttpRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XHR()
    xhr.open('POST', url)
    xhr.timeout = UPLOAD_TIMEOUT_MS
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    }
    // A refused upload is often cut off mid-body, which the browser reports as a transport
    // error with no status at all; the size is the first thing to check when that happens.
    xhr.onerror = () =>
      reject(
        new Error(
          'The upload did not finish: the connection dropped, or the server refused the file' +
            ' before it was fully sent (check the size against the upload limit).',
        ),
      )
    xhr.ontimeout = () =>
      reject(new Error('The upload timed out. Check the connection and try again.'))
    xhr.onabort = () => reject(new Error('The upload was cancelled.'))
    xhr.onload = () => {
      try {
        resolve(settle<T>(xhr.status, xhr.responseText, true, PROXY_UPLOAD_MESSAGES))
      } catch (err) {
        reject(err)
      }
    }
    xhr.send(form)
  })
}

export const api = {
  health: () => request<HealthOut>('/api/health'),
  setup: (body: SetupRequest) => request<void>('/api/setup', json('POST', body)),
  login: (password: string) =>
    request<void>('/api/login', json('POST', { password }), { sessionAware: false }),
  logout: () => request<void>('/api/logout', json('POST')),
  /** 403 = wrong current password (ApiError.message); a 401 here is a lost session like anywhere. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/password', json('POST', { current_password: currentPassword, new_password: newPassword })),
  config: () => request<ConfigOut>('/api/config'),
  fonts: () => request<FontOut[]>('/api/fonts'),
  updateConfig: (body: ConfigUpdate) => request<ConfigOut>('/api/config', json('PUT', body)),
  listImages: () => request<ImageOut[]>('/api/images'),
  image: (id: string) => request<ImageOut>(`/api/images/${id}`),
  /** The style an image would use with no owner overrides: the site defaults with the config's
   *  `default_style` applied. Used to preview or reset a per-image style in the Style tab. */
  imageDefaultStyle: (id: string) => request<StyleConfig>(`/api/images/${id}/default-style`),
  upload(file: File, title: string, onProgress?: UploadProgress): Promise<ImageOut> {
    const form = new FormData()
    form.append('file', file)
    if (title.trim()) form.append('title', title.trim())
    return uploadForm<ImageOut>('/api/images', form, onProgress)
  },
  resolve: (id: string, hints?: SolveHints) =>
    request<ImageOut>(`/api/images/${id}/solve`, json('POST', hints)),
  /** Check again (#10): resumes the stored nova job of a failed row; a 409 says why it cannot. */
  checkSolve: (id: string) => request<ImageOut>(`/api/images/${id}/check`, json('POST')),
  objects: (id: string) => request<ObjectOut[]>(`/api/images/${id}/objects`),
  annotations: (id: string) => request<Annotations>(`/api/images/${id}/annotations`),
  /** A 409 (ApiError.status) means the save was refused; show err.message: either the stored
   *  version moved (reload) or a solve is running. */
  saveAnnotations: (id: string, doc: AnnotationsUpdate) =>
    request<Annotations>(`/api/images/${id}/annotations`, json('PUT', doc)),
  /** A 409 (ApiError.status) means the save was refused; show err.message: either the stored
   *  version moved (reload) or a solve is running. `reset` unpins every label first (the Layout
   *  tab's Reset positions). */
  autoarrange: (id: string, doc: AnnotationsUpdate, reset = false) =>
    request<Annotations>(`/api/images/${id}/autoarrange`, json('POST', { ...doc, reset })),
  /** `quality` null = match the original JPEG's tables and subsampling (the default). */
  exportImage: (id: string, quality: number | null, scale: number) =>
    request<ExportOut>(`/api/images/${id}/export`, json('POST', { quality, scale })),
  deleteImage: (id: string) => request<void>(`/api/images/${id}`, { method: 'DELETE' }),
  /** 409 (ApiError.status) = the image has no export yet; show err.message. */
  setPublished: (id: string, published: boolean) =>
    request<ImageOut>(`/api/images/${id}/published`, json('PUT', { published })),
  // Public: no session. A 404 means unpublished, unknown, or the gallery is switched off.
  gallery: () => request<GalleryItem[]>('/api/gallery', undefined, { sessionAware: false }),
  galleryImage: (id: string) => request<GalleryItem>(`/api/gallery/${id}`, undefined, { sessionAware: false }),
}

export function statusLabel(status: SolveStatus): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'solving':
      return 'Solving…'
    case 'solved':
      return 'Solved'
    case 'failed':
      return 'Failed'
  }
}

export function isBusy(status: SolveStatus): boolean {
  return status === 'pending' || status === 'solving'
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Arc-seconds per pixel from focal length (mm) and pixel size (µm); null when incomplete. */
export function arcsecPerPixel(focalLengthMm: number, pixelSizeUm: number): number | null {
  if (!(focalLengthMm > 0) || !(pixelSizeUm > 0)) return null
  return (206.265 * pixelSizeUm) / focalLengthMm
}
