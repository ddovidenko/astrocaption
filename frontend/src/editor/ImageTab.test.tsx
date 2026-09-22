// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import ImageTab from './ImageTab'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, exportImage: vi.fn() } }
})

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-09-21T12:00:00Z') })
  useEditor.getState().reset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.mocked(api.exportImage).mockReset()
})

const exportLine = () => screen.getByTestId('export-state')

// #91: the line above Export says whether the last export still matches the document.
describe('ImageTab export state', () => {
  it('says the image was never exported', () => {
    useEditor.getState().load(makeDoc())
    render(<ImageTab />)
    expect(exportLine().textContent).toBe('Not exported yet')
  })

  it('says when the export is current, with a relative time', () => {
    const doc = makeDoc()
    doc.image = { ...doc.image, exported_at: '2026-09-21T11:50:00Z', export_url: '/x', annotated_preview_url: '/p' }
    doc.annotations = { ...doc.annotations, updated_at: '2026-09-21T11:40:00Z' }
    useEditor.getState().load(doc)
    render(<ImageTab />)
    expect(exportLine().textContent).toBe('Exported 10 minutes ago')
  })

  it('flags changes since the export, from a saved document and from a pending one, and Export clears it', async () => {
    const doc = makeDoc()
    doc.image = { ...doc.image, exported_at: '2026-09-21T11:50:00Z', export_url: '/x', annotated_preview_url: '/p' }
    doc.annotations = { ...doc.annotations, updated_at: '2026-09-21T11:55:00Z' }
    useEditor.getState().load(doc)
    render(<ImageTab />)
    expect(exportLine().textContent).toBe('Changes since the last export')
    expect(exportLine().classList.contains('stale')).toBe(true)

    // Export: the document is saved at 11:55, the render lands at 12:00 → current again.
    vi.mocked(api.exportImage).mockResolvedValue({
      export_url: '/x',
      annotated_preview_url: '/p',
      width: 3000,
      height: 2000,
      bytes: 1024,
      exported_at: '2026-09-21T12:00:00Z',
      encoding: 'q',
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Export' }).click()
      await vi.runAllTimersAsync()
    })
    expect(exportLine().textContent).toBe('Exported just now')

    // An edit not yet saved is already "changes": the export cannot hold it.
    act(() => useEditor.getState().setStyle({ font_size: 30 }))
    expect(exportLine().textContent).toBe('Changes since the last export')
  })
})
