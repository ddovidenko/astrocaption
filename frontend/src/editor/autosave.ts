// Autosave: debounces document changes into a PUT, defers a save requested while one is in
// flight, and turns failures into store state the toolbar reads (`useEditor().save`).
// See `docs/SPEC.md` § 5 and the store's save state machine in `store.ts`.

import { api, ApiError, describeError, type Annotations, type AnnotationsUpdate } from '../api'
import { documentForSave, useEditor } from './store'

export const AUTOSAVE_DELAY_MS = 500

export interface AutosaveDeps {
  save: (id: string, doc: AnnotationsUpdate) => Promise<Annotations>
  now?: () => number
}

let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let currentImageId: string | null = null
let currentDeps: AutosaveDeps | null = null

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
 *  `finally` reschedules once it settles if changes are still pending), while a conflict is
 *  sticky, or while the image is not solved (#68). */
function run(): Promise<void> {
  if (inFlight) return Promise.resolve()
  const state = useEditor.getState()
  if (state.save.status === 'conflict') return Promise.resolve()
  if (!state.image || state.image.solve_status !== 'solved') return Promise.resolve()
  if (!currentImageId || !currentDeps) return Promise.resolve()

  const imageId = currentImageId
  const deps = currentDeps
  const doc = documentForSave(state)
  useEditor.getState().markSaving()

  const promise = (async () => {
    try {
      const res = await deps.save(imageId, doc)
      useEditor.getState().markSaved(res.version, res.updated_at)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        useEditor.getState().markConflict(err.message)
      } else {
        useEditor.getState().markSaveError(describeError(err))
      }
    } finally {
      inFlight = null
      const s = useEditor.getState()
      if (s.pendingChanges > 0 && s.save.status === 'dirty') {
        schedule()
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
 *  Returns `stop()`, which clears the timer, drops the subscription and the `beforeunload`
 *  listener. `deps.save` defaults to `api.saveAnnotations`. */
export function startAutosave(imageId: string, deps?: Partial<AutosaveDeps>): () => void {
  currentImageId = imageId
  currentDeps = { save: deps?.save ?? api.saveAnnotations, now: deps?.now ?? Date.now }

  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (s.changeSeq !== prev.changeSeq) schedule()
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload)
  }

  return () => {
    clearTimer()
    unsubscribe()
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
    inFlight = null
    currentImageId = null
    currentDeps = null
  }
}

/** Used by export: waits for a pending (timed) or in-flight save to settle. Resolves
 *  immediately once the document is `saved` or stuck in `conflict`. */
export function flushSave(): Promise<void> {
  const waitInFlight = inFlight ?? Promise.resolve()
  return waitInFlight.then(() => {
    if (timer !== null) {
      clearTimer()
      return run()
    }
  })
}

/** The toolbar's Retry button: schedules a save now instead of waiting out the debounce. */
export function retrySave(): void {
  schedule(0)
}
