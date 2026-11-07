import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { getMeasurer } from './editing'
import { loadFonts } from './fonts'
import { loadEditor } from './load'
import type { TextMeasurer } from './metrics'
import probe from './probe-strings.json'
import type { LoadedDocument } from './store'
import { makeDoc } from './testDoc'

vi.mock('../api', () => ({ api: { image: vi.fn(), objects: vi.fn(), annotations: vi.fn(), fonts: vi.fn() } }))
vi.mock('./fonts', () => ({ loadFonts: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./editing', () => ({ getMeasurer: vi.fn() }))

/** A measurer that returns Pillow's width for every probe string, plus `drift` px. */
function measuringLikePillow(drift = 0): TextMeasurer {
  return (text, file, size) => {
    const entry = probe.find((p) => p.file === file && p.size === size && p.text === text)
    if (!entry) throw new Error(`unexpected measurement ${file} ${size} ${text}`)
    return entry.width + drift
  }
}

function mockApi(doc: LoadedDocument) {
  vi.mocked(api.image).mockResolvedValue(doc.image)
  vi.mocked(api.objects).mockResolvedValue(doc.objects)
  vi.mocked(api.annotations).mockResolvedValue(doc.annotations)
  vi.mocked(api.fonts).mockResolvedValue(doc.fonts)
}

describe('loadEditor', () => {
  beforeEach(() => {
    vi.mocked(getMeasurer).mockReturnValue(measuringLikePillow())
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when the browser measures the document font off by more than 0.5 px (#72)', async () => {
    // The check is behavioural, not a feature sniff: Safari has no canvas `textRendering` yet
    // measures within 0.25 px, while a hinted canvas drifts along a long string.
    mockApi(makeDoc())
    vi.mocked(getMeasurer).mockReturnValue(measuringLikePillow(0.75))
    await expect(loadEditor('img-1')).rejects.toThrow(
      'This browser does not measure text the way the export does (widths off by up to 0.75 px); ' +
        'the editor needs a current browser such as Chrome, Edge, Firefox or Safari.',
    )
    // Measured after the font loaded: an unloaded family would measure a fallback face.
    expect(loadFonts).toHaveBeenCalledWith(['Inter-Regular.ttf'])
  })

  it('accepts a browser within the tolerance and measures only the document font', async () => {
    mockApi(makeDoc())
    const measure = vi.fn(measuringLikePillow(0.5))
    vi.mocked(getMeasurer).mockReturnValue(measure)
    await expect(loadEditor('img-1')).resolves.toBeTruthy()
    const files = new Set(measure.mock.calls.map(([, file]) => file))
    expect([...files]).toEqual(['Inter-Regular.ttf'])
    expect(measure.mock.calls.length).toBe(probe.filter((p) => p.file === 'Inter-Regular.ttf').length)
  })

  it('rejects a browser whose widths come back NaN instead of letting them through the comparison', async () => {
    mockApi(makeDoc())
    vi.mocked(getMeasurer).mockReturnValue(() => Number.NaN)
    await expect(loadEditor('img-1')).rejects.toThrow(
      'This browser does not measure text the way the export does (text widths could not be measured); ' +
        'the editor needs a current browser such as Chrome, Edge, Firefox or Safari.',
    )
  })

  it('passes the server-reported fallback through', async () => {
    const doc = makeDoc()
    mockApi({ ...doc, annotations: { ...doc.annotations, font_fallback: 'Lato-Regular.ttf' } })
    expect((await loadEditor('img-1')).fontFallback).toEqual({ stored: 'Lato-Regular.ttf', used: 'Inter-Regular.ttf' })
    expect(loadFonts).toHaveBeenCalledWith(['Inter-Regular.ttf'])
  })

  it('rejects when the served font is not in the font list (a broken bundle)', async () => {
    const doc = makeDoc()
    mockApi({
      ...doc,
      fonts: [{ ...doc.fonts[0]!, file: 'Other.ttf' }],
      annotations: { ...doc.annotations, style: { ...doc.annotations.style, font_file: 'Gone.ttf' } },
    })
    await expect(loadEditor('img-1')).rejects.toThrow('is not listed by the server')
  })
})
