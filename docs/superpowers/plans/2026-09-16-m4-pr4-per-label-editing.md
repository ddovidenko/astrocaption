# Milestone 4 PR 4: Per-label Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can select several labels (shift-click), drag them as a group, edit one label's size, colour, aliases, leader and text from a floating toolbar or by wheel and double-click, and pin labels so the server's auto-arrange places the rest around them.

**Architecture:** The store's selection becomes a set; `moveLabel` moves every selected label by the same delta and pins them on commit; a new `updateLabels` applies a partial patch to a set of labels as one commit (or as a preview for wheel-resize, committed by `commitPreview` on mouse-up). The canvas grows two HTML overlays inside its container: `LabelToolbar` (above the union box of the selection) and `LabelTextEditor` (over the double-clicked label). Server side, `Label.pinned` is a stored field and `POST autoarrange` treats pinned labels as fixed obstacles unless `reset` is set.

**Tech Stack:** FastAPI + pydantic + pytest; React 19 + TypeScript strict + Zustand + react-konva + react-colorful; vitest (+ jsdom for component tests); Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md` § A "Selection", "Per-label toolbar", "Pinned labels" and "Data model and API changes"; PR order item 4. SPEC.md § 6.1, § 6.2, § 6.3 (Layout), § 7, § 8.

## Global Constraints

- Preview and export must produce the same layout. This PR changes no geometry, metrics or renderer code. Adding `pinned` to `Label` changes the render vectors only because they serialise the label objects: run `make render-vectors` in Task 1 and commit the regenerated `tests/fixtures/render/vectors.json` with the model change; `backend/tests/test_render_parity.py` fails while it is stale.
- Annotation geometry is stored in original image pixels. The overlays convert to screen pixels with `toScreen(view, …)` at the edges only.
- Every document mutation goes through `changedDoc` (the editable gate). `commit: false` is used only by drag frames and by wheel-resize frames; every toolbar control, drag-end, text edit, Delete and Reset position commits exactly one history entry per interaction.
- Selection and view are not part of the undo history.
- `Label.pinned: bool = False`; `extra="forbid"` stays on `Label` and `AnnotationsUpdate`. Set by drag-end; cleared by the toolbar's Reset position and by the Layout tab's Reset positions (`reset: true`). Server `autoarrange` treats pinned enabled labels as fixed obstacles.
- Font size bounds 6–200 (`MIN_FONT_SIZE`/`MAX_FONT_SIZE` in `metrics.ts`). Wheel: ±1 per notch, `deltaY < 0` grows.
- Keys are ignored while an input, textarea or select has the focus (the existing `inField` rule in `EditorCanvas.tsx`).
- API responses and the page never carry raw exception text; pydantic models for every response. No new dependencies.
- Settled UI patterns: `ColorField` (react-colorful, never the OS dialog), the toolbar buttons use `onMouseDown={(e) => e.preventDefault()}` so they never take the focus (canvas shortcuts stay alive), `.field` rhythm. Use the `secondary` button class for non-primary actions.
- Conventional one-line commit subjects; end every commit message with the attribution trailer the session reminder gives (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`).
- Never run `npm ci`/`npm install`/`make install FORCE=1`; never touch `data/`; never restart the dev unit; never start `make dev` by hand. `make lint test` and `make e2e` are the gates. Run vitest for one file with `cd frontend && npx vitest run src/editor/store.test.ts`; pytest for one file with `cd backend && .venv/bin/pytest -q tests/test_annotations_api.py`.
- Work on branch `feat/m4-pr4-per-label-editing` off `main`. Never push to `main`.

---

## File structure

| File | Responsibility after this PR |
|---|---|
| `backend/app/models.py` | `Label.pinned`; `AutoarrangeRequest(AnnotationsUpdate)` with `reset` |
| `backend/app/api/images.py` | `autoarrange` keeps pinned labels fixed, `reset` clears pins first |
| `backend/tests/test_annotations_api.py` | pinned autoarrange, reset |
| `tests/fixtures/render/vectors.json` | regenerated (labels carry `pinned`) |
| `frontend/src/api.ts` | `Label.pinned`, `api.autoarrange(id, doc, reset)` |
| `frontend/src/editor/store.ts` | `selectedIds`, `select`/`toggleSelect`, group `moveLabel` + pin on commit, `updateLabels`, `commitPreview` |
| `frontend/src/editor/editing.ts` | `resetPositions(ids)` (browser placer, unpins) |
| `frontend/src/editor/EditorCanvas.tsx` | multi-select, group drag, Delete on the selection, wheel-resize, double-click, mounts the two overlays |
| `frontend/src/editor/LabelToolbar.tsx` (+ `.test.tsx`) | the floating per-label toolbar |
| `frontend/src/editor/LabelTextEditor.tsx` | the inline text-override input |
| `frontend/src/editor/LayoutTab.tsx` | Reset positions sends `reset: true`; one line on pins |
| `frontend/src/styles.css` | `.label-toolbar`, `.label-text-editor` |
| `frontend/e2e/parity.spec.ts` | a second pixel diff on a document with per-label overrides and a pinned label |
| `frontend/e2e/labels.spec.ts` | toolbar, double-click, shift-click, wheel, pin/reset |
| `docs/SPEC.md` | § 6.1, § 6.2, § 6.3 Layout, § 7, § 8 |

---

### Task 1: Server — `Label.pinned`, `autoarrange` keeps pins, `reset` clears them

**Files:**
- Modify: `backend/app/models.py` (`Label`, new `AutoarrangeRequest` after `AnnotationsUpdate`)
- Modify: `backend/app/api/images.py:449-467` (`autoarrange`)
- Regenerate: `tests/fixtures/render/vectors.json` (`make render-vectors`)
- Test: `backend/tests/test_annotations_api.py`

**Interfaces:**
- Produces: `Label.pinned: bool = False`.
- Produces: `AutoarrangeRequest(AnnotationsUpdate)` with `reset: bool = False`. `POST /api/images/{id}/autoarrange` takes it; the response is unchanged (`Annotations`). With `reset` false, every enabled label whose `pinned` is true keeps its position and is an obstacle (`autoplace(..., keep=...)`, the existing `fixed_boxes`/`fixed_circles` path); the rest are placed. With `reset` true every label's `pinned` becomes false first and all enabled labels are placed. The returned labels carry the resulting `pinned` values.

- [ ] **Step 1: Failing tests**

Append to `backend/tests/test_annotations_api.py`:

```python
def _enabled(labels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [lab for lab in labels if lab["enabled"]]


def test_autoarrange_keeps_a_pinned_label_and_places_the_rest_around_it(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    a, b = _enabled(ann["labels"])[:2]
    # Park label a exactly where the placer put label b and pin it there: a must not move, and b
    # must now land somewhere else because a's box is in the way.
    pinned = {
        **ann,
        "labels": [
            {**lab, "x": b["x"], "y": b["y"], "pinned": True}
            if lab["object_id"] == a["object_id"]
            else {**lab, "x": 0.0, "y": 0.0}
            for lab in ann["labels"]
        ],
    }
    resp = client.post(f"/api/images/{image_id}/autoarrange", json=pinned)
    assert resp.status_code == 200, resp.text
    by_id = {lab["object_id"]: lab for lab in resp.json()["labels"]}
    kept = by_id[a["object_id"]]
    assert (kept["x"], kept["y"], kept["pinned"]) == (b["x"], b["y"], True)
    moved = by_id[b["object_id"]]
    assert (moved["x"], moved["y"]) not in {(0.0, 0.0), (b["x"], b["y"])}
    assert moved["pinned"] is False
    # every other enabled label was placed (none left at the parked origin)
    others = [lab for lab in _enabled(resp.json()["labels"]) if lab["object_id"] != a["object_id"]]
    assert others and all((lab["x"], lab["y"]) != (0.0, 0.0) for lab in others)


def test_autoarrange_reset_clears_every_pin_and_places_everything(
    client: TestClient, sample_jpeg: Path
) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    a = _enabled(ann["labels"])[0]
    pinned = {
        **ann,
        "labels": [
            {**lab, "x": 0.0, "y": 0.0, "pinned": lab["object_id"] == a["object_id"]}
            for lab in ann["labels"]
        ],
        "reset": True,
    }
    resp = client.post(f"/api/images/{image_id}/autoarrange", json=pinned)
    assert resp.status_code == 200, resp.text
    placed = resp.json()["labels"]
    assert all(lab["pinned"] is False for lab in placed)
    assert all((lab["x"], lab["y"]) != (0.0, 0.0) for lab in _enabled(placed))
    # the pinned label was placed like the others: back at its original slot
    by_id = {lab["object_id"]: lab for lab in placed}
    assert (by_id[a["object_id"]]["x"], by_id[a["object_id"]]["y"]) == (a["x"], a["y"])


def test_put_stores_pinned_and_a_get_defaults_it(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    assert all(lab["pinned"] is False for lab in ann["labels"])
    ann["labels"][0]["pinned"] = True
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 200, resp.text
    assert resp.json()["labels"][0]["pinned"] is True
    assert client.get(f"/api/images/{image_id}/annotations").json()["labels"][0]["pinned"] is True


def test_put_refuses_reset(client: TestClient, sample_jpeg: Path) -> None:
    """``reset`` belongs to autoarrange only; the document model still forbids unknown fields."""
    image_id, ann, _ = solved_image(client, sample_jpeg)
    resp = client.put(f"/api/images/{image_id}/annotations", json={**ann, "reset": True})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "reset: is not a known field"
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_annotations_api.py -k "pinned or reset"`
Expected: 4 failures (`pinned` is not a known field / `reset` is not a known field on the first three; the last passes only by accident until the model exists — it must still be present).

- [ ] **Step 3: The model**

In `backend/app/models.py`, `Label` gains one field after `collided`:

```python
    collided: bool = False
    # Kept where the owner put it: a drag or a toolbar edit pins a label, and the placer treats
    # it as a fixed obstacle until Reset position (one label) or Reset positions (all) unpins it.
    pinned: bool = False
```

After `AnnotationsUpdate`, add:

```python
class AutoarrangeRequest(AnnotationsUpdate):
    """``POST /autoarrange``: the document, plus whether to discard every pin first (the Layout
    tab's Reset positions). ``PUT /annotations`` keeps taking the plain document, so ``reset``
    cannot be stored by accident."""

    reset: bool = False
```

- [ ] **Step 4: The route**

In `backend/app/api/images.py`, import `AutoarrangeRequest` from `..models` next to `AnnotationsUpdate`, and replace `autoarrange`:

```python
@router.post("/{image_id}/autoarrange")
async def autoarrange(
    image_id: str, doc: AutoarrangeRequest, settings: SettingsDep, db: DbDep
) -> Annotations:
    """Run the placer on every enabled label of the submitted document and return the result
    without storing it; the editor applies it and autosaves (design § 4). Pinned labels stay
    where they are and block the others (spec § A); ``reset`` unpins everything first."""
    rec, stored = _annotations_target(db, image_id)
    _check_version(doc, stored, image_id)
    objects = db.get_objects(image_id)
    _validate_document(doc, objects, settings, image_id)
    labels = doc.labels
    if doc.reset:
        labels = [lab.model_copy(update={"pinned": False}) for lab in labels]
    keep = frozenset(lab.object_id for lab in labels if lab.enabled and lab.pinned)
    placed = await asyncio.to_thread(
        autoplace,
        rec.width,
        rec.height,
        doc.style,
        labels,
        objects,
        settings.fonts_dir,
        keep=keep,
    )
    return Annotations(
        image_id=image_id,
        style=doc.style,
        labels=placed,
        version=doc.version,
        updated_at=stored.updated_at,
    )
```

`_check_version` and `_validate_document` take an `AnnotationsUpdate`; a subclass instance is fine for both. `mypy` must stay clean.

- [ ] **Step 5: Regenerate the render vectors and run the backend suite**

Run: `make render-vectors && cd backend && .venv/bin/pytest -q`
Expected: `tests/fixtures/render/vectors.json` changes (every `label` object gains `"pinned": false`); all tests pass, including `test_render_parity.py` and the four new ones. `git diff --stat tests/fixtures/render/vectors.json` shows only added `pinned` lines.

- [ ] **Step 6: Lint and commit**

Run: `make lint-backend`
Expected: clean.

```bash
git add backend/app/models.py backend/app/api/images.py backend/tests/test_annotations_api.py tests/fixtures/render/vectors.json
git commit -m "feat: pinned labels; autoarrange keeps pins unless reset"
```

---

### Task 2: Store — selection set, group move with pinning, `updateLabels`, `commitPreview`

**Files:**
- Modify: `frontend/src/api.ts` (`Label`, `api.autoarrange`)
- Modify: `frontend/src/editor/store.ts`
- Modify: `frontend/src/editor/testDoc.ts` (labels gain `pinned: false`)
- Modify: every other TS file that builds a `Label` literal (tsc lists them; `frontend/src/editor/metrics.test.ts` around line 178 is one)
- Test: `frontend/src/editor/store.test.ts`

**Interfaces:**
- Produces (`api.ts`): `Label.pinned: boolean`; `api.autoarrange(id: string, doc: AnnotationsUpdate, reset = false)` posts `{ ...doc, reset }`.
- Produces (`store.ts`):
  - `selectedIds: ReadonlySet<number>` replaces `selectedId`.
  - `select(id: number | null)`: exactly that label (or nothing) is selected.
  - `toggleSelect(id: number)`: shift-click; adds or removes one id.
  - `moveLabel(id, x, y, commit = true)`: moves `id` to `(x, y)` and, when `id` is selected, every other selected label by the same delta measured from the *committed* positions. A commit sets `pinned: true` and `collided: false` on every moved label. A commit back at the committed position records nothing (as today), but keeps any other live preview (a wheel resize).
  - `updateLabels(ids: Iterable<number>, patch: LabelPatch, commit = true)` where `export type LabelPatch = Partial<Pick<Label, 'font_size' | 'color' | 'show_aliases' | 'leader' | 'text_override' | 'pinned' | 'collided'>>`. One commit for the whole set; a patch that changes nothing records nothing. With `commit = false` it is a preview frame.
  - `commitPreview()`: commits the current labels map if it differs field-wise from the committed one (one history entry), else restores the committed map's identity. What the wheel-resize calls on mouse-up.
  - `changedDoc` drops from `selectedIds` every id whose label the new map disables.

- [ ] **Step 1: Failing tests**

In `frontend/src/editor/store.test.ts`, replace every `selectedId` assertion with the set form, and add the new cases. The edits to existing tests:

```ts
// 'select and hover set and clear ids'
    useEditor.getState().select(1)
    expect([...useEditor.getState().selectedIds]).toEqual([1])
    useEditor.getState().select(null)
    expect(useEditor.getState().selectedIds.size).toBe(0)
// 'reset empties everything'
    expect(state.selectedIds.size).toBe(0)
// 'toggleObject clears a selection that is being disabled, and keeps one being enabled'
    expect(useEditor.getState().selectedIds.has(1)).toBe(false)
    ...
    expect(useEditor.getState().selectedIds.has(1)).toBe(true)
// 'toggleObject leaves another label's selection alone'
    expect([...useEditor.getState().selectedIds]).toEqual([1])
// 'undoLast clears a selection the restored snapshot disables'
    expect(useEditor.getState().selectedIds.size).toBe(0)
// 'undoLast leaves a selection alone when the restored snapshot keeps it enabled'
    expect([...useEditor.getState().selectedIds]).toEqual([1])
```

The existing test `'moveLabel sets the position and clears collided'` keeps passing; extend its expectation with `pinned: true`. Add a new `describe`:

```ts
describe('selection and per-label editing', () => {
  it('toggleSelect adds and removes one id; select replaces the set', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 100, y: 100 })
    s.toggleSelect(1)
    useEditor.getState().toggleSelect(2)
    expect([...useEditor.getState().selectedIds].sort()).toEqual([1, 2])
    useEditor.getState().toggleSelect(1)
    expect([...useEditor.getState().selectedIds]).toEqual([2])
    useEditor.getState().select(1)
    expect([...useEditor.getState().selectedIds]).toEqual([1])
    useEditor.getState().select(null)
    expect(useEditor.getState().selectedIds.size).toBe(0)
  })

  it('a drag commit pins the moved label', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.moveLabel(1, 10, 20)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: 10, y: 20, pinned: true, collided: false })
    expect(useEditor.getState().undo).toHaveLength(1)
  })

  it('dragging a selected label moves every selected label by the same delta, as one commit', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 100, y: 100 })
    const one = useEditor.getState().labels.get(1)!
    useEditor.getState().select(1)
    useEditor.getState().toggleSelect(2)
    const entries = useEditor.getState().undo.length
    useEditor.getState().moveLabel(1, one.x + 5, one.y + 7, false)
    expect(useEditor.getState().labels.get(2)).toMatchObject({ x: 105, y: 107, pinned: false })
    useEditor.getState().moveLabel(1, one.x + 10, one.y + 14)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: one.x + 10, y: one.y + 14, pinned: true })
    expect(useEditor.getState().labels.get(2)).toMatchObject({ x: 110, y: 114, pinned: true })
    expect(useEditor.getState().undo).toHaveLength(entries + 1)
    useEditor.getState().undoLast()
    expect(useEditor.getState().labels.get(2)).toMatchObject({ x: 100, y: 100, pinned: false })
  })

  it('dragging an unselected label moves only that label', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 100, y: 100 })
    useEditor.getState().select(2)
    const one = useEditor.getState().labels.get(1)!
    useEditor.getState().moveLabel(1, one.x + 5, one.y)
    expect(useEditor.getState().labels.get(2)).toMatchObject({ x: 100, y: 100 })
  })

  it('updateLabels patches every id as one commit and skips a patch that changes nothing', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 100, y: 100 })
    const entries = useEditor.getState().undo.length
    useEditor.getState().updateLabels([1, 2], { font_size: 30, color: '#ff0000' })
    expect(useEditor.getState().labels.get(1)).toMatchObject({ font_size: 30, color: '#ff0000' })
    expect(useEditor.getState().labels.get(2)).toMatchObject({ font_size: 30, color: '#ff0000' })
    expect(useEditor.getState().undo).toHaveLength(entries + 1)
    useEditor.getState().updateLabels([1, 2], { font_size: 30 })
    expect(useEditor.getState().undo).toHaveLength(entries + 1)
    useEditor.getState().updateLabels([999], { font_size: 12 })
    expect(useEditor.getState().undo).toHaveLength(entries + 1)
  })

  it('updateLabels is refused while a solve is running', () => {
    const s = useEditor.getState()
    s.load({ ...doc, image: { ...doc.image, solve_status: 'solving' } })
    s.updateLabels([1], { font_size: 30 })
    expect(useEditor.getState().labels.get(1)!.font_size).toBeNull()
  })

  it('a wheel resize previews frames and commitPreview records one entry', () => {
    const s = useEditor.getState()
    s.load(doc)
    const seq = useEditor.getState().changeSeq
    s.updateLabels([1], { font_size: 25 }, false)
    useEditor.getState().updateLabels([1], { font_size: 26 }, false)
    expect(useEditor.getState().labels.get(1)!.font_size).toBe(26)
    expect(useEditor.getState().changeSeq).toBe(seq)
    expect(useEditor.getState().undo).toHaveLength(0)
    useEditor.getState().commitPreview()
    expect(useEditor.getState().changeSeq).toBe(seq + 1)
    expect(useEditor.getState().undo).toHaveLength(1)
    useEditor.getState().undoLast()
    expect(useEditor.getState().labels.get(1)!.font_size).toBeNull()
  })

  it('commitPreview after a resize back to the starting size records nothing', () => {
    const s = useEditor.getState()
    s.load(doc)
    const committedLabels = useEditor.getState().labels
    s.updateLabels([1], { font_size: 25 }, false)
    useEditor.getState().updateLabels([1], { font_size: null }, false)
    useEditor.getState().commitPreview()
    expect(useEditor.getState().labels).toBe(committedLabels)
    expect(useEditor.getState().undo).toHaveLength(0)
  })

  it('a drag that ends where it began keeps a live wheel-resize preview', () => {
    const s = useEditor.getState()
    s.load(doc)
    const { x, y } = useEditor.getState().labels.get(1)!
    s.updateLabels([1], { font_size: 25 }, false)
    useEditor.getState().moveLabel(1, x + 3, y, false)
    useEditor.getState().moveLabel(1, x, y)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x, y, font_size: 25, pinned: false })
    expect(useEditor.getState().undo).toHaveLength(0)
    useEditor.getState().commitPreview()
    expect(useEditor.getState().undo).toHaveLength(1)
    expect(useEditor.getState().labels.get(1)).toMatchObject({ font_size: 25, pinned: false })
  })

  it('a disabled label leaves the selection', () => {
    const s = useEditor.getState()
    s.load(doc)
    s.toggleObject(2, { x: 100, y: 100 })
    useEditor.getState().select(1)
    useEditor.getState().toggleSelect(2)
    useEditor.getState().applyLabels([{ ...useEditor.getState().labels.get(2)!, enabled: false }])
    expect([...useEditor.getState().selectedIds]).toEqual([1])
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd frontend && npx vitest run src/editor/store.test.ts`
Expected: compile errors on `selectedIds`, `toggleSelect`, `updateLabels`, `commitPreview`, `pinned`.

- [ ] **Step 3: `api.ts`**

In `Label`, after `collided: boolean`:

```ts
  /** Kept where the owner put it: a drag pins; Reset position / Reset positions unpin. The
   *  server's placer treats a pinned label as a fixed obstacle. */
  pinned: boolean
```

Replace `autoarrange` in the `api` object:

```ts
  /** `reset` unpins every label first (the Layout tab's Reset positions). */
  autoarrange: (id: string, doc: AnnotationsUpdate, reset = false) =>
    request<Annotations>(`/api/images/${id}/autoarrange`, json('POST', { ...doc, reset })),
```

- [ ] **Step 4: `testDoc.ts` and other Label literals**

Add `pinned: false` to both labels in `makeDoc()` (after `collided: false`). Run `cd frontend && npx tsc --noEmit -p tsconfig.json` and add `pinned: false` to every other Label literal it reports (`metrics.test.ts` builds one from the vectors' `label` field, which now carries `pinned` already; check its hand-written literal near line 178).

- [ ] **Step 5: `store.ts`**

Replace the selection state and the three actions, and add the new ones. Exact edits:

State (`EditorState`): replace `selectedId: number | null` with `selectedIds: ReadonlySet<number>`; replace `select(id: number | null): void` with:

```ts
  /** Exactly this label (or nothing) is selected. */
  select(id: number | null): void
  /** Shift-click: adds or removes one label. */
  toggleSelect(id: number): void
```

After `applyLabels(labels: Label[]): void` add:

```ts
  /** One patch onto every listed label; one commit (one undo entry) for the set, nothing at all
   *  when the patch changes nothing. `commit: false` is a preview frame (wheel-resize). */
  updateLabels(ids: Iterable<number>, patch: LabelPatch, commit?: boolean): void
  /** Commits whatever preview frames left in the labels map, as one entry; a no-op when the
   *  map matches the committed document field by field. */
  commitPreview(): void
```

Add the type next to `Snapshot`:

```ts
/** The per-label fields the toolbar, the wheel and the text editor may change. Position is
 *  `moveLabel`'s; `enabled` is `toggleObject`'s / `applyLabels`'. */
export type LabelPatch = Partial<
  Pick<Label, 'font_size' | 'color' | 'show_aliases' | 'leader' | 'text_override' | 'pinned' | 'collided'>
>
```

`initial`: replace `selectedId: null` with `selectedIds: new Set<number>() as ReadonlySet<number>`.

Helpers, after `committed(...)`:

```ts
/** Field-wise equality of two labels (they are flat). */
function sameLabel(a: Label, b: Label): boolean {
  for (const key of Object.keys(a) as (keyof Label)[]) if (a[key] !== b[key]) return false
  return Object.keys(a).length === Object.keys(b).length
}

/** Commits `labels` if any entry differs field-wise from the committed document; otherwise
 *  restores the committed map's identity (the canvas memoises on it) and records nothing. */
function commitLabels(s: EditorState, labels: Map<number, Label>): Partial<EditorState> {
  const base = s.committed?.labels
  if (!base) return changedDoc(s, { labels }) ?? {}
  let diverged = false
  for (const [id, label] of labels) {
    const was = base.get(id)
    if (!was || (label !== was && !sameLabel(label, was))) {
      diverged = true
      break
    }
  }
  if (diverged) return changedDoc(s, { labels }) ?? {}
  return s.labels !== base ? { labels: base } : {}
}
```

In `changedDoc`, replace the `selectedId` line with:

```ts
  if (s.selectedIds.size > 0) {
    const kept = new Set([...s.selectedIds].filter((id) => labels.get(id)?.enabled === true))
    if (kept.size !== s.selectedIds.size) next.selectedIds = kept
  }
```

`load`: replace `selectedId: null` with `selectedIds: new Set()`. `reset`: `initial` already carries an empty set, but a fresh one is safer: add `selectedIds: new Set()` to the `reset` payload.

Actions:

```ts
  select: (id) => set({ selectedIds: id === null ? new Set() : new Set([id]) }),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds)
      if (!next.delete(id)) next.add(id)
      return { selectedIds: next }
    }),
```

Replace `moveLabel`:

```ts
  moveLabel: (id, x, y, commit = true) =>
    set((s) => {
      const label = s.labels.get(id)
      if (!label) return {}
      // Deltas are measured against the last committed position, not the last preview frame:
      // Konva fires dragmove/dragend at the start position for a gesture that never moved, and a
      // drag that came back to where it began has changed nothing worth an undo entry or a save
      // (it would also clear the placer's `collided` verdict). Preview frames are gated like
      // commits, so the maps can only have diverged while the document was editable.
      const base = s.committed?.labels ?? s.labels
      const origin = base.get(id) ?? label
      const dx = x - origin.x
      const dy = y - origin.y
      // A selected label drags the whole selection; an unselected one drags alone.
      const moving = s.selectedIds.has(id) ? [...s.selectedIds] : [id]
      const labels = new Map(s.labels)
      for (const mid of moving) {
        const was = base.get(mid)
        const cur = s.labels.get(mid)
        if (!was || !cur) continue
        if (dx === 0 && dy === 0) {
          // Back at the start: only the position preview is undone. Another live preview on the
          // same label (a wheel resize during the press) stays for commitPreview to record.
          const restored = { ...cur, x: was.x, y: was.y, collided: was.collided, pinned: was.pinned }
          labels.set(mid, sameLabel(restored, was) ? was : restored)
        } else {
          labels.set(mid, { ...cur, x: was.x + dx, y: was.y + dy, collided: false, pinned: commit ? true : was.pinned })
        }
      }
      if (!commit) return changedDoc(s, { labels }, false) ?? {}
      return commitLabels(s, labels)
    }),
```

Add after `applyLabels`:

```ts
  updateLabels: (ids, patch, commit = true) =>
    set((s) => {
      const labels = new Map(s.labels)
      let touched = false
      for (const id of ids) {
        const label = s.labels.get(id)
        if (!label) continue
        const next = { ...label, ...patch }
        if (sameLabel(next, label)) continue
        labels.set(id, next)
        touched = true
      }
      if (!commit) return touched ? (changedDoc(s, { labels }, false) ?? {}) : {}
      // A commit is measured against the committed document, so a preview brought back to its
      // starting value records nothing even though this frame "changed" the map.
      if (!touched && s.labels === s.committed?.labels) return {}
      return commitLabels(s, labels)
    }),
  commitPreview: () => set((s) => (s.committed && s.labels !== s.committed.labels ? commitLabels(s, s.labels) : {})),
```

Update the doc comment above `changedDoc` ("It also drops a selection the new labels map disables" → "It also drops from the selection every label the new map disables").

- [ ] **Step 6: Run the store tests, then the whole frontend suite**

Run: `cd frontend && npx vitest run src/editor/store.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: store tests pass; tsc reports only `EditorCanvas.tsx` (still on `selectedId`) — fix that in Task 3, not here. If tsc reports other Label literals, add `pinned: false` to them now.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.ts frontend/src/editor/store.ts frontend/src/editor/store.test.ts frontend/src/editor/testDoc.ts frontend/src/editor/metrics.test.ts
git commit -m "feat: editor store: selection set, group move with pinning, updateLabels, commitPreview"
```

(Include any other file tsc made you touch.)

---

### Task 3: Canvas — multi-select, group drag, Delete on the selection, wheel-resize

**Files:**
- Modify: `frontend/src/editor/EditorCanvas.tsx`
- Test: `frontend/src/editor/store.test.ts` already covers the store side; the canvas has no jsdom test (Konva needs a browser). The Playwright spec in Task 8 covers it.

**Interfaces:**
- Consumes: `selectedIds`, `select`, `toggleSelect`, `moveLabel`, `updateLabels`, `commitPreview` from Task 2; `disableAll` from `editing.ts`.
- Produces: `EditorTestHook` gains `selectedIds(): number[]` (what the e2e spec asserts on after a click / shift-click). `LabelEntry`'s props change: `select` becomes `onPress(id: number, shift: boolean): void` and a new `onDoubleClick(id: number): void` (wired in Task 5; declare it now so the prop shape is settled).

- [ ] **Step 1: Selection reads**

Replace `const selectedId = useEditor((s) => s.selectedId)` with `const selectedIds = useEditor((s) => s.selectedIds)` and remove `const select = useEditor((s) => s.select)` (the handlers below read the store directly).

Replace the `selected` memo with:

```ts
  const selectedEntries = useMemo(
    () => entries.filter((e) => selectedIds.has(e.label.object_id)),
    [entries, selectedIds],
  )
```

In the overlay layer replace the single selection `Rect` with one per entry:

```tsx
              {selectedEntries.map(({ label, box }) => (
                <Rect
                  key={label.object_id}
                  x={label.x}
                  y={label.y}
                  width={box.width}
                  height={box.height}
                  stroke={HOVER_COLOR}
                  strokeWidth={1 / view.scale}
                  listening={false}
                />
              ))}
```

`onStageClick`: `select(null)` → `useEditor.getState().select(null)`.

- [ ] **Step 2: Press handling and the wheel-resize press ref**

Add next to the other refs:

```ts
  // The label under a held left button, for wheel-to-resize (SPEC § 6.2): set by the label's
  // mousedown, cleared (and the size preview committed) on the window's mouseup.
  const pressRef = useRef<number | null>(null)
```

Add the handlers (after `onDrawError`):

```ts
  // A press selects: plain replaces the selection unless the label is already in it (so a drag
  // of one selected label moves the whole group), shift toggles membership.
  const onLabelPress = useCallback((id: number, shift: boolean) => {
    const s = useEditor.getState()
    if (shift) s.toggleSelect(id)
    else if (!s.selectedIds.has(id)) s.select(id)
    pressRef.current = id
  }, [])
```

Add a window mouseup effect (next to the `panning` one):

```ts
  // The wheel-resize preview is committed when the button comes up, wherever that happens.
  // Konva's own window listener fires first, so a drag-end commit has already folded the size
  // into its entry by then and commitPreview finds nothing left to record.
  useEffect(() => {
    const up = () => {
      if (pressRef.current === null) return
      pressRef.current = null
      useEditor.getState().commitPreview()
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])
```

Replace `onWheel`:

```ts
  // 7. Wheel: resize the pressed label (left button held), otherwise zoom about the cursor.
  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const pressed = pressRef.current
    if (pressed !== null && (e.evt.buttons & 1) === 1) {
      const s = useEditor.getState()
      const label = s.labels.get(pressed)
      if (!label || !s.style) return
      const current = label.font_size ?? s.style.font_size
      const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + (e.evt.deltaY < 0 ? 1 : -1)))
      s.updateLabels([pressed], { font_size: size }, false)
      return
    }
    const stage = stageRef.current
    const pointer = stage?.getPointerPosition()
    if (!pointer) return
    setView(zoomAt(view, pointer.x, pointer.y, Math.exp(-e.evt.deltaY * 0.0015)))
  }
```

Import `MAX_FONT_SIZE, MIN_FONT_SIZE` from `./metrics` and `disableAll` from `./editing`.

- [ ] **Step 3: `LabelEntry` props**

Change `EntryProps`: replace `select: (id: number | null) => void` with

```ts
  onPress: (id: number, shift: boolean) => void
  onDoubleClick: (id: number) => void
```

In `LabelEntry`, destructure `onPress, onDoubleClick` instead of `select`, and change the draggable group:

```tsx
        onMouseDown={(e) => {
          if (spacePan || e.evt.button === 1) return
          onPress(label.object_id, e.evt.shiftKey)
        }}
        onDblClick={(e) => {
          if (e.evt.button === 0 && !spacePan) onDoubleClick(label.object_id)
        }}
        onDragStart={() => {
          // A drag begun without a press we saw (a synthetic one) still selects the label.
          const s = useEditor.getState()
          if (!s.selectedIds.has(label.object_id)) s.select(label.object_id)
        }}
```

`onDragMove`/`onDragEnd` stay as they are (`moveLabel` now moves the selection).

Pass the new props from the `AnnotationLayer` call: replace `select={select}` with `onPress={onLabelPress}` and add `onDoubleClick={onLabelDoubleClick}`; for this task declare a placeholder that Task 5 replaces:

```ts
  const onLabelDoubleClick = useCallback((id: number) => {
    setEditingId(id)
  }, [])
  const [editingId, setEditingId] = useState<number | null>(null)
```

(Declare the state before the callback. `editingId` is read in Task 5; until then `void editingId` after the declaration keeps eslint's no-unused-vars quiet — remove that line in Task 5.)

- [ ] **Step 4: Keys**

In the key effect, replace the `Delete`/`Backspace` branch body:

```ts
        e.preventDefault()
        const s = useEditor.getState()
        if (s.selectedIds.size === 0 || !isEditable(s)) return
        // One commit for the whole selection (SPEC § 6.1). applyLabels drops them from the
        // selection itself, so nothing is left behind to toggle back on.
        disableAll([...s.selectedIds])
```

- [ ] **Step 5: Test hook**

Add to `EditorTestHook`:

```ts
  /** The selected object ids, for the spec that drives clicks and shift-clicks. */
  selectedIds(): number[]
```

and in the published object: `selectedIds: () => [...useEditor.getState().selectedIds],`.

- [ ] **Step 6: Verify**

Run: `cd frontend && npm run lint --silent && npx vitest run`
Expected: clean and green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/editor/EditorCanvas.tsx
git commit -m "feat: canvas multi-select, group drag, Delete on the selection, wheel-to-resize"
```

---

### Task 4: `resetPositions` in `editing.ts`

**Files:**
- Modify: `frontend/src/editor/editing.ts`
- Test: `frontend/src/editor/editing.test.ts`

**Interfaces:**
- Produces: `resetPositions(ids: number[], measure?: TextMeasurer): void` — re-places every enabled label in `ids` with the browser placer against every *other* enabled label's box and marker (`placeNewLabels`, which already treats the ids being placed as non-obstacles and places them one after another), sets `pinned: false` and the placer's `collided`, and applies the batch as one commit through `applyLabels`. Ids without an enabled label are skipped; nothing happens when the document is not editable.

- [ ] **Step 1: Failing test**

Append to `frontend/src/editor/editing.test.ts` (import `resetPositions` from `./editing`):

```ts
describe('resetPositions', () => {
  it('re-places the labels with the browser placer, unpins them, as one commit', () => {
    useEditor.getState().load(doc)
    useEditor.getState().moveLabel(1, 5, 5) // pins label 1 at an odd spot
    expect(useEditor.getState().labels.get(1)).toMatchObject({ x: 5, y: 5, pinned: true })
    const entries = useEditor.getState().undo.length
    resetPositions([1], measure)
    const label = useEditor.getState().labels.get(1)!
    expect(label.pinned).toBe(false)
    expect([label.x, label.y]).not.toEqual([5, 5])
    expect([label.x, label.y]).toEqual([placeNewLabel(useEditor.getState(), measure, 1)!.x, placeNewLabel(useEditor.getState(), measure, 1)!.y])
    expect(useEditor.getState().undo).toHaveLength(entries + 1)
  })

  it('skips disabled and unknown ids and does nothing while a solve is running', () => {
    useEditor.getState().load(doc)
    const before = useEditor.getState().labels
    resetPositions([2, 999], measure) // 2 is disabled
    expect(useEditor.getState().labels).toBe(before)

    useEditor.getState().load({ ...makeDoc(), image: { ...makeDoc().image, solve_status: 'solving' } })
    const frozen = useEditor.getState().labels
    resetPositions([1], measure)
    expect(useEditor.getState().labels).toBe(frozen)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd frontend && npx vitest run src/editor/editing.test.ts`
Expected: `resetPositions` is not exported.

- [ ] **Step 3: Implement**

Append to `frontend/src/editor/editing.ts`:

```ts
/** The toolbar's Reset position: every enabled id in `ids` is placed again by the browser placer
 *  (each around every other enabled label's box and marker, and around the ids placed before it)
 *  and unpinned, in one store change. */
export function resetPositions(ids: number[], measure?: TextMeasurer): void {
  const state = useEditor.getState()
  if (!isEditable(state)) return
  const wanted = ids.filter((id) => state.labels.get(id)?.enabled && state.objects.has(id))
  if (wanted.length === 0) return
  const placed = placeNewLabels(state, measure ?? getMeasurer(), wanted)
  const updated: Label[] = []
  for (const id of wanted) {
    const label = state.labels.get(id)
    const p = placed.get(id)
    if (!label || !p) continue
    updated.push({ ...label, x: p.x, y: p.y, collided: p.collided, pinned: false })
  }
  if (updated.length > 0) state.applyLabels(updated)
}
```

- [ ] **Step 4: Run, lint, commit**

Run: `cd frontend && npx vitest run src/editor/editing.test.ts && npm run lint --silent`
Expected: green and clean.

```bash
git add frontend/src/editor/editing.ts frontend/src/editor/editing.test.ts
git commit -m "feat: resetPositions re-places and unpins labels with the browser placer"
```

---

### Task 5: Inline text editor (double-click)

**Files:**
- Create: `frontend/src/editor/LabelTextEditor.tsx`
- Create: `frontend/src/editor/LabelTextEditor.test.tsx`
- Modify: `frontend/src/editor/EditorCanvas.tsx` (mount it; remove the `void editingId` placeholder)
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `LabelTextEditor({ id, x, y, width, fontSize, onClose })` — `x, y` the label's top-left and `fontSize` the primary size, all in **original pixels**; the component reads `view` and `style` from the store to place itself in screen space and to set the font (`fontFamilyFor(style.font_file)`). Enter commits `updateLabels([id], { text_override: trimmed || null })` and closes; Escape closes without a commit; blur commits like Enter (the owner clicked elsewhere expecting the edit to stick; the spec names Enter and Esc only). The input starts with the current override, or the label's primary text when there is none, selected.

- [ ] **Step 1: Failing component test**

`frontend/src/editor/LabelTextEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LabelTextEditor from './LabelTextEditor'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

beforeEach(() => {
  useEditor.getState().reset()
  useEditor.getState().load(makeDoc())
  useEditor.getState().setViewport(1000, 800) // fits: scale < 1
})
afterEach(cleanup)

const input = () => screen.getByRole('textbox', { name: 'Label text' }) as HTMLInputElement

describe('LabelTextEditor', () => {
  it('starts with the primary text, Enter commits the trimmed override and closes', () => {
    const onClose = vi.fn()
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={onClose} />)
    expect(input().value).toBe('M 42')
    fireEvent.change(input(), { target: { value: '  Great Nebula  ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useEditor.getState().labels.get(1)!.text_override).toBe('Great Nebula')
    expect(useEditor.getState().undo).toHaveLength(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a blank commits null (back to the catalogue name)', () => {
    useEditor.getState().updateLabels([1], { text_override: 'Old' })
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={() => {}} />)
    expect(input().value).toBe('Old')
    fireEvent.change(input(), { target: { value: '   ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useEditor.getState().labels.get(1)!.text_override).toBeNull()
  })

  it('Escape closes without a commit', () => {
    const onClose = vi.fn()
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={onClose} />)
    fireEvent.change(input(), { target: { value: 'Nope' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(useEditor.getState().labels.get(1)!.text_override).toBeNull()
    expect(useEditor.getState().undo).toHaveLength(0)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is placed and sized through the view transform', () => {
    render(<LabelTextEditor id={1} x={1552} y={970} width={120} fontSize={24} onClose={() => {}} />)
    const { view } = useEditor.getState()
    const el = input()
    expect(el.style.left).toBe(`${1552 * view.scale + view.x}px`)
    expect(el.style.top).toBe(`${970 * view.scale + view.y}px`)
    expect(el.style.fontSize).toBe(`${24 * view.scale}px`)
    expect(el.style.fontFamily).toContain('Inter-Regular')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `cd frontend && npx vitest run src/editor/LabelTextEditor.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement**

`frontend/src/editor/LabelTextEditor.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { fontFamilyFor, labelText } from './metrics'
import { useEditor } from './store'
import { toScreen } from './view'

interface Props {
  id: number
  /** The label's top-left, its measured width and its primary size, in original pixels. */
  x: number
  y: number
  width: number
  fontSize: number
  onClose: () => void
}

/** The double-click text editor (SPEC § 6.2): one input over the label, in the label's font at
 *  the label's on-screen size. Enter (or leaving the field) commits the trimmed text as
 *  `text_override`, a blank clears it, Escape cancels. Geometry comes in as original pixels and
 *  is converted here, at the edge. */
export default function LabelTextEditor({ id, x, y, width, fontSize, onClose }: Props) {
  const view = useEditor((s) => s.view)
  const style = useEditor((s) => s.style)
  const label = useEditor((s) => s.labels.get(id))
  const obj = useEditor((s) => s.objects.get(id))
  const initial = label && obj && style ? (label.text_override ?? labelText(obj, label, style).primary) : ''
  const [draft, setDraft] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  // Whether a commit or a cancel already closed us: the blur that follows must not commit again.
  const doneRef = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  if (!style || !label) return null

  const finish = (commit: boolean) => {
    if (doneRef.current) return
    doneRef.current = true
    if (commit) {
      const text = draft.trim()
      useEditor.getState().updateLabels([id], { text_override: text === '' ? null : text })
    }
    onClose()
  }

  const at = toScreen(view, x, y)
  return (
    <input
      ref={ref}
      className="label-text-editor"
      aria-label="Label text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
        // Every other key stays in the field: the canvas shortcuts ignore a focused input.
      }}
      onBlur={() => finish(true)}
      style={{
        left: `${at.x}px`,
        top: `${at.y}px`,
        minWidth: `${Math.max(80, width * view.scale + 24)}px`,
        fontSize: `${fontSize * view.scale}px`,
        fontFamily: `"${fontFamilyFor(style.font_file)}"`,
      }}
    />
  )
}
```

CSS, append to `frontend/src/styles.css` in the editor section:

```css
/* The double-click text editor: absolutely placed over the label by LabelTextEditor. */
.label-text-editor { position: absolute; z-index: 5; padding: 0 4px; line-height: 1.2; background: rgba(0, 0, 0, 0.85); color: var(--text); border: 1px solid var(--accent); border-radius: 3px; }
```

- [ ] **Step 4: Mount it in the canvas**

In `EditorCanvas.tsx`, remove the `void editingId` line. The entry being edited:

```ts
  const editing = editingId === null ? null : (entries.find((e) => e.label.object_id === editingId) ?? null)
```

Inside the `.editor-canvas` container, after the tooltip:

```tsx
        {editing && (
          <LabelTextEditor
            key={editing.label.object_id}
            id={editing.label.object_id}
            x={editing.label.x}
            y={editing.label.y}
            width={editing.box.width}
            fontSize={editing.box.primarySize}
            onClose={() => setEditingId(null)}
          />
        )}
```

Import `LabelTextEditor from './LabelTextEditor'`. The key handler must not act on Escape while the editor is open: the input has the focus, so `inField()` already blocks it.

- [ ] **Step 5: Verify, commit**

Run: `cd frontend && npx vitest run && npm run lint --silent`
Expected: green and clean.

```bash
git add frontend/src/editor/LabelTextEditor.tsx frontend/src/editor/LabelTextEditor.test.tsx frontend/src/editor/EditorCanvas.tsx frontend/src/styles.css
git commit -m "feat: double-click inline text override editor"
```

---

### Task 6: The floating per-label toolbar

**Files:**
- Create: `frontend/src/editor/LabelToolbar.tsx`
- Create: `frontend/src/editor/LabelToolbar.test.tsx`
- Modify: `frontend/src/editor/EditorCanvas.tsx` (mount it above the selection)
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `updateLabels`, `selectedIds`, `style`, `labels`, `view`, `viewport` from the store; `resetPositions` from `editing.ts`; `ColorField` from `../style/ColorField`; `MIN_FONT_SIZE`/`MAX_FONT_SIZE` from `./metrics`; `toScreen` from `./view`.
- Produces: `LabelToolbar({ box })` where `box: Box` (from `./metrics`, original pixels) is the union of the selected labels' text boxes. Renders nothing when the selection is empty or the document is not editable. Positioned above the box in screen space (`top = boxTop − height − 8`), clamped to the viewport (`8 px` margin; below the box when there is no room above). Controls left to right, each committing one history entry per interaction:
  - `Font size` (`<input type="number" min=6 max=200>`, `aria-label="Font size"`): value = the common override, blank when mixed or when none; placeholder = the global size. Commits on Enter and blur (an integer in bounds → `font_size: n`; blank → `font_size: null`; anything else is ignored and the draft reverts). `−` / `+` buttons (`aria-label="Smaller"`/`"Larger"`) step every selected label by 1 from its effective size, clamped.
  - `Text colour` (`ColorField` with `allowDefault`, `fallback = style.text_color`): `onCommit` stores `color: hex` or `null` for "Use default"; a mixed selection shows the default chip.
  - `Aliases` select (`aria-label="Aliases"`): `inherit` / `on` / `off` (+ a disabled `mixed` option shown only when mixed) → `show_aliases: null | true | false`.
  - `Leader` select (`aria-label="Leader"`): `auto` / `on` / `off` (+ `mixed`) → `leader`.
  - `Pin` toggle button (`aria-pressed`): pressed when every selected label is pinned; click pins all when any is unpinned, else unpins all. Label text reads "Pinned" when pressed, "Pin" otherwise, "Pin (mixed)" when mixed.
  - `Reset position` button → `resetPositions([...selectedIds])`.
  - `Clear overrides` button → `updateLabels(ids, { font_size: null, color: null, show_aliases: null, leader: 'auto', text_override: null })`.

- [ ] **Step 1: Failing component test**

`frontend/src/editor/LabelToolbar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LabelToolbar from './LabelToolbar'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

const box = { left: 1552, top: 970, right: 1700, bottom: 1000 }
const state = () => useEditor.getState()
const label = (id: number) => state().labels.get(id)!

beforeEach(() => {
  state().reset()
  state().load(makeDoc())
  state().setViewport(1000, 800)
  state().toggleObject(2, { x: 100, y: 100 })
  state().select(1)
})
afterEach(cleanup)

const size = () => screen.getByLabelText('Font size') as HTMLInputElement

describe('LabelToolbar', () => {
  it('renders nothing without a selection', () => {
    state().select(null)
    const { container } = render(<LabelToolbar box={box} />)
    expect(container.querySelector('.label-toolbar')).toBeNull()
  })

  it('font size: blank means the global size; Enter commits; blank clears', () => {
    render(<LabelToolbar box={box} />)
    expect(size().value).toBe('')
    expect(size().placeholder).toBe('24')
    fireEvent.change(size(), { target: { value: '30' } })
    fireEvent.keyDown(size(), { key: 'Enter' })
    expect(label(1).font_size).toBe(30)
    expect(state().undo).toHaveLength(2) // toggleObject + this
    fireEvent.change(size(), { target: { value: '' } })
    fireEvent.blur(size())
    expect(label(1).font_size).toBeNull()
    fireEvent.change(size(), { target: { value: '3' } })
    fireEvent.blur(size())
    expect(label(1).font_size).toBeNull() // out of bounds: ignored
    expect(size().value).toBe('')
  })

  it('− / + step every selected label from its effective size', () => {
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    fireEvent.click(screen.getByLabelText('Larger'))
    expect(label(1).font_size).toBe(25)
    expect(label(2).font_size).toBe(25)
    expect(state().undo).toHaveLength(2)
    fireEvent.click(screen.getByLabelText('Smaller'))
    fireEvent.click(screen.getByLabelText('Smaller'))
    expect(label(1).font_size).toBe(23)
  })

  it('a mixed selection shows a blank size and "mixed" selects', () => {
    state().updateLabels([1], { font_size: 40, leader: 'on' })
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    expect(size().value).toBe('')
    expect((screen.getByLabelText('Leader') as HTMLSelectElement).value).toBe('mixed')
    fireEvent.change(screen.getByLabelText('Leader'), { target: { value: 'off' } })
    expect(label(1).leader).toBe('off')
    expect(label(2).leader).toBe('off')
  })

  it('aliases and colour commit one entry each', () => {
    render(<LabelToolbar box={box} />)
    fireEvent.change(screen.getByLabelText('Aliases'), { target: { value: 'on' } })
    expect(label(1).show_aliases).toBe(true)
    fireEvent.change(screen.getByLabelText('Aliases'), { target: { value: 'inherit' } })
    expect(label(1).show_aliases).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Text colour/ }))
    fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: 'ff8800' } })
    expect(label(1).color).toBe('#ff8800')
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
    expect(label(1).color).toBeNull()
  })

  it('pin toggles the whole selection; reset unpins and moves; clear overrides clears', () => {
    state().moveLabel(1, 5, 5) // pinned now
    state().toggleSelect(2)
    render(<LabelToolbar box={box} />)
    const pin = screen.getByRole('button', { name: 'Pin (mixed)' })
    fireEvent.click(pin)
    expect(label(1).pinned && label(2).pinned).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    expect(label(1).pinned || label(2).pinned).toBe(false)

    state().updateLabels([1], { font_size: 40, color: '#123456', text_override: 'X', leader: 'on', show_aliases: false, pinned: true })
    fireEvent.click(screen.getByRole('button', { name: 'Clear overrides' }))
    expect(label(1)).toMatchObject({ font_size: null, color: null, text_override: null, leader: 'auto', show_aliases: null, pinned: true })
  })

  it('is disabled while a solve is running', () => {
    state().load({ ...makeDoc(), image: { ...makeDoc().image, solve_status: 'solving' } })
    state().select(1)
    const { container } = render(<LabelToolbar box={box} />)
    expect(container.querySelector('.label-toolbar')).toBeNull()
  })
})
```

(`resetPositions` needs a canvas measurer, so the reset button is covered by the Playwright spec in Task 8, not here.)

- [ ] **Step 2: Run to see it fail**

Run: `cd frontend && npx vitest run src/editor/LabelToolbar.test.tsx`
Expected: module not found.

- [ ] **Step 3: Implement**

`frontend/src/editor/LabelToolbar.tsx`:

```tsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Label, LeaderMode } from '../api'
import ColorField from '../style/ColorField'
import { isEditable, resetPositions } from './editing'
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type Box } from './metrics'
import { useEditor } from './store'
import { toScreen } from './view'

const MARGIN = 8
const MIXED = 'mixed'

/** One value when every selected label agrees, MIXED otherwise. */
function common<T>(labels: Label[], pick: (l: Label) => T): T | typeof MIXED {
  const first = pick(labels[0]!)
  return labels.every((l) => pick(l) === first) ? first : MIXED
}

/** The floating per-label toolbar (SPEC § 6.2, design § A): an HTML overlay above the selection's
 *  union box, positioned through the view transform and kept inside the canvas. Every control
 *  applies to every selected label and commits one history entry per interaction; a control whose
 *  values differ shows blank (the stepper) or "mixed" (the selects). The buttons never take the
 *  focus (`onMouseDown` preventDefault), so the canvas shortcuts keep working after a click. */
export default function LabelToolbar({ box }: { box: Box }) {
  const selectedIds = useEditor((s) => s.selectedIds)
  const labels = useEditor((s) => s.labels)
  const style = useEditor((s) => s.style)
  const view = useEditor((s) => s.view)
  const viewport = useEditor((s) => s.viewport)
  const editable = useEditor(isEditable)

  const selected = useMemo(
    () => [...selectedIds].map((id) => labels.get(id)).filter((l): l is Label => l !== undefined && l.enabled),
    [selectedIds, labels],
  )

  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width !== size.w || rect.height !== size.h) setSize({ w: rect.width, h: rect.height })
  })

  // The size field is a draft: committed on Enter or blur, reverted on an invalid value. It
  // follows the selection: a new selection (or an undo) shows the stored value again.
  const fontSize = selected.length > 0 ? common(selected, (l) => l.font_size) : MIXED
  const shownSize = fontSize === MIXED || fontSize === null ? '' : String(fontSize)
  const [draft, setDraft] = useState(shownSize)
  useEffect(() => setDraft(shownSize), [shownSize, selectedIds])

  if (!style || !editable || selected.length === 0) return null

  const ids = selected.map((l) => l.object_id)
  const update = useEditor.getState().updateLabels

  const commitSize = () => {
    const text = draft.trim()
    if (text === '') {
      update(ids, { font_size: null })
      return
    }
    const n = Number(text)
    if (!Number.isInteger(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) {
      setDraft(shownSize)
      return
    }
    update(ids, { font_size: n })
  }
  const step = (delta: number) => {
    const s = useEditor.getState()
    // One commit for the set: each label steps from its own effective size.
    const updated = selected.map((l) => ({
      ...l,
      font_size: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, (l.font_size ?? s.style!.font_size) + delta)),
    }))
    s.applyLabels(updated)
  }

  const color = common(selected, (l) => l.color)
  const aliases = common(selected, (l) => l.show_aliases)
  const leader = common(selected, (l) => l.leader)
  const pinned = common(selected, (l) => l.pinned)
  const pinLabel = pinned === MIXED ? 'Pin (mixed)' : pinned ? 'Pinned' : 'Pin'

  // Above the union box, inside the canvas; below it when there is no room above.
  const topLeft = toScreen(view, box.left, box.top)
  const bottomRight = toScreen(view, box.right, box.bottom)
  let top = topLeft.y - size.h - MARGIN
  if (top < MARGIN) top = Math.min(bottomRight.y + MARGIN, Math.max(MARGIN, viewport.h - size.h - MARGIN))
  const left = Math.max(MARGIN, Math.min(topLeft.x, viewport.w - size.w - MARGIN))
  const noFocus = (e: React.MouseEvent) => e.preventDefault()

  return (
    <div ref={ref} className="label-toolbar" role="toolbar" aria-label="Selected labels" style={{ left, top }}>
      <button type="button" className="secondary" aria-label="Smaller" onMouseDown={noFocus} onClick={() => step(-1)}>
        −
      </button>
      <input
        type="number"
        aria-label="Font size"
        min={MIN_FONT_SIZE}
        max={MAX_FONT_SIZE}
        placeholder={String(style.font_size)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitSize}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitSize()
            e.currentTarget.blur()
          }
        }}
      />
      <button type="button" className="secondary" aria-label="Larger" onMouseDown={noFocus} onClick={() => step(1)}>
        +
      </button>
      <ColorField
        label="Text colour"
        value={color === MIXED ? '' : (color ?? '')}
        fallback={style.text_color}
        onChange={() => {}}
        onCommit={(hex) => {
          if (hex !== undefined) update(ids, { color: hex })
        }}
        onClear={() => update(ids, { color: null })}
      />
      <select
        aria-label="Aliases"
        value={aliases === MIXED ? MIXED : aliases === null ? 'inherit' : aliases ? 'on' : 'off'}
        onChange={(e) => {
          const v = e.target.value
          update(ids, { show_aliases: v === 'inherit' ? null : v === 'on' })
        }}
      >
        {aliases === MIXED && (
          <option value={MIXED} disabled>
            Aliases: mixed
          </option>
        )}
        <option value="inherit">Aliases: inherit</option>
        <option value="on">Aliases: on</option>
        <option value="off">Aliases: off</option>
      </select>
      <select
        aria-label="Leader"
        value={leader}
        onChange={(e) => update(ids, { leader: e.target.value as LeaderMode })}
      >
        {leader === MIXED && (
          <option value={MIXED} disabled>
            Leader: mixed
          </option>
        )}
        <option value="auto">Leader: auto</option>
        <option value="on">Leader: on</option>
        <option value="off">Leader: off</option>
      </select>
      <button
        type="button"
        className="secondary"
        aria-pressed={pinned === true}
        title="A pinned label keeps its place when the layout is auto-arranged"
        onMouseDown={noFocus}
        onClick={() => update(ids, { pinned: pinned !== true })}
      >
        {pinLabel}
      </button>
      <button
        type="button"
        className="secondary"
        title="Place again with the placer and unpin"
        onMouseDown={noFocus}
        onClick={() => resetPositions(ids)}
      >
        Reset position
      </button>
      <button
        type="button"
        className="secondary"
        title="Back to the global size, colour, aliases, leader and name"
        onMouseDown={noFocus}
        onClick={() => update(ids, { font_size: null, color: null, show_aliases: null, leader: 'auto', text_override: null })}
      >
        Clear overrides
      </button>
    </div>
  )
}
```

Two details the code above depends on:

1. **`ColorField` needs an `onClear`.** Today "Use default" calls `onChange('')` then `closePicker(true)` → `onCommit()` with no hex, which the toolbar cannot tell from a plain close. Add an optional prop to `frontend/src/style/ColorField.tsx`:

```ts
  /** "Use default" was clicked (allowDefault only). Without it the caller sees `onChange('')`
   *  followed by a bare `onCommit()`, which a stateless caller cannot tell from a plain close. */
  onClear?: () => void
```

and in the "Use default" button's `onClick`: `onChange(''); onClear?.(); closePicker(true)`. Because `closePicker` then calls `onCommit()` with no hex and the toolbar's `onCommit` ignores a bare call, the clear commits exactly once. A picker *drag* in the toolbar changes the draft only (`onChange` is a no-op here), and the popover close carries no hex, so a drag alone commits nothing — a typed hex does. This is deliberate: without a draft to hand back on close, the toolbar commits only what it can name. Document that in a one-line comment above the `ColorField` in the toolbar. `StyleForm`/`ConfigPage` are unchanged (the prop is optional). Add one assertion to `frontend/src/style/ColorField.test.tsx`: clicking "Use default" calls `onClear` once (look at how that file renders the field and add a `vi.fn()` prop).

2. **`React.MouseEvent`**: import `type MouseEvent` from `react` and write `(e: MouseEvent) => e.preventDefault()`.

The `step` helper uses `applyLabels` (one commit) rather than a per-label `updateLabels` loop, because each label steps from its own effective size.

CSS, append to `frontend/src/styles.css`:

```css
/* The floating per-label toolbar (LabelToolbar.tsx): placed by the component, never wraps. */
.label-toolbar { position: absolute; z-index: 6; display: flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0.4rem; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); white-space: nowrap; }
.label-toolbar button, .label-toolbar select, .label-toolbar input { font-size: 0.8rem; padding: 0.2rem 0.45rem; }
.label-toolbar input[type='number'] { width: 4.5rem; }
.label-toolbar .color-field { display: flex; align-items: center; gap: 0.3rem; }
.label-toolbar .color-field .field-label { display: none; }
.label-toolbar .swatch { width: auto; padding: 0.2rem 0.4rem; }
.label-toolbar .swatch-chip { width: 1rem; height: 1rem; }
```

- [ ] **Step 4: Mount it in the canvas**

In `EditorCanvas.tsx`, the union box of the selection:

```ts
  const selectionBox = useMemo<Box | null>(() => {
    if (selectedEntries.length === 0) return null
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
    for (const { label, box } of selectedEntries) {
      left = Math.min(left, label.x)
      top = Math.min(top, label.y)
      right = Math.max(right, label.x + box.width)
      bottom = Math.max(bottom, label.y + box.height)
    }
    return { left, top, right, bottom }
  }, [selectedEntries])
```

(import `type Box` from `./metrics`; write the four `let`s on separate lines if eslint's `one-var` complains). Inside the container, before the text editor:

```tsx
        {selectionBox && editingId === null && <LabelToolbar box={selectionBox} />}
```

Import `LabelToolbar from './LabelToolbar'`. The toolbar is hidden while the text editor is open so the two overlays never stack.

A mousedown inside the toolbar must not reach the stage: it is an HTML sibling of the Konva container, so Konva never sees it; nothing to do.

- [ ] **Step 5: Verify, commit**

Run: `cd frontend && npx vitest run && npm run lint --silent`
Expected: green and clean.

```bash
git add frontend/src/editor/LabelToolbar.tsx frontend/src/editor/LabelToolbar.test.tsx frontend/src/editor/EditorCanvas.tsx frontend/src/style/ColorField.tsx frontend/src/style/ColorField.test.tsx frontend/src/styles.css
git commit -m "feat: floating per-label toolbar"
```

---

### Task 7: Layout tab — Reset positions sends `reset`, and says what pins do

**Files:**
- Modify: `frontend/src/editor/LayoutTab.tsx`
- Test: none new (the tab has no jsdom test; `labels.spec.ts` in Task 8 checks the stored `pinned` after a reset).

- [ ] **Step 1: The request**

In `arrange(what)`, replace the `api.autoarrange` call:

```ts
      const res = await api.autoarrange(imageId, documentForSave(useEditor.getState()), what === 'reset')
```

Replace the comment block above `const reset = () => {` with:

```ts
  // Reset positions discards every pin (design § A): the server unpins first and places all
  // enabled labels; Auto-arrange keeps pinned labels where they are and places the rest around
  // them. The confirmation is in the page, like the card's Delete, not a browser dialog (SPEC § 5.2).
```

Replace the `field-note` paragraph and the confirmation question:

```tsx
      <p className="field-note">
        Auto-arrange places every enabled label from scratch, except pinned ones (a label you have
        dragged, or pinned from its toolbar), which stay put and are placed around. Reset positions
        unpins everything first.
      </p>
```

```tsx
            question="Unpin every label and place every enabled label from scratch?"
```

- [ ] **Step 2: Verify, commit**

Run: `cd frontend && npm run lint --silent && npx vitest run`

```bash
git add frontend/src/editor/LayoutTab.tsx
git commit -m "feat: Reset positions unpins every label first"
```

---

### Task 8: Playwright — parity with overrides, and the per-label interactions

**Files:**
- Modify: `frontend/e2e/parity.spec.ts` (extract the pixel diff into a helper, add a second document)
- Create: `frontend/e2e/labels.spec.ts`
- Modify: `frontend/e2e/helpers.ts` (`putAnnotations`, `exportImage`)

**Interfaces:**
- Produces (`helpers.ts`):
  - `putAnnotations(page, imageId, doc: AnnotationsUpdate): Promise<Annotations>` — PUT through the page's cookies, asserts 200.
  - `exportImage(page, imageId): Promise<string>` — `POST /api/images/{id}/export` with `{}`, asserts 200, returns `annotated_preview_url` made absolute with `new URL(url, page.url()).href`.
- The stored fallback-font case the design spec lists for this diff cannot be built through the API (`PUT` refuses a font that is not bundled with a 422, and the e2e app runs on a scratch data dir the spec cannot write to); the server side of that fallback is pinned by `backend/tests/test_render.py`/`test_fonts.py` from PR 3. Say so in a comment in the spec.

- [ ] **Step 1: Helpers**

Append to `frontend/e2e/helpers.ts` (import `AnnotationsUpdate` and `ExportOut` from `../src/api`):

```ts
/** Stores `doc` as the image's annotations through the signed-in page's cookies. */
export async function putAnnotations(page: Page, imageId: string, doc: AnnotationsUpdate): Promise<Annotations> {
  const res = await page.request.put(`/api/images/${imageId}/annotations`, { data: doc })
  expect(res.status(), `PUT annotations: ${await res.text()}`).toBe(200)
  return (await res.json()) as Annotations
}

/** Exports the image (default quality and scale) and returns the annotated preview's absolute URL. */
export async function exportImage(page: Page, imageId: string): Promise<string> {
  const res = await page.request.post(`/api/images/${imageId}/export`, { data: {} })
  expect(res.status(), `POST export: ${await res.text()}`).toBe(200)
  const out = (await res.json()) as ExportOut
  return new URL(out.annotated_preview_url, page.url()).href
}
```

- [ ] **Step 2: Parity — extract and extend**

In `frontend/e2e/parity.spec.ts`, move the body of the second test from `const result = await page.evaluate(` through the final `expect(result.fraction …)` into:

```ts
/** Renders the mounted stage at the preview's scale and diffs it against `previewUrl`; attaches
 *  the diff and the stage PNG when the budget is blown. The editor must be open with the hook
 *  published. */
async function expectStageMatchesPreview(page: Page, previewUrl: string, testInfo: TestInfo, tag: string): Promise<void> {
  const result = await page.evaluate(/* unchanged body */)
  console.log(`[parity ${tag}] pixels: …`) // the existing line, with the tag
  if (result.fraction > PIXEL_FRACTION) { /* unchanged attach block, file names `${tag}-diff.png` / `${tag}-stage.png` */ }
  expect(result.fraction, `${tag}: ${result.differing} of ${result.w * result.h} pixels differ by more than ${PIXEL_THRESHOLD}`).toBeLessThanOrEqual(PIXEL_FRACTION)
}
```

(import `type Page, type TestInfo` from `@playwright/test`). The existing test calls `await expectStageMatchesPreview(page, previewUrl, testInfo, 'plain')`. Then add:

```ts
test('the stage matches the preview for a document with per-label overrides and a pinned label', async ({ page }, testInfo) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)
  const imageId = /\/images\/([^/?#]+)/.exec(page.url())?.[1]
  expect(imageId).toBeTruthy()
  const original = await fetchAnnotations(page, imageId!)
  const enabled = original.labels.filter((l) => l.enabled)
  expect(enabled.length).toBeGreaterThanOrEqual(3)
  const [a, b, c] = enabled as [Label, Label, Label]
  // A size and colour override, a text override with the alias line forced on, a pinned label
  // with its leader forced on. (A stored font that is no longer bundled cannot be created
  // through the API — PUT refuses it — so that half of the fallback is pinned by pytest alone.)
  const overridden: AnnotationsUpdate = {
    style: original.style,
    version: original.version,
    labels: original.labels.map((l) => {
      if (l.object_id === a.object_id) return { ...l, font_size: original.style.font_size * 2, color: '#ff8800' }
      if (l.object_id === b.object_id) return { ...l, text_override: 'Overridden name', show_aliases: true }
      if (l.object_id === c.object_id) return { ...l, pinned: true, leader: 'on', x: l.x + 60, y: l.y + 40 }
      return l
    }),
  }
  const stored = await putAnnotations(page, imageId!, overridden)
  const previewUrl = await exportImage(page, imageId!)
  // Reload so the editor draws the stored document, then diff.
  await page.reload()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelCount !== undefined)
  await expectStageMatchesPreview(page, previewUrl, testInfo, 'overrides')

  // Put the shared fixture image back the way it was (and re-export it) so the other specs, and
  // a re-run on the same data dir, compare against a matching export.
  await putAnnotations(page, imageId!, { style: original.style, labels: original.labels, version: stored.version })
  await exportImage(page, imageId!)
})
```

Imports: `type AnnotationsUpdate, type Label` from `../src/api`; `fetchAnnotations, putAnnotations, exportImage` from `./helpers`.

- [ ] **Step 3: `labels.spec.ts`**

```ts
import { expect, test } from './fixtures'
import { ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations } from './helpers'

// Per-label editing (SPEC § 6.2, milestone 4 PR 4): click / shift-click selection with the
// floating toolbar, wheel-to-resize while the button is held, double-click text edit, pinning
// by drag and unpinning by Reset position. Every change is checked in the stored document.

/** Screen coordinates (page space) a few px inside the top-left of the n-th drawn label. */
async function labelPoint(page: import('@playwright/test').Page, n: number) {
  const canvasBox = await page.locator('.editor-canvas').boundingBox()
  expect(canvasBox).toBeTruthy()
  const at = await page.evaluate((i) => {
    const hook = window.__astrocaptionEditor!
    const l = hook.labelPositions()[i]!
    const { stage } = hook
    const scale = stage.scaleX()
    return { id: l.id, x: stage.x() + l.x * scale + 6, y: stage.y() + l.y * scale + 6, wx: l.x, wy: l.y }
  }, n)
  return { ...at, x: canvasBox!.x + at.x, y: canvasBox!.y + at.y }
}

test('toolbar, wheel, double-click and pins edit the selected labels', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const imageId = /\/images\/([^/?#]+)/.exec(page.url())?.[1]
  expect(imageId).toBeTruthy()
  const storedLabel = async (id: number) => (await fetchAnnotations(page, imageId!)).labels.find((l) => l.object_id === id)!
  const selected = () => page.evaluate(() => window.__astrocaptionEditor!.selectedIds())

  // Click selects one; the toolbar appears above it.
  const first = await labelPoint(page, 0)
  await page.mouse.click(first.x, first.y)
  await expect.poll(selected).toEqual([first.id])
  const toolbar = page.getByRole('toolbar', { name: 'Selected labels' })
  await expect(toolbar).toBeVisible()

  // Font size from the toolbar, autosaved.
  const size = toolbar.getByLabel('Font size')
  await size.fill('31')
  await size.press('Enter')
  await expect.poll(async () => (await storedLabel(first.id)).font_size, { timeout: 5_000 }).toBe(31)

  // Wheel with the button held: one notch up = +1, committed on release.
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  await page.mouse.wheel(0, -100)
  await page.mouse.up()
  await expect.poll(async () => (await storedLabel(first.id)).font_size, { timeout: 5_000 }).toBe(32)

  // Double-click: inline text edit, Enter commits.
  await page.mouse.dblclick(first.x, first.y)
  const editor = page.getByRole('textbox', { name: 'Label text' })
  await expect(editor).toBeVisible()
  await editor.fill('Renamed by test')
  await editor.press('Enter')
  await expect.poll(async () => (await storedLabel(first.id)).text_override, { timeout: 5_000 }).toBe('Renamed by test')

  // Shift-click adds a second label; a mixed size shows blank; Clear overrides clears both.
  const second = await labelPoint(page, 1)
  await page.mouse.click(second.x, second.y, { modifiers: ['Shift'] })
  await expect.poll(async () => (await selected()).sort()).toEqual([first.id, second.id].sort())
  await expect(size).toHaveValue('')
  await toolbar.getByRole('button', { name: 'Clear overrides' }).click()
  await expect.poll(async () => (await storedLabel(first.id)).font_size, { timeout: 5_000 }).toBeNull()
  expect((await storedLabel(first.id)).text_override).toBeNull()

  // Escape clears the selection.
  await page.keyboard.press('Escape')
  await expect.poll(selected).toEqual([])

  // A drag pins; Reset position unpins and moves the label back to a placed slot.
  await page.mouse.click(first.x, first.y)
  await page.mouse.move(first.x, first.y)
  await page.mouse.down()
  await page.mouse.move(first.x + 40, first.y + 30, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await storedLabel(first.id)).pinned, { timeout: 5_000 }).toBe(true)
  await toolbar.getByRole('button', { name: 'Reset position' }).click()
  await expect.poll(async () => (await storedLabel(first.id)).pinned, { timeout: 5_000 }).toBe(false)
  await expect(page.locator('.save-status')).toHaveText('Saved')
})
```

Note the first click on a label after a drag: the label has moved, so `labelPoint(page, 0)` must be re-read before the next click if the test grows; the sequence above clicks the toolbar (fixed on screen) after the drag, not the label.

- [ ] **Step 4: Run the browser suite**

Run: `make e2e`
Expected: every spec green, including the two parity diffs (`[parity plain]`, `[parity overrides]`) and `labels.spec.ts`. If the wheel step fails because Konva started a drag on the press (the pointer did not move, so it should not), check `pressRef` is set in `onLabelPress` and that `onWheel` sees `e.evt.buttons === 1`.

- [ ] **Step 5: Lint the e2e project and commit**

Run: `cd frontend && npm run lint --silent` (covers `tsconfig.e2e.json`).

```bash
git add frontend/e2e/parity.spec.ts frontend/e2e/labels.spec.ts frontend/e2e/helpers.ts
git commit -m "test: parity with per-label overrides; per-label editing browser spec"
```

---

### Task 9: SPEC.md, full gates

**Files:**
- Modify: `docs/SPEC.md` § 6.1, § 6.2, § 6.3 (Layout), § 7, § 8

- [ ] **Step 1: § 6.1**

Replace the `Esc`/`Delete` line:

```
- Keyboard: `Esc` clears the selection, `Delete`/`Backspace` disable every selected label (one change), `F` fit to view, `1` 100 %.
```

- [ ] **Step 2: § 6.2**

Replace the four interaction bullets after "Left-drag" and the *M3 note* with:

```
- **Left-drag** a label: moves it — and every other selected label by the same amount, as one change. Snaps nothing; free placement. A dragged label is **pinned** (§ 6.3 Layout).
- **Mouse wheel while holding left button on a label**: changes that label's font size (± 1 px per notch, clamped 6–200 px in original-pixel units), shown live and committed as one change when the button is released. Wheel does *not* zoom during this.
- **Double-click** a label: edit its text inline (override name), in the label's font at its on-screen size. Enter or leaving the field commits the trimmed text; blank resets to the catalogue name; `Esc` cancels.
- **Click** selects one label; **shift-click** toggles a label in or out of the selection; clicking empty canvas or `Esc` clears it.
- The selection shows a floating toolbar above its bounding box, kept inside the canvas. Every control applies to every selected label and is one change (one undo entry): font size (stepper and field, 6–200, blank = the global size and blank when the selection is mixed), text colour (picker; "Use default" clears the override), aliases (inherit / on / off), leader (auto / on / off), Pin, Reset position (places the label again with the browser placer around every other enabled label and marker, and unpins it), Clear overrides (size, colour, aliases, leader and text). Selects read "mixed" when the selected labels differ.
```

- [ ] **Step 3: § 6.3 Layout**

Replace item 3's text from `"Auto-arrange" button:` up to `Neither touches` with:

```
3. **Layout** — "Auto-arrange" button: flushes any pending save, then runs the collision-avoidance placer on every enabled label that is not pinned (same algorithm as the initial placement); pinned labels (dragged, or pinned from the toolbar) stay where they are and the others are placed around them. "Reset positions" asks for confirmation, unpins every label, then places all of them. Neither touches
```

- [ ] **Step 4: § 7 and § 8**

§ 7 `labels` line:

```
  labels        json  [{object_id, enabled, x, y, font_size?, text_override?, color?, show_aliases?, leader: auto|on|off, collided, pinned}]
```

§ 8 autoarrange bullet:

```
- `POST /images/{id}/autoarrange` {…document…, reset: bool = false} → the same document with every enabled, unpinned label re-placed by the placer (§ 6.4; pinned labels are fixed obstacles), same version, not stored; `reset: true` unpins every label first. The editor applies it and autosaves. Validated like `PUT`, including the version check (409). `reset` is refused by `PUT`.
```

- [ ] **Step 5: Full gates**

Run: `make lint test`
Expected: clean and green (pytest + vitest). `make e2e` already passed in Task 8; re-run it if anything in `frontend/src` changed since.

- [ ] **Step 6: Commit**

```bash
git add docs/SPEC.md
git commit -m "docs: per-label editing and pinned labels in SPEC § 6, § 7, § 8"
```

---

## Self-review

- **Spec coverage.** Selection set, shift-click, Esc/empty-canvas clear, group drag with one commit, Delete on every selected label (Tasks 2–3). Toolbar with the seven controls, mixed handling, one commit per interaction (Task 6). Wheel ±1 clamped, live, committed on release, no zoom (Task 3). Double-click inline editor with Enter/blank/Esc (Task 5). `Label.pinned`, set by drag-end, cleared by Reset position and Reset positions, server `autoarrange` keep/reset (Tasks 1, 4, 7). Parity spec additions (Task 8; the fallback-font half is documented as out of reach through the API). SPEC.md (Task 9). Not in this PR by the spec's PR order: leader avoidance, Objects tab kinds, notices.
- **Placeholders.** None: every step carries its code. The parity helper extraction says "unchanged body" for the pixel-diff `evaluate`, which is the existing code moved verbatim.
- **Type consistency.** `updateLabels(ids, patch, commit?)`, `commitPreview()`, `toggleSelect(id)`, `select(id | null)`, `selectedIds: ReadonlySet<number>` are used with those names in Tasks 3, 5, 6, 8. `resetPositions(ids, measure?)` in Tasks 4, 6, 8. `LabelToolbar({ box })`, `LabelTextEditor({ id, x, y, width, fontSize, onClose })` match their mounts. `api.autoarrange(id, doc, reset)` matches Task 7. `EditorTestHook.selectedIds()` matches `labels.spec.ts`.
