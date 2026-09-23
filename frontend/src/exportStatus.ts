// Whether the last export still matches the document (#91). Shared by the editor's Image tab
// and the images page card, so the two never disagree.

export type ExportState = 'none' | 'stale' | 'current'

/** The last export as `ImageOut` (or `ExportOut`) reports it, or null when there is none. */
export interface Exported {
  at: string
  /** The document version the export rendered; null for one made before it was recorded. */
  version: number | null
}

export function exportOf(image: { exported_at: string | null; exported_version: number | null }): Exported | null {
  return image.exported_at ? { at: image.exported_at, version: image.exported_version } : null
}

/** Current only when the export rendered the stored document's version. An exact match, not a
 *  clock comparison: a save landing while the render runs is stamped after the document the
 *  render read but before the export, and a time rule would call that export current. An export
 *  with no recorded version (made before the column existed) cannot vouch for itself, so it reads
 *  stale until the next export. `unsaved` is the editor's own knowledge of a change the server
 *  has not stored yet. */
export function exportState(exported: Exported | null, annotationsVersion: number | null, unsaved = false): ExportState {
  if (!exported) return 'none'
  if (unsaved || exported.version === null || exported.version !== annotationsVersion) return 'stale'
  return 'current'
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "3 minutes ago", "2 hours ago", "5 days ago", then "on 2026-07-01"; the raw text
 *  when it does not parse. A stamp ahead of the browser's clock reads as just now. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const ago = now - t
  if (ago < MINUTE) return 'just now'
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'} ago`
  if (ago < HOUR) return unit(Math.floor(ago / MINUTE), 'minute')
  if (ago < DAY) return unit(Math.floor(ago / HOUR), 'hour')
  if (ago < 31 * DAY) return unit(Math.floor(ago / DAY), 'day')
  return `on ${new Date(t).toISOString().slice(0, 10)}`
}
