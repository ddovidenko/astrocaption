import { describe, expect, it } from 'vitest'
import { exportState, relativeTime } from './exportStatus'

// #91: whether the last export still matches the document. Both stamps come from the server's
// utcnow_iso (second resolution, UTC), so a save and an export in the same second tie — and a
// tie is "current": the export flushes the save before it renders.
describe('exportState', () => {
  it('is "none" without an export', () => {
    expect(exportState(null, '2026-09-21T04:22:57+00:00', false)).toBe('none')
    expect(exportState(null, null, true)).toBe('none')
  })
  it('is "current" when the export is as new as the document, stale when the document is newer', () => {
    expect(exportState('2026-09-21T04:22:57+00:00', '2026-09-21T04:22:57+00:00', false)).toBe('current')
    expect(exportState('2026-09-21T04:22:57+00:00', '2026-09-21T04:20:00+00:00', false)).toBe('current')
    expect(exportState('2026-09-21T04:22:57+00:00', '2026-09-21T04:23:00+00:00', false)).toBe('stale')
  })
  it('is stale while a change has not reached the server yet', () => {
    expect(exportState('2026-09-21T04:22:57+00:00', '2026-09-21T04:20:00+00:00', true)).toBe('stale')
  })
  it('is current when the document has no stored timestamp (nothing newer exists)', () => {
    expect(exportState('2026-09-21T04:22:57+00:00', null, false)).toBe('current')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-09-21T12:00:00Z')
  const at = (iso: string) => relativeTime(iso, now)
  it('reads in the largest whole unit', () => {
    expect(at('2026-09-21T11:59:40Z')).toBe('just now')
    expect(at('2026-09-21T11:59:00Z')).toBe('1 minute ago')
    expect(at('2026-09-21T11:15:00Z')).toBe('45 minutes ago')
    expect(at('2026-09-21T10:59:00Z')).toBe('1 hour ago')
    expect(at('2026-09-21T02:00:00Z')).toBe('10 hours ago')
    expect(at('2026-09-20T11:00:00Z')).toBe('1 day ago')
    expect(at('2026-09-01T12:00:00Z')).toBe('20 days ago')
  })
  it('falls back to the date for anything older than a month, and to the raw text when unparseable', () => {
    expect(at('2026-07-01T12:00:00Z')).toBe('on 2026-07-01')
    expect(at('not a date')).toBe('not a date')
  })
  it('never reads in the future (a clock ahead of the server counts as just now)', () => {
    expect(at('2026-09-21T12:00:30Z')).toBe('just now')
  })
})
