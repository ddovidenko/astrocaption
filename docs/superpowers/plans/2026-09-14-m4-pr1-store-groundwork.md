# Milestone 4 PR 1: Store Groundwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the editor store a single document-change helper with a commit/preview split, an in-browser undo/redo history with keys and toolbar buttons, one-transaction bulk enable, and Space-pan as render state.

**Architecture:** Every document mutation in `frontend/src/editor/store.ts` goes through `changedDoc(s, patch, commit)`. A commit pushes the last committed snapshot (`{labels, style}`) onto an undo stack and clears redo; a preview (drag frames) only replaces `labels`. `undoLast`/`redoLast` swap snapshots and commit the restored one, so the existing autosave (keyed on `changeSeq`) writes it. Bulk enable places every new label against a growing obstacle set and applies once. The canvas holds "Space is down" in React state so Konva never starts a drag during a pan.

**Tech Stack:** TypeScript strict, React 19 function components, Zustand, react-konva/Konva, vitest, Playwright (`make e2e`).

**Spec:** `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md`, section A ("Editor state, undo, per-label editing") and "PR order" item 1. Selection changes (`selectedIds`), the floating toolbar and pinned labels are PR 4, not this plan.

## Global Constraints

- Preview and export must produce the same layout (CLAUDE.md hard rule). This PR changes no geometry, no metrics and no renderer; `make render-vectors` / `make placement-vectors` stay untouched.
- Annotation geometry is stored in original image pixels; the store never sees screen pixels.
- No new dependencies.
- Editing stays live after a 409 conflict; only saving stops (SPEC § 6.3, design § 5 of milestone 3). The editable gate in `changedDoc` is `isEditable` (solve status) only. The design spec's "or a sticky conflict" wording is corrected in Task 8.
- History cap: 100 entries (spec section A).
- Keys: `Ctrl+Z` undo, `Ctrl+Y` and `Ctrl+Shift+Z` redo, `Cmd` on macOS; ignored while an `INPUT`, `TEXTAREA` or `SELECT` has focus.
- Toolbar buttons use `onMouseDown={(e) => e.preventDefault()}` so the canvas shortcuts keep working (existing pattern in `EditorPage.tsx`).
- Commit messages: conventional (`feat:`, `refactor:`, `test:`, `docs:`), one line, plus the attribution trailer the session reminder gives.
- After the last task: `make lint test`, then `make e2e`, then the owner's smoke test on `make dev` before the PR is opened. Never merge without the owner's go.

---

## File structure

| File | Responsibility after this PR |
|---|---|
| `frontend/src/editor/store.ts` | State, `isEditable`, `changedDoc`, history stacks, `undoLast`/`redoLast`, `moveLabel(id, x, y, commit)`, `applyLabels` that throws on unknown ids |
| `frontend/src/editor/editing.ts` | Re-exports `isEditable` from the store (so imports elsewhere stay), the measurer, `toggleWithPlacement`, new `enableWithPlacement(ids)` |
| `frontend/src/editor/placement.ts` | New `placeNewLabels(state, measure, ids)` that places several labels against a growing obstacle set |
| `frontend/src/editor/ObjectsTab.tsx` | Bulk buttons apply one change |
| `frontend/src/editor/EditorCanvas.tsx` | Space-pan as state, undo/redo keys, no `suppressDragRef`, no `cancelBubble` on labels |
| `frontend/src/editor/EditorPage.tsx` | Undo / Redo toolbar buttons |
| `frontend/src/editor/store.test.ts`, `editing.test.ts`, `placement.test.ts` | Unit coverage |
| `frontend/e2e/smoke.spec.ts` | Drag then `Ctrl+Z` restores the position |
| `docs/SPEC.md` | § 6.1 keyboard line, § 6.3 Objects bulk note |

---

### Task 1: `isEditable` moves into the store; `changedDoc` replaces `changed`

**Files:**
- Modify: `frontend/src/editor/store.ts:1-80` (imports, state interface, `changed`)
- Modify: `frontend/src/editor/editing.ts:9-17`
- Test: `frontend/src/editor/store.test.ts`

**Interfaces:**
- Produces: `export function isEditable(state: EditorState): boolean` in `store.ts`; `editing.ts` re-exports it (`export { isEditable } from './store'`).
- Produces: `interface DocPatch { labels?: Map<number, Label>; style?: StyleConfig }` and `function changedDoc(s: EditorState, patch: DocPatch, commit = true): Partial<EditorState>` (module-private for now; Task 2 adds history to it).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/editor/store.test.ts` inside `describe('document actions', ...)`:

```ts
  it('refuses every document change while a solve is running', () => {
    const s = useEditor.getState()
    s.load({ ...doc, image: { ...doc.image, solve_status: 'solving' } })
    const before = useEditor.getState().labels
    s.toggleObject(1)
    s.moveLabel(1, 10, 20)
    s.applyLabels([{ ...before.get(1)!, x: 5 }])
    expect(useEditor.getState().labels).toBe(before)
    expect(useEditor.getState().changeSeq).toBe(0)
    expect(useEditor.getState().save.status).toBe('saved')
  })

  it('keeps editing live after a conflict (only saving stops)', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.markConflict('changed elsewhere')
    s.toggleObject(1)
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().save.status).toBe('conflict')
  })
```

And a new top-level describe:

```ts
describe('isEditable', () => {
  it('is true for solved and failed, false while pending or solving', () => {
    for (const [status, want] of [['solved', true], ['failed', true], ['pending', false], ['solving', false]] as const) {
      useEditor.getState().load({ ...doc, image: { ...doc.image, solve_status: status } })
      expect(isEditable(useEditor.getState())).toBe(want)
    }
  })
})
```

Add `isEditable` to the import from `./store` at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/editor/store.test.ts`
Expected: FAIL — `isEditable` is not exported from `./store`; the "refuses" test fails because `toggleObject` changes the labels.

- [ ] **Step 3: Move `isEditable` and write `changedDoc`**

In `frontend/src/editor/store.ts`, after the `initial` object and before `useEditor`, replace the `changed` function with:

```ts
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

/** Every document action goes through this. It refuses (returns `{}`) while the document may not
 *  be edited, so no tab can slip a change past the read-only rule. A commit bumps
 *  `changeSeq`/`pendingChanges` (the autosave keys on `changeSeq`) and marks the document dirty
 *  unless a conflict is already sticky. Callers hand in *new* maps and never mutate the stored
 *  `Label` objects — `useShallow(enabledLabels)` in the canvas relies on identity. */
function changedDoc(s: EditorState, patch: DocPatch, commit = true): Partial<EditorState> {
  if (!isEditable(s)) return {}
  const next: Partial<EditorState> = {}
  if (patch.labels) next.labels = patch.labels
  if (patch.style) next.style = patch.style
  if (!commit) return next
  next.changeSeq = s.changeSeq + 1
  next.pendingChanges = s.pendingChanges + 1
  next.save = s.save.status === 'conflict' ? s.save : { status: 'dirty', message: null }
  return next
}
```

Replace every `changed(s, labels)` call in the store with `changedDoc(s, { labels })` (in `toggleObject`, `moveLabel`, `applyLabels`). In `toggleObject`, the `patch.selectedId = null` line stays; note `changedDoc` may now return `{}`, so guard it:

```ts
      const patch = changedDoc(s, { labels })
      if (!('labels' in patch)) return {}
```

In `frontend/src/editor/editing.ts` delete the `isEditable` function and its comment, and replace the store import line with:

```ts
import { isEditable, useEditor } from './store'
export { isEditable } from './store'
```

Keep `import { useEditor, type EditorState } from './store'` if `EditorState` is still used in the file (it is not after this change; drop it if `tsc` complains about an unused import).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/editor` and `cd frontend && npx tsc --noEmit`
Expected: all PASS; no type errors. (`EditorCanvas.tsx`, `ObjectsTab.tsx`, `LayoutTab.tsx`, `EditorPage.tsx` and `autosave.ts` import `isEditable` from `./editing`, which still exports it.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/store.ts frontend/src/editor/editing.ts frontend/src/editor/store.test.ts
git commit -m "refactor(editor): one document-change helper with the editable gate inside it"
```

---

### Task 2: Undo/redo history in the store

**Files:**
- Modify: `frontend/src/editor/store.ts` (state interface, `initial`, `load`, `reset`, `changedDoc`, `markConflict`; new actions)
- Test: `frontend/src/editor/store.test.ts`

**Interfaces:**
- Produces on `EditorState`:
  - `committed: Snapshot | null` — the document as of the last commit (`interface Snapshot { labels: Map<number, Label>; style: StyleConfig }`, exported)
  - `undo: Snapshot[]`, `redo: Snapshot[]`
  - `undoLast(): void`, `redoLast(): void`
  - `export const HISTORY_LIMIT = 100`
- Consumes: `changedDoc` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add a new describe to `frontend/src/editor/store.test.ts`:

```ts
describe('undo/redo', () => {
  it('a commit pushes the previous document and clears redo', () => {
    const s = useEditor.getState()
    s.load(doc)
    expect(useEditor.getState().undo).toHaveLength(0)
    s.toggleObject(1)
    expect(useEditor.getState().undo).toHaveLength(1)
    expect(useEditor.getState().redo).toHaveLength(0)
  })

  it('undoLast restores the labels and commits (autosave sees a change)', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    const seq = useEditor.getState().changeSeq
    useEditor.getState().undoLast()
    const state = useEditor.getState()
    expect(state.labels.get(1)?.enabled).toBe(true)
    expect(state.changeSeq).toBe(seq + 1)
    expect(state.save.status).toBe('dirty')
    expect(state.undo).toHaveLength(0)
    expect(state.redo).toHaveLength(1)
  })

  it('redoLast re-applies what undoLast took back', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    useEditor.getState().undoLast()
    useEditor.getState().redoLast()
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().redo).toHaveLength(0)
    expect(useEditor.getState().undo).toHaveLength(1)
  })

  it('a new commit after an undo drops the redo stack', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    useEditor.getState().undoLast()
    useEditor.getState().toggleObject(2, { x: 1, y: 2 })
    expect(useEditor.getState().redo).toHaveLength(0)
  })

  it('undo and redo are no-ops on empty stacks and while not editable', () => {
    const s = useEditor.getState()
    s.load(doc)
    const seq = useEditor.getState().changeSeq
    s.undoLast()
    s.redoLast()
    expect(useEditor.getState().changeSeq).toBe(seq)
    s.toggleObject(1)
    useEditor.setState({ image: { ...doc.image, solve_status: 'solving' } })
    useEditor.getState().undoLast()
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
  })

  it('the history is capped at HISTORY_LIMIT entries', () => {
    const s = useEditor.getState()
    s.load(doc)
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) useEditor.getState().toggleObject(1)
    expect(useEditor.getState().undo).toHaveLength(HISTORY_LIMIT)
  })

  it('load and markConflict clear both stacks', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(1)
    useEditor.getState().undoLast()
    useEditor.getState().markConflict('changed elsewhere')
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(useEditor.getState().redo).toHaveLength(0)
    useEditor.getState().load(makeDoc())
    useEditor.getState().toggleObject(1)
    useEditor.getState().load(makeDoc())
    expect(useEditor.getState().undo).toHaveLength(0)
  })

  it('a style change is one undo entry too', () => {
    const s = useEditor.getState()
    s.load(doc)
    useEditor.setState(changedDocForTest({ style: { ...doc.annotations.style, font_size: 30 } }))
    expect(useEditor.getState().style?.font_size).toBe(30)
    useEditor.getState().undoLast()
    expect(useEditor.getState().style?.font_size).toBe(24)
  })
})
```

The last test needs a way to commit a style patch before the Style tab exists (PR 3). Export a test-only helper from the store, right after `changedDoc`:

```ts
/** For tests until the Style tab (M4 PR 3) has a real style action: commits `patch` as one change. */
export function changedDocForTest(patch: { labels?: Map<number, Label>; style?: StyleConfig }): Partial<EditorState> {
  return changedDoc(useEditor.getState(), patch)
}
```

Add `HISTORY_LIMIT` and `changedDocForTest` to the test's import from `./store`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/editor/store.test.ts`
Expected: FAIL — `undo` is undefined, `undoLast` is not a function.

- [ ] **Step 3: Add the history to the store**

In `frontend/src/editor/store.ts`:

Add after the `SaveStatus` type:

```ts
/** The document at one point in its history: what undo/redo swap in and out. */
export interface Snapshot {
  labels: Map<number, Label>
  style: StyleConfig
}

/** Undo entries kept per editing session (spec § A). */
export const HISTORY_LIMIT = 100
```

Add to `EditorState` (after `save`):

```ts
  committed: Snapshot | null // the document as of the last commit; the head of the history
  undo: Snapshot[]
  redo: Snapshot[]
  undoLast(): void
  redoLast(): void
```

Add to `initial`:

```ts
  committed: null as Snapshot | null,
  undo: [] as Snapshot[],
  redo: [] as Snapshot[],
```

In `load`, after `fonts:` add:

```ts
      committed: { style: doc.annotations.style, labels: new Map(doc.annotations.labels.map((l) => [l.object_id, l])) },
      undo: [],
      redo: [],
```

(Build the labels map once into a local `const labels = new Map(...)` and use it for both `labels:` and `committed.labels`, so the two hold the same `Label` objects.)

In `reset`, add `undo: [], redo: []` to the spread (`committed: null` comes from `initial`).

Replace the commit half of `changedDoc` so it records history:

```ts
function changedDoc(s: EditorState, patch: DocPatch, commit = true): Partial<EditorState> {
  if (!isEditable(s)) return {}
  const labels = patch.labels ?? s.labels
  const style = patch.style ?? s.style
  if (!style) return {}
  const next: Partial<EditorState> = { labels, style }
  if (!commit) return next
  const snapshot: Snapshot = { labels, style }
  // The previous head goes onto the undo stack; a fresh commit invalidates whatever was redone.
  const undo = s.committed ? [...s.undo, s.committed].slice(-HISTORY_LIMIT) : s.undo
  return {
    ...next,
    committed: snapshot,
    undo,
    redo: [],
    changeSeq: s.changeSeq + 1,
    pendingChanges: s.pendingChanges + 1,
    save: s.save.status === 'conflict' ? s.save : { status: 'dirty', message: null },
  }
}

/** Moves one snapshot from `from` to `to` and makes it the document. Shared by undo and redo:
 *  the restored document is a commit like any other, so the autosave writes it. */
function swapHistory(s: EditorState, from: Snapshot[], to: Snapshot[]): Partial<EditorState> {
  if (!isEditable(s) || !s.committed || from.length === 0) return {}
  const snapshot = from[from.length - 1]!
  return {
    labels: snapshot.labels,
    style: snapshot.style,
    committed: snapshot,
    undo: from === s.undo ? from.slice(0, -1) : [...to, s.committed],
    redo: from === s.redo ? from.slice(0, -1) : [...to, s.committed],
    changeSeq: s.changeSeq + 1,
    pendingChanges: s.pendingChanges + 1,
    save: s.save.status === 'conflict' ? s.save : { status: 'dirty', message: null },
  }
}
```

Add the actions to `useEditor`:

```ts
  undoLast: () => set((s) => swapHistory(s, s.undo, s.redo)),
  redoLast: () => set((s) => swapHistory(s, s.redo, s.undo)),
```

Change `markConflict`:

```ts
  markConflict: (message) => set({ save: { status: 'conflict', message }, undo: [], redo: [] }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/editor && npx tsc --noEmit`
Expected: PASS. If the "reset empties everything" test asserts on the exact state shape, add `expect(state.undo).toEqual([])` there rather than loosening it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/store.ts frontend/src/editor/store.test.ts
git commit -m "feat(editor): undo/redo history of document snapshots in the store"
```

---

### Task 3: Drag frames preview, drag-end commits

**Files:**
- Modify: `frontend/src/editor/store.ts` (`moveLabel` signature and body)
- Modify: `frontend/src/editor/EditorCanvas.tsx:445-454` (`onDragMove`/`onDragEnd`)
- Test: `frontend/src/editor/store.test.ts`, `frontend/src/editor/editing.test.ts:297-304`

**Interfaces:**
- Produces: `moveLabel(id: number, x: number, y: number, commit?: boolean): void` (default `true`).
- A preview move (`commit === false`) replaces `labels` only. A commit compares against the *committed* position: a drag that returned to where it started restores the committed labels map and records nothing.

- [ ] **Step 1: Write the failing tests**

Add to `describe('undo/redo', ...)` in `store.test.ts`:

```ts
  it('a drag coalesces into one undo entry: preview frames record nothing, drag-end commits', () => {
    const s = useEditor.getState()
    s.load(doc)
    const seq = useEditor.getState().changeSeq
    s.moveLabel(1, 10, 20, false)
    useEditor.getState().moveLabel(1, 11, 21, false)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: 11, y: 21 })
    expect(useEditor.getState().changeSeq).toBe(seq)
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(useEditor.getState().save.status).toBe('saved')
    useEditor.getState().moveLabel(1, 12, 22)
    expect(useEditor.getState().changeSeq).toBe(seq + 1)
    expect(useEditor.getState().undo).toHaveLength(1)
    useEditor.getState().undoLast()
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: doc.annotations.labels[0]!.x, y: doc.annotations.labels[0]!.y })
  })

  it('a drag that ends where it began restores the committed document and records nothing', () => {
    const s = useEditor.getState()
    s.load(doc)
    const committedLabels = useEditor.getState().labels
    const { x, y } = committedLabels.get(1)!
    s.moveLabel(1, x + 5, y, false)
    useEditor.getState().moveLabel(1, x, y)
    expect(useEditor.getState().labels).toBe(committedLabels)
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(useEditor.getState().save.status).toBe('saved')
  })
```

The existing test "moveLabel to the current position changes nothing" keeps passing (a commit at the committed position is a no-op).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/editor/store.test.ts`
Expected: FAIL — preview frames bump `changeSeq` and push undo entries.

- [ ] **Step 3: Implement**

In `EditorState`, change the signature:

```ts
  moveLabel(id: number, x: number, y: number, commit?: boolean): void
```

Replace the action:

```ts
  moveLabel: (id, x, y, commit = true) =>
    set((s) => {
      const label = s.labels.get(id)
      if (!label) return {}
      if (!commit) {
        if (label.x === x && label.y === y) return {}
        const labels = new Map(s.labels)
        labels.set(id, { ...label, x, y, collided: false })
        return changedDoc(s, { labels }, false)
      }
      // A commit is measured against the last committed position, not the last preview frame:
      // Konva fires dragmove/dragend at the start position for a gesture that never moved, and a
      // drag that came back to where it began has changed nothing worth an undo entry or a save
      // (it would also clear the placer's `collided` verdict). Restoring the committed map keeps
      // the label identities the canvas memoises on.
      const origin = s.committed?.labels.get(id) ?? label
      if (origin.x === x && origin.y === y) {
        return s.committed && s.labels !== s.committed.labels ? { labels: s.committed.labels } : {}
      }
      const labels = new Map(s.labels)
      labels.set(id, { ...label, x, y, collided: false })
      return changedDoc(s, { labels })
    }),
```

In `EditorCanvas.tsx`, `LabelEntry`'s `moveLabel` prop type becomes `(id: number, x: number, y: number, commit?: boolean) => void`; `onDragMove` calls `moveLabel(label.object_id, e.target.x(), e.target.y(), false)` and `onDragEnd` calls `moveLabel(label.object_id, e.target.x(), e.target.y())`. (Task 5 rewrites these handlers again to drop `suppressDragRef`; make the minimal change here.)

`editing.test.ts` "restores the stored position of a label that was placed before" calls `moveLabel(2, 100, 200)` on a *disabled* label: still a commit, still fine.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/editor && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/store.ts frontend/src/editor/EditorCanvas.tsx frontend/src/editor/store.test.ts
git commit -m "feat(editor): drag frames preview, drag-end commits one undo entry"
```

---

### Task 4: Keys and toolbar buttons for undo/redo

**Files:**
- Modify: `frontend/src/editor/EditorCanvas.tsx:638-684` (key handler)
- Modify: `frontend/src/editor/EditorPage.tsx:1053-1077` (toolbar)
- Modify: `frontend/src/editor/EditorCanvas.tsx` header comment on keys if one exists
- Test: none at unit level (the handler is a window listener; the e2e step in Task 7 covers it)

**Interfaces:**
- Consumes: `useEditor.getState().undoLast()` / `.redoLast()` from Task 2, `undo.length` / `redo.length` for the disabled state.

- [ ] **Step 1: Add the keys**

In the `down` handler of effect 5 in `EditorCanvas.tsx`, insert before the line `if (inField() || e.ctrlKey || e.metaKey || e.altKey) return`:

```ts
      // Undo/redo: Ctrl (Cmd on macOS) + Z / Y / Shift+Z. Fields keep their own undo.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !inField()) {
        const key = e.key.toLowerCase()
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault()
          useEditor.getState().undoLast()
          return
        }
        if (key === 'y' || (key === 'z' && e.shiftKey)) {
          e.preventDefault()
          useEditor.getState().redoLast()
          return
        }
      }
```

- [ ] **Step 2: Add the toolbar buttons**

In `EditorPage.tsx`, add two selectors in `EditorPage()` after `const scale = ...`:

```ts
  const canUndo = useEditor((s) => s.undo.length > 0 && isEditable(s))
  const canRedo = useEditor((s) => s.redo.length > 0 && isEditable(s))
```

Insert after the `100 %` button:

```tsx
        <button
          className="secondary"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useEditor.getState().undoLast()}
        >
          Undo
        </button>
        <button
          className="secondary"
          title="Redo (Ctrl+Y)"
          disabled={!canRedo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useEditor.getState().redoLast()}
        >
          Redo
        </button>
```

- [ ] **Step 3: Lint and type-check**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/editor`
Expected: clean.

- [ ] **Step 4: Manual check on the running dev unit**

Open an image in the editor, toggle a label with a click, press `Ctrl+Z`: it disables again and the toolbar reads "Unsaved changes" then "Saved". Click Redo: it comes back. Type in the Objects search box and press `Ctrl+Z`: the canvas does not change. Note the outcome in the handoff.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/EditorCanvas.tsx frontend/src/editor/EditorPage.tsx
git commit -m "feat(editor): Ctrl+Z / Ctrl+Y and toolbar buttons for undo and redo"
```

---

### Task 5: Space-pan as render state; no drag suppression, no cancelBubble

**Files:**
- Modify: `frontend/src/editor/EditorCanvas.tsx` (`EntryProps`, `LabelEntry`, `AnnotationLayer` props, `EditorCanvas` state and effect 5, `onMouseDown`)

**Interfaces:**
- `EntryProps.spaceRef` is replaced by `spacePan: boolean`; `AnnotationLayer` passes it through.
- Behaviour to preserve (all from milestone 3 and exercised by `smoke.spec.ts`): left-drag on a label moves it; middle-button and Space+drag pan anywhere, labels included; a click on a marker toggles unless the gesture moved; a click on empty canvas deselects unless the gesture moved.

- [ ] **Step 1: Replace the ref with state**

In `EditorCanvas()` replace `const spaceRef = useRef(false)` with `const [spacePan, setSpacePan] = useState(false)`. In effect 5, replace the three `spaceRef.current = ...` writes with `setSpacePan(true)` (keydown), `setSpacePan(false)` (keyup) and `setSpacePan(false)` (blur). Effect 5 keeps `[]` as its dependency list: `setSpacePan` is stable.

In `onMouseDown`, replace `spaceRef.current` with `spacePan`.

- [ ] **Step 2: Simplify the label handlers**

Change `EntryProps`:

```ts
  /** Whether Space is held: a pan gesture, which wins over selecting or dragging a label. Held in
   *  React state so `draggable` can turn off before Konva sees the press. */
  spacePan: boolean
```

Replace the draggable group in `LabelEntry`:

```tsx
      <Group
        x={label.x}
        y={label.y}
        // Not draggable during a Space-pan: Konva then never starts the drag, so there is nothing
        // to suppress. Konva.dragButtons keeps the middle button out too.
        draggable={editable && !spacePan}
        onMouseDown={(e) => {
          // Space-drag and the middle button pan anywhere on the canvas, labels included: the
          // press bubbles to the stage, which starts the pan. A plain press also bubbles, so the
          // stage records it and `movedRef` can tell a later click from a drag; the stage does not
          // pan for it because the target is this group, not the stage.
          if (spacePan || e.evt.button === 1) return
          select(label.object_id)
        }}
        onDragStart={() => select(label.object_id)}
        onDragMove={(e) => moveLabel(label.object_id, e.target.x(), e.target.y(), false)}
        onDragEnd={(e) => moveLabel(label.object_id, e.target.x(), e.target.y())}
      >
```

Delete `suppressDragRef` and its comment, and the `useRef` import if nothing else uses it in the file (`containerRef` etc. still do; keep it).

Update `AnnotationLayer`'s call site: `spacePan={spacePan}` instead of `spaceRef={spaceRef}`. `LabelEntry` is `memo`ised, so a Space press re-renders every label once (the prop changes); that is one frame and acceptable.

Update the stale comment above `downRef` (it says a label press stops at the label): it now reads

```ts
  // Where the last mousedown that reached the stage landed, in screen pixels. Every press reaches
  // it, label presses included; `movedRef` below is what tells a click from a drag.
```

- [ ] **Step 3: Type-check, lint, unit tests**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/editor && npx vitest run src/editor`
Expected: clean.

- [ ] **Step 4: Manual gesture pass on the dev unit (required — behaviour-adjacent)**

Check each and note the result in the handoff:
1. Left-drag a label: it moves, status goes "Unsaved changes" → "Saved" once.
2. Hold Space, drag starting on a label: the view pans, the label stays.
3. Middle-button drag starting on a label: pans.
4. Click a marker: toggles. Drag from a marker to elsewhere and release over another marker: nothing toggles.
5. Click empty canvas with a label selected: deselects. Pan on empty canvas: stays selected.
6. Release Space outside the window (alt-tab while held), come back: a plain mousedown on empty canvas still pans, on a label still selects.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/EditorCanvas.tsx
git commit -m "refactor(editor): Space-pan as render state; labels are simply not draggable during it"
```

---

### Task 6: Bulk enable as one transaction

**Files:**
- Modify: `frontend/src/editor/placement.ts:135-166` (add `placeNewLabels`, reimplement `placeNewLabel` on it)
- Modify: `frontend/src/editor/editing.ts` (add `enableWithPlacement`, `disableAll`)
- Modify: `frontend/src/editor/store.ts` (`applyLabels` throws on unknown ids)
- Modify: `frontend/src/editor/ObjectsTab.tsx:111-128` (`bulk`)
- Test: `frontend/src/editor/placement.test.ts`, `frontend/src/editor/editing.test.ts`, `frontend/src/editor/store.test.ts`

**Interfaces:**
- Produces: `export function placeNewLabels(state: EditorState, measure: TextMeasurer, ids: number[]): Map<number, { x: number; y: number; collided: boolean }>` — places each id in turn against every enabled label plus the ids placed before it. Ids the state does not hold are skipped. Order is the order of `ids`.
- Produces: `export function enableWithPlacement(ids: number[], measure?: TextMeasurer): void` and `export function disableAll(ids: number[]): void` in `editing.ts`: one `applyLabels` call each.
- `placeNewLabel(state, measure, id)` stays, implemented as `placeNewLabels(state, measure, [id]).get(id) ?? null`.
- `applyLabels` throws `Error('applyLabels: no label for object <id>')` on an unknown id (spec § A "make it loud").

- [ ] **Step 1: Write the failing tests**

`placement.test.ts` (imports: add `placeNewLabels` from `./placement`, `useEditor` from `./store`, `makeDoc` from `./testDoc`):

```ts
describe('placeNewLabels', () => {
  const measure = () => 100
  it('places later ids around the ones placed earlier in the same call', () => {
    useEditor.getState().reset()
    const doc = makeDoc()
    // Two disabled labels on top of each other at the same object position.
    doc.objects.push({ id: 3, catalog_names: ['X'], primary_name: 'X', type: 'ngc', x: 1560, y: 1010, radius: 0 })
    doc.annotations.labels.push({ ...doc.annotations.labels[1]!, object_id: 3 })
    useEditor.getState().load(doc)
    const out = placeNewLabels(useEditor.getState(), measure, [2, 3])
    expect(out.size).toBe(2)
    const a = out.get(2)!
    const b = out.get(3)!
    expect([a.x, a.y]).not.toEqual([b.x, b.y])
  })
  it('skips ids the state does not hold', () => {
    useEditor.getState().reset()
    useEditor.getState().load(makeDoc())
    expect(placeNewLabels(useEditor.getState(), measure, [2, 99]).has(99)).toBe(false)
  })
})
```

`editing.test.ts`:

```ts
describe('enableWithPlacement / disableAll', () => {
  it('enables every id in one change (one undo entry) and places the unplaced ones', () => {
    useEditor.getState().load(doc)
    const seq = useEditor.getState().changeSeq
    enableWithPlacement([2], measure)
    const s = useEditor.getState()
    expect(s.labels.get(2)?.enabled).toBe(true)
    expect(s.changeSeq).toBe(seq + 1)
    expect(s.undo).toHaveLength(1)
  })
  it('keeps the stored position of a label placed before', () => {
    useEditor.getState().load(doc)
    useEditor.getState().moveLabel(2, 100, 200)
    enableWithPlacement([2], measure)
    expect(useEditor.getState().labels.get(2)).toMatchObject({ enabled: true, x: 100, y: 200 })
  })
  it('disableAll disables in one change and leaves positions alone', () => {
    useEditor.getState().load(doc)
    const { x, y } = useEditor.getState().labels.get(1)!
    disableAll([1, 2])
    expect(useEditor.getState().labels.get(1)).toMatchObject({ enabled: false, x, y })
    expect(useEditor.getState().undo).toHaveLength(1)
  })
  it('does nothing while a solve is running', () => {
    useEditor.getState().load({ ...doc, image: { ...doc.image, solve_status: 'solving' } })
    enableWithPlacement([2], measure)
    expect(useEditor.getState().labels.get(2)?.enabled).toBe(false)
  })
})
```

`store.test.ts`: replace the test "applyLabels never inserts a label for an id the store does not have" with:

```ts
  it('applyLabels throws on an id the store does not have', () => {
    const s = useEditor.getState()
    s.load(doc)
    const label = useEditor.getState().labels.get(1)!
    expect(() => s.applyLabels([{ ...label, object_id: 42 }])).toThrow('applyLabels: no label for object 42')
    expect(useEditor.getState().labels.has(42)).toBe(false)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/editor`
Expected: FAIL — `placeNewLabels`, `enableWithPlacement`, `disableAll` not exported; `applyLabels` does not throw.

- [ ] **Step 3: Implement `placeNewLabels`**

In `placement.ts`, replace `placeNewLabel` with:

```ts
/** Places the labels for `ids`, in that order, each against every other enabled label's box and
 *  marker *and* the ids placed before it in this call: what "Enable shown" needs so the whole
 *  batch is one change. Ids without an object or a label are skipped. */
export function placeNewLabels(
  state: EditorState,
  measure: TextMeasurer,
  ids: number[],
): Map<number, { x: number; y: number; collided: boolean }> {
  const out = new Map<number, { x: number; y: number; collided: boolean }>()
  const { image, style } = state
  if (!image || !style) return out
  const wanted = new Set(ids)
  const fixedBoxes: Box[] = []
  const fixedCircles: Circle[] = []
  for (const other of enabledLabels(state)) {
    if (wanted.has(other.object_id)) continue
    const o = state.objects.get(other.object_id)
    if (!o) continue
    const b = measureLabel(measure, style, other, o)
    fixedBoxes.push({ left: other.x, top: other.y, right: other.x + b.width, bottom: other.y + b.height })
    fixedCircles.push({ x: o.x, y: o.y, r: markerRadius(o, style) })
  }
  for (const id of ids) {
    const obj = state.objects.get(id)
    const label = state.labels.get(id)
    if (!obj || !label) continue
    const box = measureLabel(measure, style, label, obj)
    const r = markerRadius(obj, style)
    const [p] = placeLabels(
      image.width,
      image.height,
      [{ id, x: obj.x, y: obj.y, radius: r, w: box.width, h: box.height }],
      fixedBoxes,
      fixedCircles,
    )
    if (!p) continue
    out.set(id, { x: p.x, y: p.y, collided: p.collided })
    fixedBoxes.push({ left: p.x, top: p.y, right: p.x + box.width, bottom: p.y + box.height })
    fixedCircles.push({ x: obj.x, y: obj.y, r })
  }
  return out
}

/** The object's label measured with the current style, placed against every other enabled
 *  label's box and marker; null when the object or style is missing. */
export function placeNewLabel(
  state: EditorState,
  measure: TextMeasurer,
  id: number,
): { x: number; y: number; collided: boolean } | null {
  return placeNewLabels(state, measure, [id]).get(id) ?? null
}
```

Note the subtle difference from the old single-label version: an enabled label that is itself in `ids` is not an obstacle. `enableWithPlacement` only passes disabled ids, so nothing changes for the single-toggle path.

- [ ] **Step 4: Implement `enableWithPlacement` and `disableAll`**

Append to `editing.ts`:

```ts
/** "Enable shown": every disabled id in `ids` is enabled in one store change. Labels never
 *  moved off their object are placed, each around the ones placed before it, so the whole batch
 *  is one undo entry and a measurement that throws leaves the document untouched. */
export function enableWithPlacement(ids: number[], measure?: TextMeasurer): void {
  const state = useEditor.getState()
  if (!isEditable(state)) return
  const toPlace: number[] = []
  const toEnable: number[] = []
  for (const id of ids) {
    const label = state.labels.get(id)
    const obj = state.objects.get(id)
    if (!label || !obj || label.enabled) continue
    toEnable.push(id)
    if (label.x === obj.x && label.y === obj.y) toPlace.push(id)
  }
  if (toEnable.length === 0) return
  const placed = placeNewLabels(state, measure ?? getMeasurer(), toPlace)
  const updated: Label[] = toEnable.map((id) => {
    const label = state.labels.get(id)!
    const p = placed.get(id)
    return p ? { ...label, enabled: true, x: p.x, y: p.y, collided: p.collided } : { ...label, enabled: true, collided: false }
  })
  state.applyLabels(updated)
}

/** "Disable shown": every enabled id in `ids` is disabled in one store change; positions stay. */
export function disableAll(ids: number[]): void {
  const state = useEditor.getState()
  if (!isEditable(state)) return
  const updated: Label[] = []
  for (const id of ids) {
    const label = state.labels.get(id)
    if (label?.enabled) updated.push({ ...label, enabled: false })
  }
  if (updated.length > 0) state.applyLabels(updated)
}
```

Add `import type { Label } from '../api'` and `placeNewLabels` to the placement import.

- [ ] **Step 5: `applyLabels` throws on unknown ids; `toggleObject` selection rule applies to bulk disable**

In `store.ts`:

```ts
  applyLabels: (updated) =>
    set((s) => {
      const labels = new Map(s.labels)
      for (const label of updated) {
        // Unreachable from the server (one label per object), so a mismatch is a bug: say so.
        if (!labels.has(label.object_id)) throw new Error(`applyLabels: no label for object ${label.object_id}`)
        labels.set(label.object_id, label)
      }
      const patch = changedDoc(s, { labels })
      // As in toggleObject: a label disabled by this change has nothing on the canvas to select.
      if ('labels' in patch && s.selectedId !== null && labels.get(s.selectedId)?.enabled === false) {
        patch.selectedId = null
      }
      return patch
    }),
```

- [ ] **Step 6: Rewrite `bulk` in `ObjectsTab.tsx`**

Replace the `bulk` function and its comment:

```ts
  // One store change for the whole batch: one undo entry, one autosave, and a measurement that
  // throws (a stale font) leaves the list exactly as it was — the error says so.
  const bulk = (enable: boolean) => {
    setError(null)
    const ids = rows.map((obj) => obj.id)
    try {
      if (enable) enableWithPlacement(ids)
      else disableAll(ids)
    } catch {
      setError('The labels could not be changed; nothing was altered.')
    }
  }
```

Update the import: `import { disableAll, enableWithPlacement, isEditable, toggleWithPlacement } from './editing'`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/editor && npx tsc --noEmit && npx eslint src/editor`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/editor/placement.ts frontend/src/editor/editing.ts frontend/src/editor/store.ts frontend/src/editor/ObjectsTab.tsx frontend/src/editor/placement.test.ts frontend/src/editor/editing.test.ts frontend/src/editor/store.test.ts
git commit -m "feat(editor): bulk enable/disable as one change with placements against a growing obstacle set"
```

---

### Task 7: Browser test — a drag then Ctrl+Z restores the position

**Files:**
- Modify: `frontend/e2e/smoke.spec.ts:93-95`

- [ ] **Step 1: Extend the smoke spec**

After the line `expect((await storedLabel(label!.id))!.y).toBeCloseTo(label!.y, 0)` insert:

```ts
  // Undo: Ctrl+Z puts the label back where the drag began, and the autosave writes that too.
  await page.keyboard.press('Control+z')
  await expect
    .poll(async () => (await storedLabel(label!.id))?.x ?? Number.NEGATIVE_INFINITY, { timeout: 3_000 })
    .toBeCloseTo(label!.x, 0)
  // Redo from the toolbar moves it forward again.
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect
    .poll(async () => (await storedLabel(label!.id))?.x ?? Number.NEGATIVE_INFINITY, { timeout: 3_000 })
    .toBeGreaterThan(label!.x)
```

- [ ] **Step 2: Run the browser suite**

Run: `make e2e` from the repo root (it builds the frontend, starts uvicorn on a scratch data dir and the fake nova; it never touches `data/`).
Expected: all specs pass, including `parity.spec.ts` (this PR changes no rendering) and `smoke.spec.ts` with the new steps. If the `Redo` click fails because the toolbar button is disabled, the undo did not commit: check `swapHistory` pushes onto the opposite stack.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/smoke.spec.ts
git commit -m "test(e2e): drag, Ctrl+Z restores, Redo moves again"
```

---

### Task 8: SPEC.md and design-spec wording

**Files:**
- Modify: `docs/SPEC.md:157` (§ 6.1 keyboard line), `docs/SPEC.md:197` (§ 6.3 Objects tab bulk sentence), `docs/SPEC.md:264` (§ 7 `version` remark)
- Modify: `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md` ("Document changes" paragraph)

- [ ] **Step 1: SPEC.md**

§ 6.1: replace `*M3 note:* \`Ctrl+Z\` / \`Ctrl+Y\` undo/redo ship with milestone 4 (§ 13).` with:

```
- `Ctrl+Z` undo, `Ctrl+Y` / `Ctrl+Shift+Z` redo (`Cmd` on macOS), also as toolbar buttons. The history is per editing session (lost on reload and cleared by a conflict), capped at 100 entries; a drag is one entry, a bulk enable is one entry, an auto-arrange is one entry. Keys are ignored while a form field has the focus.
```

§ 6.3 Objects tab: after `Bulk actions are "Enable shown" / "Disable shown" (both act on the rows the search and type filter currently show).` add:

```
Each is one change: the labels being enabled are placed one after another, each around the ones before it, and applied together, so a batch is one undo entry and one save.
```

§ 7: change `version       int   (bumped on every save; used for undo history file naming)` to `version       int   (bumped on every save; the editor's conflict check)`.

- [ ] **Step 2: Design spec**

In the design spec's "Document changes" paragraph, replace `It refuses (returns \`{}\`) while the document is not editable: a solve in \`pending\`/\`solving\`, or a sticky conflict.` with `It refuses (returns \`{}\`) while the document is not editable: a solve in \`pending\`/\`solving\`. A conflict does not stop editing, only saving (SPEC § 6.3); it does clear the history.`

- [ ] **Step 3: Full check and commit**

Run: `make lint test`
Expected: ruff, mypy, eslint, tsc, pytest and vitest all clean.

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md
git commit -m "docs: undo/redo and one-change bulk enable in SPEC § 6; conflict keeps editing live"
```

---

### Task 9: Review ritual and PR

- [ ] **Step 1:** `/code-review high` on the branch; fix what it finds; rerun `make lint test`.
- [ ] **Step 2:** silent-failure pass (`pr-review-toolkit:silent-failure-hunter`) on the diff; fix.
- [ ] **Step 3:** `/simplify`; rerun `make lint test` and `make e2e`.
- [ ] **Step 4:** Restart the dev unit if `npm ci` ran (`sudo systemctl restart astrocaption-dev`), then ask the owner to smoke-test on `make dev`: drag + Ctrl+Z, Enable shown on the Orion image, Space-pan over a label.
- [ ] **Step 5:** Open the PR with `gh pr create` (title `feat: editor store groundwork for milestone 4 (undo/redo, one-change bulk enable)`; body references the spec and says `Closes #78`, and that #75 is partly done, with the per-row selectors left for PR 5). Watch `gh pr checks --watch`. Do not merge without the owner's go.
