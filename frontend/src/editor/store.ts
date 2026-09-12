import { create } from 'zustand'
import type { Annotations, FontOut, ImageOut, Label, ObjectOut, StyleConfig } from '../api'
import type { View } from './view'

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
  fonts: Map<string, FontOut> // by file
  selectedId: number | null
  hoveredId: number | null
  view: View
  save: { status: SaveStatus; message: string | null }
  load(doc: LoadedDocument): void
  setView(view: View): void
  select(id: number | null): void
  hover(id: number | null): void
  reset(): void
}

const initial = {
  image: null,
  objects: new Map<number, ObjectOut>(),
  objectOrder: [] as number[],
  style: null,
  labels: new Map<number, Label>(),
  version: 0,
  fonts: new Map<string, FontOut>(),
  selectedId: null,
  hoveredId: null,
  view: { scale: 1, x: 0, y: 0 } as View,
  save: { status: 'saved' as SaveStatus, message: null as string | null },
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
      fonts: new Map(doc.fonts.map((f) => [f.file, f])),
      selectedId: null,
      hoveredId: null,
      save: { status: 'saved', message: null },
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
