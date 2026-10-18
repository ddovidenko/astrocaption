import { describe, expect, it } from 'vitest'
import { dayLabel } from './day'

describe('dayLabel', () => {
  it('names the UTC day of a stamp, the day the From/To filters select on', () => {
    expect(dayLabel('2026-09-22T10:00:00Z')).toBe('22 Sep 2026')
    expect(dayLabel('2026-09-22T23:30:00+00:00')).toBe('22 Sep 2026')
  })
})
