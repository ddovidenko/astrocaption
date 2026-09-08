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
  nova_submission_id: number | null
  nova_job_id: number | null
  nova_status_url: string | null
  nova_job_log_url: string | null
  calibration: Calibration | null
  published: boolean
  object_count: number
  exported_at: string | null
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
  config_error: string | null
}

export interface ConfigOut {
  site_title: string
  max_upload_mb: number
  nova_api_key_set: boolean
  default_style: Record<string, unknown>
  locked: string[]
}

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
  encoding: string
}

export interface SolveHints {
  focal_length_mm?: number
  pixel_size_um?: number
  scale_tolerance_pct?: number
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Extract a human-readable message from a FastAPI error body. */
export function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
        .filter(Boolean)
      if (msgs.length) return msgs.join('; ')
    }
  }
  return `Request failed (HTTP ${status})`
}

/** Parse a response body; a 2xx that is not JSON (e.g. the dev server answering with
 *  index.html when the API is unreachable) is an error, not a silent null. */
export function parseBody(status: number, ok: boolean, text: string): unknown {
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
  if (!ok) throw new ApiError(status, errorMessage(status, body))
  return body
}

let onUnauthorized: (() => void) | null = null

/** Called once per 401 outside the login call, so the shell can send the user to /login. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

export function isSessionLoss(url: string, status: number): boolean {
  return status === 401 && url !== '/api/login'
}

/** True when `err` is the ApiError the shell's 401 handler is about to act on; callers that
 *  display page-level errors should skip setting one for it (the shell is already redirecting). */
export function isSessionLossError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (isSessionLoss(url, res.status)) onUnauthorized?.()
  if (res.status === 204) return undefined as T
  return parseBody(res.status, res.ok, await res.text()) as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  health: () => request<HealthOut>('/api/health'),
  setup: (body: SetupRequest) => request<void>('/api/setup', json('POST', body)),
  login: (password: string) => request<void>('/api/login', json('POST', { password })),
  logout: () => request<void>('/api/logout', json('POST')),
  config: () => request<ConfigOut>('/api/config'),
  listImages: () => request<ImageOut[]>('/api/images'),
  upload(file: File, title: string): Promise<ImageOut> {
    const form = new FormData()
    form.append('file', file)
    if (title.trim()) form.append('title', title.trim())
    return request<ImageOut>('/api/images', { method: 'POST', body: form })
  },
  resolve: (id: string, hints?: SolveHints) =>
    request<ImageOut>(`/api/images/${id}/solve`, json('POST', hints)),
  /** `quality` null = match the original JPEG's tables and subsampling (the default). */
  exportImage: (id: string, quality: number | null, scale: number) =>
    request<ExportOut>(`/api/images/${id}/export`, json('POST', { quality, scale })),
  deleteImage: (id: string) => request<void>(`/api/images/${id}`, { method: 'DELETE' }),
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
