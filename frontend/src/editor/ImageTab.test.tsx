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
    doc.image = { ...doc.image, exported_at: '2026-09-21T11:50:00Z', exported_hash: 'hash-1', export_url: '/x', annotated_preview_url: '/p' }
    useEditor.getState().load(doc)
    render(<ImageTab />)
    expect(exportLine().textContent).toBe('Exported 10 minutes ago')
    // The relative time keeps moving while the tab sits idle.
    act(() => {
      vi.advanceTimersByTime(60 * 60_000)
    })
    expect(exportLine().textContent).toBe('Exported 1 hour ago')
  })

  it('flags changes since the export, from a saved document and from a pending one, and Export clears it', async () => {
    const doc = makeDoc()
    doc.image = { ...doc.image, exported_at: '2026-09-21T11:50:00Z', exported_hash: 'hash-0', export_url: '/x', annotated_preview_url: '/p' }
    useEditor.getState().load(doc)
    render(<ImageTab />)
    expect(exportLine().textContent).toBe('Changes since the last export')
    expect(exportLine().classList.contains('stale')).toBe(true)
    expect(screen.getByRole('button', { name: 'Export' }).classList.contains('secondary')).toBe(false)

    // Export: renders the stored document → current again.
    vi.mocked(api.exportImage).mockResolvedValue({
      export_url: '/x',
      annotated_preview_url: '/p',
      width: 3000,
      height: 2000,
      bytes: 1024,
      exported_at: '2026-09-21T12:00:00Z',
      exported_hash: 'hash-1',
      encoding: 'q',
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Export' }).click()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(exportLine().textContent).toBe('Exported just now')

    // An edit not yet saved is already "changes": the export cannot hold it.
    act(() => useEditor.getState().setStyle({ font_size: 30 }))
    expect(exportLine().textContent).toBe('Changes since the last export')
    // ...and a save that lands with a different content is still "changes"...
    act(() => {
      useEditor.getState().markSaving() // what the autosave does before its PUT
      useEditor.getState().markSaved(3, '2026-09-21T12:01:00Z', 'hash-2')
    })
    expect(exportLine().textContent).toBe('Changes since the last export')
    // ...but an undo back to the exported document (a new version, the same content) reads as
    // exported again — the reason the rule is by content, not by version.
    act(() => {
      useEditor.getState().undoLast()
      useEditor.getState().markSaving()
      useEditor.getState().markSaved(4, '2026-09-21T12:01:30Z', 'hash-1')
    })
    expect(exportLine().textContent).toBe('Exported just now')

    // A save in conflict is still "changes", but Export is not pushed as the next step: it would
    // only fail with the conflict message.
    act(() => useEditor.getState().markConflict('This image was changed elsewhere.'))
    expect(exportLine().textContent).toBe('Changes since the last export')
    expect(screen.getByRole('button', { name: 'Export' }).classList.contains('secondary')).toBe(true)
  })

  it('a failed export keeps the earlier successful one on the line', async () => {
    useEditor.getState().load(makeDoc()) // never exported
    render(<ImageTab />)
    vi.mocked(api.exportImage).mockResolvedValueOnce({
      export_url: '/x',
      annotated_preview_url: '/p',
      width: 3000,
      height: 2000,
      bytes: 1024,
      exported_at: '2026-09-21T12:00:00Z',
      exported_hash: 'hash-1',
      encoding: 'q',
    })
    await act(async () => {
      screen.getByRole('button', { name: 'Export' }).click()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(exportLine().textContent).toBe('Exported just now')
    vi.mocked(api.exportImage).mockRejectedValueOnce(new Error('network'))
    await act(async () => {
      screen.getByRole('button', { name: 'Export' }).click()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText('network', { exact: false })).toBeTruthy()
    expect(exportLine().textContent).toBe('Exported just now')
  })
})
