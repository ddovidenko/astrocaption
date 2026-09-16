// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { loadBundledFont } from './fonts'
import { useEditor } from './store'
import StyleTab from './StyleTab'
import { makeDoc } from './testDoc'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, imageDefaultStyle: vi.fn() } }
})
vi.mock('./fonts', () => ({ loadBundledFont: vi.fn() }))

const doc = () => makeDoc()
// The Roboto tests pick a font makeDoc() does not list; add it so the select offers it and
// fontFor (used by the canvas, not exercised here, but kept consistent) still resolves the file
// after the commit.
const docWithRoboto = () => {
  const d = doc()
  return { ...d, fonts: [...d.fonts, { ...d.fonts[0]!, file: 'Roboto-Bold.ttf', family: 'Roboto', weight: 'Bold' }] }
}

beforeEach(() => {
  vi.useFakeTimers()
  useEditor.getState().reset()
  vi.mocked(loadBundledFont).mockReset().mockResolvedValue('Inter-Regular')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const state = () => useEditor.getState()
const fontSize = () => screen.getByLabelText('Font size (px)') as HTMLInputElement
const tick = async (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

describe('StyleTab numbers', () => {
  it('debounces keystrokes into one commit of the final value', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '1' } })
    fireEvent.change(fontSize(), { target: { value: '10' } })
    fireEvent.change(fontSize(), { target: { value: '100' } })
    expect(state().style?.font_size).toBe(24)
    await tick(400)
    expect(state().style?.font_size).toBe(100)
    expect(state().undo).toHaveLength(1)
  })
  it('blur and Enter flush at once', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '30' } })
    fireEvent.blur(fontSize())
    expect(state().style?.font_size).toBe(30)
    fireEvent.change(fontSize(), { target: { value: '40' } })
    fireEvent.keyDown(fontSize(), { key: 'Enter' })
    expect(state().style?.font_size).toBe(40)
    expect(state().undo).toHaveLength(2)
  })
  it('an invalid value commits nothing and says why', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '3' } })
    await tick(400)
    expect(state().style?.font_size).toBe(24)
    expect(fontSize().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Whole number between 6 and 200.')).toBeTruthy()
  })
  it('undo while a value is pending cancels it', async () => {
    state().load(doc())
    state().toggleObject(1) // something to undo
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '50' } })
    act(() => state().undoLast())
    await tick(400)
    expect(state().style?.font_size).toBe(24)
    expect(fontSize().value).toBe('24')
  })
  it('unmount flushes a pending value', async () => {
    state().load(doc())
    const view = render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '60' } })
    view.unmount()
    expect(state().style?.font_size).toBe(60)
  })
  it('the form follows undo', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.change(fontSize(), { target: { value: '30' } })
    fireEvent.blur(fontSize())
    act(() => state().undoLast())
    expect(fontSize().value).toBe('24')
  })
})

describe('StyleTab fonts', () => {
  it('commits a font only once the browser loaded it', async () => {
    state().load(docWithRoboto())
    let resolve!: (f: string) => void
    vi.mocked(loadBundledFont).mockReturnValue(new Promise((r) => { resolve = r }))
    render(<StyleTab />)
    const font = screen.getByLabelText('Font') as HTMLSelectElement
    fireEvent.change(font, { target: { value: 'Roboto-Bold.ttf' } })
    expect(font.disabled).toBe(true)
    expect(state().style?.font_file).toBe('Inter-Regular.ttf')
    await act(async () => { resolve('Roboto-Bold') })
    expect(state().style?.font_file).toBe('Roboto-Bold.ttf')
    expect(state().undo).toHaveLength(1)
  })
  it('keeps the previous font and shows the sentence when the load fails', async () => {
    state().load(docWithRoboto())
    vi.mocked(loadBundledFont).mockRejectedValue(new Error('Font Roboto-Bold.ttf could not be loaded.'))
    render(<StyleTab />)
    const font = screen.getByLabelText('Font') as HTMLSelectElement
    await act(async () => { fireEvent.change(font, { target: { value: 'Roboto-Bold.ttf' } }) })
    expect(state().style?.font_file).toBe('Inter-Regular.ttf')
    expect(font.value).toBe('Inter-Regular.ttf')
    expect(screen.getByText('Font Roboto-Bold.ttf could not be loaded.')).toBeTruthy()
    expect(state().undo).toHaveLength(0)
  })
  it('picking the font already in use clears a pending fallback notice with one commit', async () => {
    state().load({ ...doc(), fontFallback: { stored: 'Gone.ttf', used: 'Inter-Regular.ttf' } })
    render(<StyleTab />)
    expect(screen.getByText(/set up with Gone\.ttf/)).toBeTruthy()
    const font = screen.getByLabelText('Font') as HTMLSelectElement
    await act(async () => { fireEvent.change(font, { target: { value: 'Inter-Regular.ttf' } }) })
    expect(state().fontFallback).toBeNull()
    expect(state().undo).toHaveLength(1)
    expect(screen.queryByText(/set up with Gone\.ttf/)).toBeNull()
  })
})

describe('StyleTab reset and colour', () => {
  it("reset to site defaults is one commit of the server's style", async () => {
    state().load(doc())
    const def = { ...doc().annotations.style, font_size: 36, text_color: '#ff8800' }
    vi.mocked(api.imageDefaultStyle).mockResolvedValue(def)
    render(<StyleTab />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reset to site defaults' })) })
    expect(state().style).toEqual(def)
    expect(state().undo).toHaveLength(1)
    expect(fontSize().value).toBe('36')
  })
  it('a colour typed then closed is one commit', async () => {
    state().load(doc())
    render(<StyleTab />)
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    const hex = screen.getByRole('dialog').querySelector('input')!
    fireEvent.change(hex, { target: { value: '#ff8800' } })
    expect(state().style?.text_color).toBe('#ff8800')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(state().undo).toHaveLength(1) // the close committed the same value: no second entry
  })
  it('controls are disabled while the document is not editable', () => {
    const d = doc()
    state().load({ ...d, image: { ...d.image, solve_status: 'solving' } })
    render(<StyleTab />)
    expect(fontSize().disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reset to site defaults' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
