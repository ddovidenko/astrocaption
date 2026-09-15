import { create } from 'zustand'
import type { Annotations, AnnotationsUpdate, FontOut, ImageOut, Label, ObjectOut, StyleConfig } from '../api'
import { actualSize, fitView, type View } from './view'

/** Everything the editor needs before its first draw, as fetched by `load.loadEditor`. */
export interface LoadedDocument {
  image: ImageOut
  objects: ObjectOut[]
  annotations: Annotations
  fonts: FontOut[]
  fontFallback: FontFallback | null
}

/** A stored font file the server no longer bundles, resolved to the default in its place:
 *  `stored` is what the document asked for, `used` is what actually loaded. */
export interface FontFallback {
  stored: string
  used: string
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

/** The document at one point in its history: what undo/redo swap in and out. */
export interface Snapshot {
  labels: Map<number, Label>
  style: StyleConfig
}

/** Undo entries kept per editing session (spec § A). */
export const HISTORY_LIMIT = 100

export interface EditorState {
  image: ImageOut | null
  objects: Map<number, ObjectOut>
  objectOrder: number[] // insertion order from the server
  style: StyleConfig | null
  labels: Map<number, Label> // by object id, insertion order kept for save
  version: number
  updatedAt: string
  fonts: Map<string, FontOut> // by file
  fontFallback: FontFallback | null // set by load when the stored font was swapped for the default
  selectedId: number | null
  hoveredId: number | null
  view: View
  viewport: { w: number; h: number }
  fitted: boolean // whether the first fit has happened for this document (reset by load)
  changeSeq: number // increments on every document change; autosave keys on it
  pendingChanges: number // changes since markSaving; markSaved leaves 'dirty' when > 0
  save: { status: SaveStatus; message: string | null }
  committed: Snapshot | null // the document as of the last commit; the head of the history
  undo: Snapshot[]
  redo: Snapshot[]
  undoLast(): void
  redoLast(): void
  load(doc: LoadedDocument): void
  setView(view: View): void
  select(id: number | null): void
  hover(id: number | null): void
  reset(): void
  setViewport(w: number, h: number): void
  fit(): void
  actual(): void
  panTo(objectId: number): void
  toggleObject(id: number, placed?: { x: number; y: number; collided?: boolean }): void
  moveLabel(id: number, x: number, y: number, commit?: boolean): void
  applyLabels(labels: Label[]): void
  /** Global style fields; one commit (one undo entry) per call. */
  setStyle(patch: Partial<StyleConfig>): void
  markSaving(): void
  markSaved(version: number, updatedAt: string): void
  markSaveError(message: string): void
  markConflict(message: string): void
}

const initial = {
  image: null,
  objects: new Map<number, ObjectOut>(),
  objectOrder: [] as number[],
  style: null,
  labels: new Map<number, Label>(),
  version: 0,
  updatedAt: '',
  fonts: new Map<string, FontOut>(),
  fontFallback: null as FontFallback | null,
  selectedId: null,
  hoveredId: null,
  view: { scale: 1, x: 0, y: 0 } as View,
  viewport: { w: 0, h: 0 },
  fitted: false,
  changeSeq: 0,
  pendingChanges: 0,
  save: { status: 'saved' as SaveStatus, message: null as string | null },
  committed: null as Snapshot | null,
  undo: [] as Snapshot[],
  redo: [] as Snapshot[],
}

/** The one place the read-only rule lives: the canvas, the side panel, the toolbar and the
 *  autosave all ask this. Only a solve in progress stops editing — a *failed* re-solve leaves the
 *  previous layout editable (SPEC § 5), and the server accepts PUT/autoarrange for it. A conflict
 *  stops further *saves* (the autosave and the toolbar own that), not the owner's work in the
 *  page. Export is gated separately, on `solved` alone: the export endpoint requires it. */
export function isEditable(state: EditorState): boolean {
  const status = state.image?.solve_status
  return status === 'solved' || status === 'failed'
}

/** What a document change replaces: the labels map, the style, or both. */
interface DocPatch {
  labels?: Map<number, Label>
  style?: StyleConfig
}

/** Every document action goes through this. It returns `null` while the document may not be
 *  edited, so no tab can slip a change past the read-only rule. A preview (`commit: false`, the
 *  drag frames) only swaps the maps in; a commit records history, bumps `changeSeq`/
 *  `pendingChanges` (the autosave keys on `changeSeq`) and marks the document dirty unless a
 *  conflict is already sticky. It also drops a selection the new labels map disables: a disabled
 *  label has nothing on the canvas to select, and Delete/Backspace on a selection left behind
 *  would toggle it straight back on. Callers hand in *new* maps and never mutate the stored
 *  `Label` objects — `useShallow(enabledLabels)` in the canvas relies on identity. */
function changedDoc(s: EditorState, patch: DocPatch, commit = true): Partial<EditorState> | null {
  if (!isEditable(s)) return null
  const labels = patch.labels ?? s.labels
  const style = patch.style ?? s.style
  if (!style) return null
  const next: Partial<EditorState> = { labels, style }
  if (s.selectedId !== null && labels.get(s.selectedId)?.enabled !== true) next.selectedId = null
  if (!commit) return next
  // The previous head goes onto the undo stack; a fresh commit invalidates whatever was redone.
  const history = s.committed
    ? { undo: [...s.undo, s.committed].slice(-HISTORY_LIMIT), redo: [] }
    : { undo: s.undo, redo: s.redo }
  return { ...next, ...history, ...committed(s, { labels, style }) }
}

/** The bookkeeping every commit shares, undo and redo included: the new head, the autosave
 *  trigger and the dirty flag. */
function committed(s: EditorState, snapshot: Snapshot): Partial<EditorState> {
  return {
    committed: snapshot,
    changeSeq: s.changeSeq + 1,
    pendingChanges: s.pendingChanges + 1,
    save: s.save.status === 'conflict' ? s.save : { status: 'dirty', message: null },
  }
}

/** Makes the snapshot at the top of the undo or redo stack the document. The restored document is
 *  a commit like any other (the autosave writes it), except that the history moves sideways
 *  instead of growing. */
function swapHistory(s: EditorState, direction: 'undo' | 'redo'): Partial<EditorState> {
  const from = direction === 'undo' ? s.undo : s.redo
  if (!s.committed || from.length === 0) return {}
  const snapshot = from[from.length - 1]!
  const patch = changedDoc(s, snapshot, false)
  if (!patch) return {}
  const popped = from.slice(0, -1)
  const to = direction === 'undo' ? s.redo : s.undo
  const pushed = [...to, s.committed]
  const history = direction === 'undo' ? { undo: popped, redo: pushed } : { undo: pushed, redo: popped }
  return { ...patch, ...history, ...committed(s, snapshot) }
}

export const useEditor = create<EditorState>()((set) => ({
  ...initial,
  load: (doc) => {
    const labels = new Map(doc.annotations.labels.map((l) => [l.object_id, l]))
    set({
      image: doc.image,
      objects: new Map(doc.objects.map((o) => [o.id, o])),
      objectOrder: doc.objects.map((o) => o.id),
      style: doc.annotations.style,
      labels,
      version: doc.annotations.version,
      updatedAt: doc.annotations.updated_at,
      fonts: new Map(doc.fonts.map((f) => [f.file, f])),
      fontFallback: doc.fontFallback,
      selectedId: null,
      hoveredId: null,
      save: { status: 'saved', message: null },
      fitted: false,
      changeSeq: 0,
      pendingChanges: 0,
      committed: { style: doc.annotations.style, labels },
      undo: [],
      redo: [],
    })
  },
  setView: (view) => set({ view }),
  select: (selectedId) => set({ selectedId }),
  hover: (hoveredId) => set({ hoveredId }),
  reset: () =>
    set({
      ...initial,
      objects: new Map(),
      labels: new Map(),
      fonts: new Map(),
      objectOrder: [],
      undo: [],
      redo: [],
    }),
  setViewport: (w, h) =>
    set((s) => {
      const next: Partial<EditorState> = { viewport: { w, h } }
      if (!s.fitted && s.image && w > 0 && h > 0) {
        next.view = fitView(s.image.width, s.image.height, w, h)
        next.fitted = true
      }
      return next
    }),
  fit: () =>
    set((s) => (s.image && s.viewport.w > 0 ? { view: fitView(s.image.width, s.image.height, s.viewport.w, s.viewport.h) } : {})),
  actual: () => set((s) => (s.viewport.w > 0 ? { view: actualSize(s.view, s.viewport.w, s.viewport.h) } : {})),
  panTo: (id) =>
    set((s) => {
      const obj = s.objects.get(id)
      if (!obj || s.viewport.w <= 0) return {}
      const { scale } = s.view
      return { view: { scale, x: s.viewport.w / 2 - obj.x * scale, y: s.viewport.h / 2 - obj.y * scale } }
    }),
  toggleObject: (id, placed) =>
    set((s) => {
      const label = s.labels.get(id)
      if (!label) return {}
      // A placement keeps the placer's verdict: a label it could not fit anywhere clean is
      // enabled *and* flagged, so the badge shows immediately. Re-enabling a label that keeps its
      // own position clears the flag — the owner put it there.
      const next = label.enabled
        ? { ...label, enabled: false }
        : {
            ...label,
            enabled: true,
            x: placed?.x ?? label.x,
            y: placed?.y ?? label.y,
            collided: placed ? (placed.collided ?? false) : false,
          }
      const labels = new Map(s.labels)
      labels.set(id, next)
      return changedDoc(s, { labels }) ?? {}
    }),
  moveLabel: (id, x, y, commit = true) =>
    set((s) => {
      const label = s.labels.get(id)
      if (!label) return {}
      const labels = new Map(s.labels)
      labels.set(id, { ...label, x, y, collided: false })
      if (!commit) return label.x === x && label.y === y ? {} : (changedDoc(s, { labels }, false) ?? {})
      // A commit is measured against the last committed position, not the last preview frame:
      // Konva fires dragmove/dragend at the start position for a gesture that never moved, and a
      // drag that came back to where it began has changed nothing worth an undo entry or a save
      // (it would also clear the placer's `collided` verdict). Restoring the committed map keeps
      // the label identities the canvas memoises on. Preview frames are gated like commits, so
      // the maps can only have diverged while the document was editable.
      const origin = s.committed?.labels.get(id) ?? label
      if (origin.x === x && origin.y === y) {
        return s.committed && s.labels !== s.committed.labels ? { labels: s.committed.labels } : {}
      }
      return changedDoc(s, { labels }) ?? {}
    }),
  applyLabels: (updated) =>
    set((s) => {
      const labels = new Map(s.labels)
      for (const label of updated) {
        // Unreachable from the server (one label per object), so a mismatch is a bug: say so.
        if (!labels.has(label.object_id)) throw new Error(`applyLabels: no label for object ${label.object_id}`)
        labels.set(label.object_id, label)
      }
      return changedDoc(s, { labels }) ?? {}
    }),
  setStyle: (patch) =>
    set((s) => {
      const current = s.style
      if (!current) return {}
      // A patch that changes nothing (every key already holds that value) commits no history and
      // marks nothing dirty — a debounced number commit that lands after its field was already
      // undone back to the same value, or a reset clicked when already at the defaults, must not
      // manufacture an undo entry or a save.
      const changed = (Object.keys(patch) as (keyof StyleConfig)[]).some((k) => patch[k] !== current[k])
      // A font_file patch that resolves to the font already in the document is still a real change
      // while a fallback notice is pending: the stored row still names the gone font, so the
      // document differs from it even though nothing here looks different. Let it through so the
      // resolved font is committed (autosaved) and the notice clears below, as it promises.
      // (StyleTab.changeFont skips its own same-font early return in that case for the same reason.)
      const hasFontPatch = 'font_file' in patch
      if (!changed && !(hasFontPatch && s.fontFallback !== null)) return {}
      const next = changedDoc(s, { style: { ...current, ...patch } })
      if (!next) return {}
      return { ...next, ...(hasFontPatch ? { fontFallback: null } : {}) }
    }),
  markSaving: () => set({ pendingChanges: 0, save: { status: 'saving', message: null } }),
  markSaved: (version, updatedAt) =>
    set((s) => ({
      version,
      updatedAt,
      fontFallback: null,
      save: s.pendingChanges > 0 ? { status: 'dirty', message: null } : { status: 'saved', message: null },
    })),
  markSaveError: (message) => set({ save: { status: 'error', message } }),
  markConflict: (message) => set({ save: { status: 'conflict', message }, undo: [], redo: [] }),
  undoLast: () => set((s) => swapHistory(s, 'undo')),
  redoLast: () => set((s) => swapHistory(s, 'redo')),
}))

export function labelFor(state: EditorState, id: number): Label | undefined {
  return state.labels.get(id)
}

/** Enabled labels, in `objectOrder` (the order the server returned the objects in). That is also
 *  the canvas's draw order, and it matches the export only because `layout.py` builds the labels in
 *  object order; PR 5's save must keep `labels` in that order or the two renderers will stack
 *  overlapping labels differently. */
export function enabledLabels(state: EditorState): Label[] {
  const labels: Label[] = []
  for (const id of state.objectOrder) {
    const label = state.labels.get(id)
    if (label?.enabled) labels.push(label)
  }
  return labels
}

/** The document's font (M3 has no per-label fonts). Throws when the server no longer lists
 *  the style's font file (#63): a stale document must surface as an error, not fall back silently. */
export function fontFor(state: EditorState): FontOut {
  const file = state.style?.font_file
  const font = file ? state.fonts.get(file) : undefined
  if (!font) throw new Error(`Font ${file} is not listed by the server.`)
  return font
}

/** Every stored label for an object the image still has, ordered by `objectOrder` (§ hard rule:
 *  the two renderers must see labels in the same order they were built in). Labels for objects the
 *  server no longer has are kept locally and never sent: the server would reject them
 *  (`_validate_document` in `backend/app/api/images.py`); the canvas keeps showing its
 *  "hidden, not dropped" notice for them regardless. */
export function documentForSave(state: EditorState): AnnotationsUpdate {
  if (!state.style) throw new Error('documentForSave called before a document was loaded.')
  const labels: Label[] = []
  for (const id of state.objectOrder) {
    const label = state.labels.get(id)
    if (label) labels.push(label)
  }
  return { style: state.style, labels, version: state.version }
}
