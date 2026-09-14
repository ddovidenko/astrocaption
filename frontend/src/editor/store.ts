import { create } from 'zustand'
import type { Annotations, AnnotationsUpdate, FontOut, ImageOut, Label, ObjectOut, StyleConfig } from '../api'
import { actualSize, fitView, type View } from './view'

/** Everything the editor needs before its first draw, as fetched by `load.loadEditor`. */
export interface LoadedDocument {
  image: ImageOut
  objects: ObjectOut[]
  annotations: Annotations
  fonts: FontOut[]
}

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export interface EditorState {
  image: ImageOut | null
  objects: Map<number, ObjectOut>
  objectOrder: number[] // insertion order from the server
  style: StyleConfig | null
  labels: Map<number, Label> // by object id, insertion order kept for save
  version: number
  updatedAt: string
  fonts: Map<string, FontOut> // by file
  selectedId: number | null
  hoveredId: number | null
  view: View
  viewport: { w: number; h: number }
  fitted: boolean // whether the first fit has happened for this document (reset by load)
  changeSeq: number // increments on every document change; autosave keys on it
  pendingChanges: number // changes since markSaving; markSaved leaves 'dirty' when > 0
  save: { status: SaveStatus; message: string | null }
  load(doc: LoadedDocument): void
  setView(view: View): void
  select(id: number | null): void
  hover(id: number | null): void
  reset(): void
  setViewport(w: number, h: number): void
  fit(): void
  actual(): void
  panTo(objectId: number): void
  toggleObject(id: number, placed?: { x: number; y: number }): void
  moveLabel(id: number, x: number, y: number): void
  applyLabels(labels: Label[]): void
  markDirty(): void
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
  selectedId: null,
  hoveredId: null,
  view: { scale: 1, x: 0, y: 0 } as View,
  viewport: { w: 0, h: 0 },
  fitted: false,
  changeSeq: 0,
  pendingChanges: 0,
  save: { status: 'saved' as SaveStatus, message: null as string | null },
}

/** Every document action shares this: bump `changeSeq`/`pendingChanges`, replace `labels` with a
 *  new `Map` (never mutate the stored `Label` objects — `useShallow(enabledLabels)` in the canvas
 *  relies on identity), and mark the document dirty unless a conflict is already sticky. */
function changed(s: EditorState, labels: Map<number, Label>): Partial<EditorState> {
  return {
    labels,
    changeSeq: s.changeSeq + 1,
    pendingChanges: s.pendingChanges + 1,
    save: s.save.status === 'conflict' ? s.save : { status: 'dirty' as const, message: null },
  }
}

export const useEditor = create<EditorState>()((set) => ({
  ...initial,
  load: (doc) =>
    set({
      image: doc.image,
      objects: new Map(doc.objects.map((o) => [o.id, o])),
      objectOrder: doc.objects.map((o) => o.id),
      style: doc.annotations.style,
      labels: new Map(doc.annotations.labels.map((l) => [l.object_id, l])),
      version: doc.annotations.version,
      updatedAt: doc.annotations.updated_at,
      fonts: new Map(doc.fonts.map((f) => [f.file, f])),
      selectedId: null,
      hoveredId: null,
      save: { status: 'saved', message: null },
      fitted: false,
      changeSeq: 0,
      pendingChanges: 0,
    }),
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
      const next = label.enabled
        ? { ...label, enabled: false }
        : { ...label, enabled: true, x: placed?.x ?? label.x, y: placed?.y ?? label.y, collided: false }
      const labels = new Map(s.labels)
      labels.set(id, next)
      return changed(s, labels)
    }),
  moveLabel: (id, x, y) =>
    set((s) => {
      const label = s.labels.get(id)
      if (!label) return {}
      const labels = new Map(s.labels)
      labels.set(id, { ...label, x, y, collided: false })
      return changed(s, labels)
    }),
  applyLabels: (updated) =>
    set((s) => {
      const labels = new Map(s.labels)
      for (const label of updated) {
        if (!labels.has(label.object_id)) continue
        labels.set(label.object_id, label)
      }
      return changed(s, labels)
    }),
  markDirty: () => set((s) => (s.save.status === 'conflict' ? {} : { save: { status: 'dirty', message: null } })),
  markSaving: () => set({ pendingChanges: 0, save: { status: 'saving', message: null } }),
  markSaved: (version, updatedAt) =>
    set((s) => ({
      version,
      updatedAt,
      save: s.pendingChanges > 0 ? { status: 'dirty', message: null } : { status: 'saved', message: null },
    })),
  markSaveError: (message) => set({ save: { status: 'error', message } }),
  markConflict: (message) => set({ save: { status: 'conflict', message } }),
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
