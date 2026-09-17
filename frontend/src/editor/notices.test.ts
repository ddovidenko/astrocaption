import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawErrorNotice, isStaleDocumentStatus, previewErrorSentence, probeStatus } from './notices'

afterEach(() => vi.unstubAllGlobals())

describe('previewErrorSentence', () => {
  it('names the session for a 401 and a reload otherwise', () => {
    expect(previewErrorSentence(401)).toBe('Your session has expired. Log in again.')
    expect(previewErrorSentence(500)).toBe(
      'The preview could not be loaded. Reload the page; if it keeps failing, re-upload the image.',
    )
    expect(previewErrorSentence(null)).toBe(previewErrorSentence(500))
  })
})

describe('probeStatus', () => {
  it('returns the HEAD status, or null when the probe itself fails', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ status: 401 }).mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetch)
    expect(await probeStatus('/preview')).toBe(401)
    expect(fetch).toHaveBeenCalledWith('/preview', { method: 'HEAD', credentials: 'same-origin' })
    expect(await probeStatus('/preview')).toBeNull()
  })
})

describe('drawErrorNotice', () => {
  it('counts, names the first object and warns about the export', () => {
    expect(drawErrorNotice(1, 'M 42', 'the ascent table is missing')).toBe(
      'The label for M 42 could not be drawn: the ascent table is missing. The export may differ from this preview.',
    )
    expect(drawErrorNotice(3, 'M 42', 'x')).toBe(
      '3 labels could not be drawn (first: M 42): x. The export may differ from this preview.',
    )
  })
})

describe('isStaleDocumentStatus', () => {
  it('is the validation statuses only', () => {
    expect([400, 422].map(isStaleDocumentStatus)).toEqual([true, true])
    expect([401, 404, 409, 500].map(isStaleDocumentStatus)).toEqual([false, false, false, false])
  })
})
