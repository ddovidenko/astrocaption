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

  it('a save that throws synchronously becomes the error state and does not block the next', async () => {
    const f = fakeSave()
    let boom = true
    const save = (id: string, doc: AnnotationsUpdate) => {
      if (boom) throw new Error('bad document')
      return f.save(id, doc)
    }
    stop = startAutosave('img', { save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(useEditor.getState().save.status).toBe('error')
    boom = false
    retrySave()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(1)
    f.done(f.calls[0]!)
    expect(await flushSave()).toBe('saved')
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

  it('422 → the stale-document sentence in the conflict state, with the history cleared', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    f.setFail(new ApiError(422, "labels: the document must list every one of this image's objects."))
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(useEditor.getState().save).toEqual({
      status: 'conflict',
      message: "This image's objects changed; reload the editor.",
    })
    expect(useEditor.getState().undo).toEqual([])
  })

  it('a 422 that is not about the objects stays the retryable error state, history kept', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    f.setFail(new ApiError(422, 'style.font_file is not a bundled font.'))
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(useEditor.getState().save).toEqual({
      status: 'error',
      message: 'style.font_file is not a bundled font.',
    })
    expect(useEditor.getState().undo).toHaveLength(1)
  })

  it('other failures → error, and retrySave saves again', async () => {
    const f = fakeSave()
    f.setFail(new ApiError(500, 'boom'))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(useEditor.getState().save.status).toBe('error')
    expect(f.calls).toHaveLength(1)
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
    expect(useEditor.getState().save.status).toBe('saved')
  })

  // SPEC § 5: a failed re-solve leaves the previous layout editable, and the server accepts the
  // PUT. Only a solve in progress is read-only.
  it('saves after a failed re-solve', async () => {
    const doc = makeDoc()
    doc.image = { ...doc.image, solve_status: 'failed' }
    useEditor.getState().load(doc)
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(1)
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

  it("flushSave() resolves 'error' after a failed save, having tried once more", async () => {
    const f = fakeSave()
    f.setFail(new ApiError(500, 'boom'))
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(useEditor.getState().save.status).toBe('error')
    expect(f.calls).toHaveLength(1)
    expect(await flushSave()).toBe('error')
    expect(f.calls).toHaveLength(2) // one more attempt, and then it gives up
  })

  it('flushSave() sends a change made during an in-flight save before it resolves', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(f.calls).toHaveLength(1) // in flight
    useEditor.getState().toggleObject(2, { x: 1, y: 2 })
    const flushed = flushSave()
    f.done(f.calls[0]!)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(2) // the change made while the first save was in flight
    expect(f.calls[1]!.labels.find((l) => l.object_id === 2)).toMatchObject({ enabled: true, x: 1, y: 2 })
    f.done(f.calls[1]!)
    expect(await flushed).toBe('saved')
  })

  it('a flush from a retired controller neither saves nor cancels the new one', async () => {
    const a = fakeSave()
    const first = startAutosave('img-a', { save: a.save })
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(a.calls).toHaveLength(1) // in flight for image A
    const flushed = flushSave()
    // Image B takes over while A's flush is waiting on A's save.
    const b = fakeSave()
    stop = startAutosave('img-b', { save: b.save })
    a.done(a.calls[0]!)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2)
    expect(await flushed).not.toBe('saved') // it reports what it last saw and stops there
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(0) // B's document was never PUT by A's flush
    first() // stale: a no-op
  })
})
