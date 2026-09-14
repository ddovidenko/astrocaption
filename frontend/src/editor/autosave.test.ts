import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type Annotations, type AnnotationsUpdate } from '../api'
import { AUTOSAVE_DELAY_MS, flushSave, retrySave, startAutosave } from './autosave'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

const CONFLICT = 'This image was changed elsewhere. Reload to continue editing.'

function fakeSave() {
  const calls: AnnotationsUpdate[] = []
  let release: ((r: Annotations) => void) | null = null
  let fail: ApiError | null = null
  const save = (_id: string, doc: AnnotationsUpdate): Promise<Annotations> => {
    calls.push(doc)
    if (fail) return Promise.reject(fail)
    return new Promise((resolve) => {
      release = (r) => resolve(r)
    })
  }
  const done = (doc: AnnotationsUpdate) =>
    release?.({ ...doc, version: doc.version + 1, updated_at: 't', image_id: 'img' } as Annotations)
  return { calls, save, done, setFail: (e: ApiError | null) => (fail = e) }
}

let stop: () => void
beforeEach(() => {
  vi.useFakeTimers()
  useEditor.getState().load(makeDoc())
})
afterEach(() => {
  stop?.()
  vi.useRealTimers()
})

describe('autosave', () => {
  it('saves 500 ms after the last change, once, with the labels in object order', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(300)
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1)
    expect(f.calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.version).toBe(1)
    expect(f.calls[0]!.labels.map((l) => l.object_id)).toEqual([1, 2])
    expect(useEditor.getState().save.status).toBe('saving')
    f.done(f.calls[0]!)
    await flushSave()
    expect(useEditor.getState().save.status).toBe('saved')
    expect(useEditor.getState().version).toBe(2)
  })

  it('defers a change made during a save until the save returns', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(1)
    useEditor.getState().toggleObject(2, { x: 1, y: 2 })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(1) // still in flight
    f.done(f.calls[0]!)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1]!.version).toBe(2)
  })

  it('409 → conflict with the server sentence and no further saves', async () => {
    const f = fakeSave()
    f.setFail(new ApiError(409, CONFLICT))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    await flushSave()
    expect(useEditor.getState().save).toEqual({ status: 'conflict', message: CONFLICT })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(1)
  })

  it('other failures → error, and retrySave saves again', async () => {
    const f = fakeSave()
    f.setFail(new ApiError(500, 'boom'))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    await flushSave()
    expect(useEditor.getState().save.status).toBe('error')
    f.setFail(null)
    retrySave()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(2)
  })

  it('does not save while the image is not solved', async () => {
    const doc = makeDoc()
    doc.image = { ...doc.image, solve_status: 'solving' }
    useEditor.getState().load(doc)
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(0)
    expect(useEditor.getState().save.status).toBe('dirty')
  })

  it('does not save after stop()', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    stop()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(f.calls).toHaveLength(0)
  })

  it('ignores a save response that arrives after stop()', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(1)
    stop()
    f.done(f.calls[0]!)
    await vi.advanceTimersByTimeAsync(0)
    expect(useEditor.getState().version).toBe(1)
  })

  it('retrySave() on a clean document makes no call', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    expect(useEditor.getState().save.status).toBe('saved')
    retrySave()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(0)
  })

  it("flushSave() saves at once when dirty with a timer pending, and resolves 'saved'", async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    const flushed = flushSave()
    expect(f.calls).toHaveLength(1)
    f.done(f.calls[0]!)
    expect(await flushed).toBe('saved')
  })

  it("flushSave() resolves 'error' after a failed save", async () => {
    const f = fakeSave()
    f.setFail(new ApiError(500, 'boom'))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(await flushSave()).toBe('error')
  })
})
