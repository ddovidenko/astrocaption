import { describe, expect, it } from 'vitest'
import { exportOf, exportState, relativeTime } from './exportStatus'

// #91: whether the last export still matches the document, by content: the hash of the document
// the export rendered against the stored document's hash. Never a version or a clock: an undo back
// to the exported document is a new version with the same content, and a save landing during the
// render has a later stamp than the document the render read.
describe('exportState', () => {
  const at = '2026-09-21T04:22:57+00:00'
  it('is "none" without an export', () => {
    expect(exportState(null, 'abc')).toBe('none')
    expect(exportState(null, null, true)).toBe('none')
  })
  it('is current when the export rendered the stored document, stale when the content differs', () => {
    expect(exportState({ at, hash: 'abc' }, 'abc')).toBe('current')
    expect(exportState({ at, hash: 'abc' }, 'abd')).toBe('stale')
  })
  it('is stale while a change has not reached the server yet', () => {
    expect(exportState({ at, hash: 'abc' }, 'abc', true)).toBe('stale')
  })
  it('is stale for an export made before the hash was recorded (it cannot vouch for itself)', () => {
    expect(exportState({ at, hash: null }, 'abc')).toBe('stale')
  })
  it('exportOf reads the pair off an image', () => {
    expect(exportOf({ exported_at: null, exported_hash: null })).toBeNull()
    expect(exportOf({ exported_at: at, exported_hash: 'abc' })).toEqual({ at, hash: 'abc' })
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
