// Typed client for the milestone-1 API. Mirrors backend/app/models.py.

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
  nova_api_key_set: boolean
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.status === 204) return undefined as T
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, body))
  return body as T
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  health: () => request<HealthOut>('/api/health'),
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
