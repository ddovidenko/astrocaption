import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { loadFonts } from './fonts'
import { loadEditor } from './load'
import type { LoadedDocument } from './store'
import { makeDoc } from './testDoc'

vi.mock('../api', () => ({ api: { image: vi.fn(), objects: vi.fn(), annotations: vi.fn(), fonts: vi.fn() } }))
vi.mock('./fonts', () => ({ loadFonts: vi.fn().mockResolvedValue(undefined) }))

function mockApi(doc: LoadedDocument) {
  vi.mocked(api.image).mockResolvedValue(doc.image)
  vi.mocked(api.objects).mockResolvedValue(doc.objects)
  vi.mocked(api.annotations).mockResolvedValue(doc.annotations)
  vi.mocked(api.fonts).mockResolvedValue(doc.fonts)
}

describe('loadEditor', () => {
  beforeEach(() => {
    // The test environment is plain node: there is no real CanvasRenderingContext2D at all, let
    // alone one with `textRendering`. Stub a browser-capable one so loadEditor's pre-flight check
    // passes; the one test that wants a Firefox-shaped prototype overrides this with its own.
    Object.defineProperty(globalThis, 'CanvasRenderingContext2D', { value: class {}, configurable: true })
    CanvasRenderingContext2D.prototype.textRendering = 'auto'
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'CanvasRenderingContext2D')
    vi.clearAllMocks()
  })

  it('rejects before any fetch when the browser cannot measure text like the export', async () => {
    // Stubs a Firefox-shaped prototype: no `textRendering`, so the browser cannot draw text the
    // way Pillow does. No fetch mocking needed — the check runs before the network calls.
    Object.defineProperty(globalThis, 'CanvasRenderingContext2D', {
      value: class {},
      configurable: true,
    })
    await expect(loadEditor('img-1')).rejects.toThrow(
      'This browser cannot measure text the way the export does (no canvas textRendering support); ' +
        'the editor needs a current browser such as Chrome, Edge or Safari.',
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
