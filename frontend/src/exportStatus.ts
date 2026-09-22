// Whether the last export still matches the document (#91). Shared by the editor's Image tab
// and the images page card, so the two never disagree.

export type ExportState = 'none' | 'stale' | 'current'

/** `exportedAt` and `annotationsUpdatedAt` are the server's ISO stamps (utcnow_iso: UTC, second
 *  resolution, one format), so a plain string compare orders them. A tie is current: the editor
 *  flushes the save before it exports, so the export made in the same second holds that save.
 *  `unsaved` is the editor's own knowledge of a change the server has not stored yet. */
export function exportState(exportedAt: string | null, annotationsUpdatedAt: string | null, unsaved: boolean): ExportState {
  if (!exportedAt) return 'none'
  if (unsaved) return 'stale'
  if (annotationsUpdatedAt && annotationsUpdatedAt > exportedAt) return 'stale'
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
