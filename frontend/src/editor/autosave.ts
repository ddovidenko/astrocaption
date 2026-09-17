// Autosave: debounces document changes into a PUT, defers a save requested while one is in
// flight, and turns failures into store state the toolbar reads (`useEditor().save`).
// See `docs/SPEC.md` § 5 and the store's save state machine in `store.ts`.

import { api, ApiError, describeError, type Annotations, type AnnotationsUpdate } from '../api'
import { isEditable } from './editing'
import { isStaleDocumentStatus, STALE_DOCUMENT_MESSAGE } from './notices'
import { documentForSave, useEditor, type SaveStatus } from './store'

export const AUTOSAVE_DELAY_MS = 500

export interface AutosaveDeps {
  save: (id: string, doc: AnnotationsUpdate) => Promise<Annotations>
}

/** One `startAutosave` call. Everything a save needs lives on its controller, so a retired
 *  controller (its `stop()` ran, or a newer `startAutosave` replaced it) can neither touch the
 *  store with a late response nor clobber the live controller's timer. */
interface Controller {
  imageId: string
  deps: AutosaveDeps
  timer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void> | null
  unsubscribe: () => void
  alive: boolean
}

let current: Controller | null = null

function clearTimer(c: Controller): void {
  if (c.timer !== null) {
    clearTimeout(c.timer)
    c.timer = null
  }
}

function schedule(c: Controller, delay = AUTOSAVE_DELAY_MS): void {
  clearTimer(c)
  c.timer = setTimeout(() => {
    c.timer = null
    void run(c)
  }, delay)
}

/** Attempts one save now; returns its promise, or null when it declined: a save is already in
 *  flight (its `finally` reschedules once it settles if changes are still pending), there is
 *  nothing to save (`saved`), a conflict is sticky, or the document may not be edited (#68 — a
 *  solve in progress; the server answers those with a 409). */
function run(c: Controller): Promise<void> | null {
  if (!c.alive || c.inFlight) return null
  const state = useEditor.getState()
  if (state.save.status === 'conflict' || state.save.status === 'saved') return null
  if (!isEditable(state)) return null

  // Before the request, outside the promise: a stale document must become the toolbar's error.
  let doc: AnnotationsUpdate
  try {
    doc = documentForSave(state)
  } catch (err) {
    useEditor.getState().markSaveError(describeError(err))
    return null
  }
  useEditor.getState().markSaving()

  // A `save` that throws synchronously settles this promise before it is recorded below; its
  // `finally` runs first, and recording it afterwards would leave `inFlight` set for good.
  let settled = false
  const promise = (async () => {
    try {
      const res = await c.deps.save(c.imageId, doc)
      if (!c.alive) return // retired while the request was out: its result is stale
      useEditor.getState().markSaved(res.version, res.updated_at)
    } catch (err) {
      if (!c.alive) return
      if (err instanceof ApiError && err.status === 409) {
        useEditor.getState().markConflict(err.message)
      } else if (err instanceof ApiError && isStaleDocumentStatus(err.status)) {
        // The server's validation sentence would sit in the toolbar with a Retry that can never
        // succeed; the conflict state offers Reload instead (#77).
        useEditor.getState().markConflict(STALE_DOCUMENT_MESSAGE)
      } else {
        useEditor.getState().markSaveError(describeError(err))
      }
    } finally {
      settled = true
      c.inFlight = null
      if (c.alive) {
        const s = useEditor.getState()
        if (s.pendingChanges > 0 && s.save.status === 'dirty') schedule(c)
      }
    }
  })()
  if (!settled) c.inFlight = promise
  return promise
}

/** Prompts on a close/reload with work that is not on the server. Not on `conflict`: those edits
 *  cannot be saved at all (the documented exit is Reload), so the prompt would only be noise. */
function onBeforeUnload(e: BeforeUnloadEvent): void {
  const status = useEditor.getState().save.status
  if (status === 'dirty' || status === 'saving' || status === 'error') {
    e.preventDefault()
    e.returnValue = ''
  }
}

function stopController(c: Controller): void {
  if (!c.alive) return
  c.alive = false // invalidates any save this controller still has in flight
  clearTimer(c)
  c.unsubscribe()
  if (typeof window !== 'undefined') {
    window.removeEventListener('beforeunload', onBeforeUnload)
  }
  if (current === c) current = null
}

/** Starts autosaving `imageId`: subscribes to document changes and debounces them into a save.
 *  Retires any previous controller first (as if its `stop()` had been called), so at most one
 *  controller is ever live. Returns `stop()`, which clears the timer, drops the subscription and
 *  the `beforeunload` listener, and invalidates any save from this controller still in flight;
 *  a `stop()` held from a superseded call is a no-op. `deps.save` defaults to
 *  `api.saveAnnotations`. */
export function startAutosave(imageId: string, deps?: Partial<AutosaveDeps>): () => void {
  if (current) stopController(current)

  const c: Controller = {
    imageId,
    deps: { save: deps?.save ?? api.saveAnnotations },
    timer: null,
    inFlight: null,
    unsubscribe: () => {},
    alive: true,
  }
  c.unsubscribe = useEditor.subscribe((s, prev) => {
    if (s.changeSeq !== prev.changeSeq) schedule(c)
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload)
  }
  current = c
  return () => stopController(c)
}

/** Used by export, the Layout tab and leaving the editor: forces any pending debounce to run
 *  immediately, waits out any in-flight save, and repeats for as long as the document stays
 *  `dirty` or `saving` (a save can leave it `dirty` again when changes landed while it was in
 *  flight). A document left in `error` gets one more attempt — the caller is about to act on what
 *  the server holds — and then the failure is reported. Resolves with the terminal status
 *  — `saved`, `error`, or `conflict` — for the caller to check before proceeding.
 *
 *  It is bound to the controller that was live when it was called: if another image took over
 *  while this was awaiting, it reports the last status it saw and touches nothing, rather than
 *  cancelling the new image's debounce and PUTting it mid-drag. */
export async function flushSave(): Promise<SaveStatus> {
  const c = current
  let attempted = false
  // The last status this flush saw for its own controller: what it reports if another image
  // takes the store over mid-await.
  let status: SaveStatus
  for (;;) {
    status = useEditor.getState().save.status
    if (status === 'error') {
      // At most one attempt per flush: a server that keeps refusing would otherwise spin here.
      if (attempted) return status
    } else if (status !== 'dirty' && status !== 'saving') {
      return status
    }
    if (!c) return status
    if (c.inFlight) {
      await c.inFlight
      if (current !== c) return status
      continue
    }
    clearTimer(c)
    attempted = true
    const started = run(c)
    // run() declined to start a save (e.g. a solve is running): nothing more to flush.
    if (!started) return useEditor.getState().save.status
    await started
    if (current !== c) return status
  }
}

/** The toolbar's Retry button: schedules a save now instead of waiting out the debounce. A
 *  no-op when the document has nothing to save (`run()` bails on `saved`). */
export function retrySave(): void {
  if (current) schedule(current, 0)
}
