// Autosave: debounces document changes into a PUT, defers a save requested while one is in
// flight, and turns failures into store state the toolbar reads (`useEditor().save`).
// See `docs/SPEC.md` § 5 and the store's save state machine in `store.ts`.

import { api, ApiError, describeError, type Annotations, type AnnotationsUpdate } from '../api'
import { documentForSave, useEditor, type SaveStatus } from './store'

export const AUTOSAVE_DELAY_MS = 500

export interface AutosaveDeps {
  save: (id: string, doc: AnnotationsUpdate) => Promise<Annotations>
}

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let currentImageId: string | null = null
let currentDeps: AutosaveDeps | null = null

/** Bumped by every save attempt and by `startAutosave`/`stop`. A `run()` in flight captures the
 *  value at the moment it starts; if the counter has moved by the time its request settles (the
 *  controller was stopped, or restarted), its result is stale and must not touch the store. */
let generation = 0

/** Identifies the live controller. `startAutosave` bumps it; a `stop()` closure only tears down
 *  shared module state when its captured id still matches — a stale `stop()` (held from a
 *  superseded `startAutosave` call) is then a no-op instead of clobbering the live controller. */
let controllerId = 0
let currentStop: (() => void) | null = null

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function schedule(delay = AUTOSAVE_DELAY_MS): void {
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    void run()
  }, delay)
}

/** Attempts one save now. No-ops while a save is already in flight (the in-flight save's
 *  `finally` reschedules once it settles if changes are still pending), while there is nothing
 *  to save (`saved`) or a conflict is sticky, or while the image is not solved (#68). */
function run(): Promise<void> {
  if (inFlight) return Promise.resolve()
  const state = useEditor.getState()
  if (state.save.status === 'conflict' || state.save.status === 'saved') return Promise.resolve()
  if (!state.image || state.image.solve_status !== 'solved') return Promise.resolve()
  if (!currentImageId || !currentDeps) return Promise.resolve()

  const gen = ++generation
  const imageId = currentImageId
  const deps = currentDeps
  const doc = documentForSave(state)
  useEditor.getState().markSaving()

  const promise = (async () => {
    try {
      const res = await deps.save(imageId, doc)
      if (gen !== generation) return // superseded: a stop() or a newer save already moved on
      useEditor.getState().markSaved(res.version, res.updated_at)
    } catch (err) {
      if (gen !== generation) return
      if (err instanceof ApiError && err.status === 409) {
        useEditor.getState().markConflict(err.message)
      } else {
        useEditor.getState().markSaveError(describeError(err))
      }
    } finally {
      if (gen === generation) {
        inFlight = null
        const s = useEditor.getState()
        if (s.pendingChanges > 0 && s.save.status === 'dirty') {
          schedule()
        }
      }
    }
  })()
  inFlight = promise
  return promise
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  const status = useEditor.getState().save.status
  if (status === 'dirty' || status === 'saving') {
    e.preventDefault()
    e.returnValue = ''
  }
}

/** Starts autosaving `imageId`: subscribes to document changes and debounces them into a save.
 *  Retires any previous controller first (as if its `stop()` had been called), so at most one
 *  controller is ever live. Returns `stop()`, which clears the timer, drops the subscription and
 *  the `beforeunload` listener, and invalidates any save from this controller still in flight.
 *  `deps.save` defaults to `api.saveAnnotations`. */
export function startAutosave(imageId: string, deps?: Partial<AutosaveDeps>): () => void {
  currentStop?.()

  const id = ++controllerId
  generation++
  currentImageId = imageId
  currentDeps = { save: deps?.save ?? api.saveAnnotations }

  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (s.changeSeq !== prev.changeSeq) schedule()
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload)
  }

  const stop = (): void => {
    if (id !== controllerId) return // superseded by a newer startAutosave: stale, ignore
    generation++ // invalidate any save this controller still has in flight
    clearTimer()
    unsubscribe()
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
    inFlight = null
    currentImageId = null
    currentDeps = null
    currentStop = null
  }
  currentStop = stop
  return stop
}

/** Used by export: forces any pending debounce to run immediately, waits out any in-flight
 *  save, and repeats for as long as the document stays `dirty` or `saving` (a save can leave it
 *  `dirty` again when changes landed while it was in flight). Resolves with the terminal status
 *  — `saved`, `error`, or `conflict` — for the caller to check before proceeding. */
export async function flushSave(): Promise<SaveStatus> {
  for (;;) {
    const status = useEditor.getState().save.status
    if (status !== 'dirty' && status !== 'saving') return status
    if (inFlight) {
      await inFlight
      continue
    }
    clearTimer()
    const started = run()
    if (!inFlight) {
      // run() declined to start a save (e.g. the image is not solved): nothing more to flush.
      return useEditor.getState().save.status
    }
    await started
  }
}

/** The toolbar's Retry button: schedules a save now instead of waiting out the debounce. A
 *  no-op when the document has nothing to save (`run()` bails on `saved`). */
export function retrySave(): void {
  schedule(0)
}
