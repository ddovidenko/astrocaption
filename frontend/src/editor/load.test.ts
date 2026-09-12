import { afterEach, describe, expect, it } from 'vitest'
import { loadEditor } from './load'

describe('loadEditor', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'CanvasRenderingContext2D')
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
})
