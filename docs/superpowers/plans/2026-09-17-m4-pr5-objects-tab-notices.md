# Milestone 4 PR 5: Objects Tab and Notices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Objects tab filters by OpenNGC kind (galaxy / nebula / cluster / star / other) with the HD toggle, shows names under the live name preference, re-renders one row at a time, works from the keyboard, keeps its state across tab switches, and every editor failure notice names a next step.

**Architecture:** The server reads OpenNGC's Type column into a `kinds` map inside `catalog/names.json` and exposes `ObjectOut.kind` at read time (no migration). The Objects tab drops nova's type chips for kind chips, ranks names client-side with `names.ts` (#94), and splits into a memoised `ObjectRow` with per-row store selectors. `SidePanel` gets a roving-tabindex tablist and keeps visited tab bodies mounted behind `hidden`. Notice sentences move into a pure `notices.ts` so they are unit-tested without Konva; the save path maps a validation 4xx onto the existing conflict state (Reload, not Retry).

**Tech Stack:** FastAPI + pydantic + pytest; React 19 + TypeScript strict + Zustand + react-konva; vitest (+ jsdom for component tests); Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-milestone-4-styling-design.md` § C "Objects tab" and "Notices", "Data model and API changes" (`ObjectOut.kind`); PR order item 5. Issues #75 (rest), #76, #77, #94. SPEC.md § 6.3 (Objects), § 8 (`GET /images/{id}/objects`).

## Global Constraints

- Preview and export must produce the same layout. This PR changes no geometry, metrics or renderer code, and no render/placement/names vectors. If any contract test fails after `make names-catalog` (OpenNGC upstream changed an alias group), regenerate with `make names-vectors` and report the diff in the handoff rather than hand-editing a fixture.
- Annotation geometry is stored in original image pixels; nothing here converts coordinates.
- Every document mutation goes through `changedDoc` (the editable gate); this PR adds none.
- `ObjectOut.kind: Literal["galaxy","nebula","cluster","star","other"]` is computed at read time: `star` for nova `bright`/`hd` rows, the catalogue kind for rows whose name OpenNGC knows, else `other`. No migration.
- OpenNGC Type → kind: galaxy (`G`, `GPair`, `GTrpl`, `GGroup`), nebula (`Neb`, `EmN`, `RfN`, `HII`, `PN`, `SNR`, `DrkN`), cluster (`OCl`, `GCl`); `Cl+N` (a cluster with nebulosity: M 42, the Cocoon, the Running Man) counts as nebula, since that is what the photographer is looking for, other (everything else, including `*`, `**`, `*Ass`, `Nova`, `NonEx`). `names.json` becomes `{"aliases": [...], "kinds": {...}}`; the `kinds` map stores only galaxy/nebula/cluster entries (a missing key is `other`).
- The "HD stars" toggle stays unchecked by default (#37) and gates `hd` rows inside `star`.
- Notice sentences, verbatim: "The editor could not size its canvas. Reload the page, or widen the window." / "Your session has expired. Log in again." / "The preview could not be loaded. Reload the page; if it keeps failing, re-upload the image." / "This image's objects changed; reload the editor." Label draw errors: count them, name the first object, say "The export may differ from this preview."
- API responses and the page never carry raw exception text; pydantic models for every response. No new dependencies.
- Settled UI patterns: buttons that never need the focus use `onMouseDown={(e) => e.preventDefault()}` (canvas shortcuts stay alive); `secondary` class for non-primary actions; chips use `aria-pressed`.
- Component tests are `*.test.tsx` next to the component with `// @vitest-environment jsdom` on line 1, Testing Library, assertions on the store or the DOM.
- Conventional one-line commit subjects; end every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Never run `npm ci`/`npm install`/`make install FORCE=1`; never touch `data/`; never restart the dev unit; never start `make dev` by hand. `make lint test` and `make e2e` are the gates. One vitest file: `cd frontend && npx vitest run src/editor/objectsFilter.test.ts`; one pytest file: `cd backend && .venv/bin/pytest -q tests/test_objects.py`.
- Work on branch `feat/m4-pr5-objects-tab-notices` off `main`. Never push to `main`.

---

## File structure

| File | Responsibility after this PR |
|---|---|
| `backend/scripts/build_names_catalog.py` | `KIND_BY_TYPE`; `build()` returns `(groups, kinds)`; writes `{"aliases", "kinds"}` |
| `backend/app/catalog/__init__.py` | loads the new shape; `Kind`, `kind_for(names)` |
| `backend/app/catalog/names.json` | regenerated (`make names-catalog`) |
| `backend/app/models.py` | `ObjectKind`, `ObjectOut.kind` |
| `backend/app/api/images.py` | `_object_out` fills `kind` |
| `backend/tests/test_objects.py`, `test_build_names_catalog.py`, `test_api.py` | kind mapping, builder, API field |
| `frontend/src/api.ts` | `ObjectKind`, `ObjectOut.kind` |
| `frontend/src/editor/objectsFilter.ts` (+ `.test.ts`) | kind set + HD toggle filter |
| `frontend/src/editor/ObjectsTab.tsx` (+ `.test.tsx`) | kind chips, client-side names, memoised `ObjectRow` with per-row selectors, focus highlight |
| `frontend/src/editor/SidePanel.tsx` (+ `.test.tsx`) | roving-tabindex tablist, focusable panels, visited tab bodies kept mounted |
| `frontend/src/editor/notices.ts` (+ `.test.ts`) | notice sentences and the preview status probe |
| `frontend/src/editor/EditorCanvas.tsx` | tooltip name via `names.ts`, `not-allowed` cursor while solving, counted draw errors, preview 401 |
| `frontend/src/editor/autosave.ts` (+ `.test.ts`) | validation 4xx → conflict state with the stale-document sentence |
| `frontend/src/editor/placement.ts` (+ `.test.ts`), `editing.ts` | `placeNewLabel` throws instead of returning null |
| `frontend/src/editor/testDoc.ts`, `metrics.test.ts` | `ObjectOut` literals gain `kind` |
| `frontend/src/styles.css` | `.object-row:focus-within`, `.object-row.selected`, `.side-panel-body[hidden]` |
| `frontend/e2e/panel.spec.ts` | kind chips, tab keyboard, kept state, names follow the preference |
| `docs/SPEC.md` | § 6.3 Objects (M3 note gone), § 8 `kind` |

---

### Task 0: Branch

- [ ] **Step 1: Branch off main**

```bash
git checkout main && git pull && git checkout -b feat/m4-pr5-objects-tab-notices
```

---

### Task 1: Server — OpenNGC kinds in the catalogue and `ObjectOut.kind`

**Files:**
- Modify: `backend/scripts/build_names_catalog.py` (`build`, `main`, new `KIND_BY_TYPE`)
- Modify: `backend/app/catalog/__init__.py` (`_index`, new `_data`, `_kinds`, `Kind`, `kind_for`)
- Regenerate: `backend/app/catalog/names.json` (`make names-catalog`, network)
- Modify: `backend/app/models.py:498-505` (`ObjectOut`), new `ObjectKind` alias next to `NamePreference`
- Modify: `backend/app/api/images.py:335-344` (`_object_out`)
- Test: `backend/tests/test_build_names_catalog.py` (new), `backend/tests/test_objects.py`, `backend/tests/test_api.py:275-282`

**Interfaces:**
- Produces: `app.catalog.Kind = Literal["galaxy", "nebula", "cluster"]`; `app.catalog.kind_for(names: list[str]) -> Kind | None`; `app.models.ObjectKind = Literal["galaxy", "nebula", "cluster", "star", "other"]`; `ObjectOut.kind: ObjectKind`; `scripts.build_names_catalog.build(rows) -> tuple[list[list[str]], dict[str, str]]`.

- [ ] **Step 1: Write the failing builder test**

`backend/tests/test_build_names_catalog.py`:

```python
from __future__ import annotations

from scripts.build_names_catalog import KIND_BY_TYPE, build


def row(name: str, type_: str, **extra: str) -> dict[str, str]:
    base = {"Name": name, "Type": type_, "M": "", "NGC": "", "IC": "", "Identifiers": "", "Common names": ""}
    base.update(extra)
    return base


def test_build_maps_openngc_types_to_kinds_and_keeps_aliases() -> None:
    rows = [
        row("NGC1976", "HII", M="042", **{"Common names": "Orion Nebula"}),
        row("NGC0224", "G", M="031"),
        row("NGC1912", "OCl", M="038"),
        row("NGC2239", "Dup", NGC="2244"),  # OpenNGC duplicate: takes its target's kind
        row("NGC2244", "OCl", Identifiers="C 050"),
        row("NGC2017", "*Ass"),  # a star association: no kind entry, so the API says "other"
        row("B033", "DrkN", **{"Common names": "Horsehead Nebula"}),
    ]
    groups, kinds = build(rows)
    assert ["NGC 1976", "M 42", "Orion Nebula"] in groups
    assert kinds == {
        "NGC 1976": "nebula",
        "NGC 224": "galaxy",
        "NGC 1912": "cluster",
        "NGC 2239": "cluster",
        "NGC 2244": "cluster",
        "B 33": "nebula",
    }


def test_kind_table_covers_the_spec_buckets() -> None:
    assert {t for t, k in KIND_BY_TYPE.items() if k == "galaxy"} == {"G", "GPair", "GTrpl", "GGroup"}
    assert {t for t, k in KIND_BY_TYPE.items() if k == "nebula"} == {"Neb", "EmN", "RfN", "HII", "PN", "SNR", "DrkN"}
    assert {t for t, k in KIND_BY_TYPE.items() if k == "cluster"} == {"OCl", "GCl", "Cl+N"}
    for other in ("*", "**", "*Ass", "Nova", "NonEx", "Dup", "Other"):
        assert other not in KIND_BY_TYPE
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_names_catalog.py`
Expected: FAIL, `ImportError: cannot import name 'KIND_BY_TYPE'`.

- [ ] **Step 3: Change the builder**

In `backend/scripts/build_names_catalog.py`, after `NAME_RE`:

```python
# OpenNGC's Type column folded into the editor's four buckets (spec § C "Objects tab"). Types not
# listed (stars, associations, novae, non-existent and duplicate entries) get no entry: the API
# reports them as "other".
KIND_BY_TYPE: dict[str, str] = {
    "G": "galaxy",
    "GPair": "galaxy",
    "GTrpl": "galaxy",
    "GGroup": "galaxy",
    "Neb": "nebula",
    "EmN": "nebula",
    "RfN": "nebula",
    "HII": "nebula",
    "PN": "nebula",
    "SNR": "nebula",
    "DrkN": "nebula",
    "OCl": "cluster",
    "GCl": "cluster",
    "Cl+N": "cluster",
}
```

Change `build` to return both tables. Its signature becomes
`def build(rows: list[dict[str, str]]) -> tuple[list[list[str]], dict[str, str]]:`; add `kinds: dict[str, str] = {}` next to `groups`; inside the loop, right after the `canonical`/`extra` block (before `names: list[str] = ...`), add:

```python
        kind = KIND_BY_TYPE.get(canonical["Type"])
        if kind is not None:
            kinds[pretty(row["Name"])] = kind
```

and end with `return groups, kinds`. Update the module docstring's last sentence: "…and writes `{"aliases": [...], "kinds": {...}}`: name groups such as `["NGC 1976", "M 42", …]` for every object with an alias worth showing, and the kind (galaxy / nebula / cluster) of every object whose OpenNGC type has one."

In `main`:

```python
    groups, kinds = build(load_rows(source))
    payload = {"aliases": groups, "kinds": kinds}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name}: {len(groups)} groups, {len(kinds)} kinds, {OUT.stat().st_size // 1024} KB")
```

- [ ] **Step 4: Run the builder test**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_names_catalog.py`
Expected: PASS.

- [ ] **Step 5: Regenerate the catalogue**

Run: `make names-catalog` (network). Then `git diff --stat backend/app/catalog/names.json` and `head -c 200 backend/app/catalog/names.json` — it must start with `{"aliases":[[`. Expect roughly 12,000 kind entries and a file of a few hundred KB.

- [ ] **Step 6: Write the failing catalog test**

Append to `backend/tests/test_objects.py` (add `kind_for` to the `from app.catalog import …` line):

```python
def test_kind_for_reads_openngc_types() -> None:
    assert kind_for(["NGC 1976", "M 42"]) == "nebula"
    assert kind_for(["ngc0224"]) == "galaxy"  # normalised like every other lookup
    assert kind_for(["NGC 1912"]) == "cluster"
    assert kind_for(["NGC 2239"]) == "cluster"  # OpenNGC 'Dup' of NGC 2244
    assert kind_for(["Hatysa"]) is None
    assert kind_for([]) is None
```

- [ ] **Step 7: Run it to see it fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_objects.py`
Expected: FAIL at import (`kind_for`), and `test_catalog_enrichment_and_normalisation` fails too because `_index` still reads the old list shape.

- [ ] **Step 8: Teach the catalogue module the new shape**

Replace `_index` in `backend/app/catalog/__init__.py` and add the kinds API:

```python
from typing import Any, Literal

Kind = Literal["galaxy", "nebula", "cluster"]


@lru_cache(maxsize=1)
def _data() -> dict[str, Any]:
    return json.loads(NAMES_FILE.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _index() -> dict[str, list[str]]:
    groups: list[list[str]] = _data()["aliases"]
    index: dict[str, list[str]] = {}
    for group in groups:
        for name in group:
            index.setdefault(normalise(name), group)
    return index


@lru_cache(maxsize=1)
def _kinds() -> dict[str, Kind]:
    out: dict[str, Kind] = {}
    for name, kind in _data()["kinds"].items():
        if kind == "galaxy" or kind == "nebula" or kind == "cluster":
            out[normalise(name)] = kind
    return out


def kind_for(names: list[str]) -> Kind | None:
    """OpenNGC's class of the object with these names: the first name the table knows, or None
    (a star, an association, or an object the table does not list)."""
    kinds = _kinds()
    for n in names:
        kind = kinds.get(normalise(n))
        if kind is not None:
            return kind
    return None
```

(The three-way `==` chain narrows the type for mypy without a cast.) Update the module docstring: "…generated from OpenNGC … by `scripts/build_names_catalog.py`, which also records each object's kind (galaxy / nebula / cluster) for the editor's Objects tab."

- [ ] **Step 9: Run the objects tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_objects.py`
Expected: PASS. If `test_catalog_enrichment_and_normalisation` fails on an alias list, OpenNGC upstream changed: report the exact assertion in the handoff and do not edit the fixture-derived expectations without saying so.

- [ ] **Step 10: Write the failing API test**

In `backend/tests/test_api.py`, in the test around line 275 that reads `objects = client.get(f"/api/images/{image_id}/objects").json()`, after the `primary_name` assertion add:

```python
    assert m42["kind"] == "nebula"
    assert {o["kind"] for o in objects if o["type"] == "bright"} == {"star"}
    assert {o["kind"] for o in objects} <= {"galaxy", "nebula", "cluster", "star", "other"}
```

- [ ] **Step 11: Run it to see it fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_api.py -k objects`
Expected: FAIL with `KeyError: 'kind'`.

- [ ] **Step 12: Add the field**

`backend/app/models.py`, next to `NamePreference`:

```python
ObjectKind = Literal["galaxy", "nebula", "cluster", "star", "other"]
```

and on `ObjectOut`, after `type: str`:

```python
    #: Objects-tab bucket, computed at read time: nova's ``bright``/``hd`` rows are ``star``, rows
    #: OpenNGC classifies take its kind, everything else is ``other``.
    kind: ObjectKind
```

`backend/app/api/images.py`: import `kind_for` from `..catalog` and `ObjectKind` from `..models`, then:

```python
def _object_out(o: SolveObject, preference: NamePreference) -> ObjectOut:
    kind: ObjectKind = "star" if o.type in ("bright", "hd") else (kind_for(o.catalog_names) or "other")
    return ObjectOut(
        id=o.id,
        catalog_names=o.catalog_names,
        primary_name=o.primary_name_for(preference),
        type=o.type,
        kind=kind,
        x=o.x,
        y=o.y,
        radius=o.radius,
    )
```

- [ ] **Step 13: Run the backend suite and lint**

Run: `cd backend && .venv/bin/pytest -q && cd .. && make lint-backend`
Expected: all PASS; ruff and mypy clean. (`test_names_vectors.py` and `test_render_parity.py` cover the regenerated aliases; a failure there means an upstream alias change — see Global Constraints.)

- [ ] **Step 14: Commit**

```bash
git add backend/scripts/build_names_catalog.py backend/app/catalog/__init__.py backend/app/catalog/names.json backend/app/models.py backend/app/api/images.py backend/tests/test_build_names_catalog.py backend/tests/test_objects.py backend/tests/test_api.py
git commit -m "feat: OpenNGC kinds in the names catalogue and ObjectOut.kind"
```

---

### Task 2: Frontend — kind filter with the HD toggle, names ranked client-side (#94)

**Files:**
- Modify: `frontend/src/api.ts:105-114` (`ObjectOut`, new `ObjectKind`)
- Modify: `frontend/src/editor/objectsFilter.ts` (rewrite), `frontend/src/editor/objectsFilter.test.ts`
- Modify: `frontend/src/editor/testDoc.ts:37-38,107`, `frontend/src/editor/metrics.test.ts` (every `ObjectOut` literal gains `kind`)
- Modify: `frontend/src/editor/ObjectsTab.tsx` (chips, name), `frontend/src/editor/EditorCanvas.tsx:808` (tooltip name)

**Interfaces:**
- Consumes: `ObjectOut.kind` from Task 1; `primaryName(names, preference)` from `names.ts`.
- Produces: `ObjectKind` type in `api.ts`; in `objectsFilter.ts`: `KINDS`, `KIND_LABELS`, `ObjectsFilter { kinds: ReadonlySet<ObjectKind>; hd: boolean }`, `DEFAULT_FILTER`, `isHd(o)`, `filterObjects(objects, query, filter)`.

- [ ] **Step 1: Add the type**

`frontend/src/api.ts`:

```ts
export type ObjectKind = 'galaxy' | 'nebula' | 'cluster' | 'star' | 'other'

/** A catalogued object. `primary_name` is the server's ranking under the preference stored at
 *  fetch time (used by the plain export page); the editor ranks `catalog_names` itself with
 *  `names.ts` so a Style-tab preference change updates every name at once (#94). `kind` is the
 *  Objects-tab bucket (nova `bright`/`hd` rows are `star`; OpenNGC classifies the rest). */
export interface ObjectOut {
  id: number
  catalog_names: string[]
  primary_name: string
  type: string
  kind: ObjectKind
  x: number
  y: number
  radius: number
}
```

Then add `kind` to every `ObjectOut` literal: `testDoc.ts` (`kind: 'nebula'` for M 42, `kind: 'star'` for Alnitak, `kind: 'other'` for the id-3 helper), `metrics.test.ts`, and `objectsFilter.test.ts` (rewritten in Step 2). Run `cd frontend && npx tsc --noEmit` and fix every literal it flags.

- [ ] **Step 2: Rewrite the filter test**

Replace `frontend/src/editor/objectsFilter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ObjectKind, ObjectOut } from '../api'
import { DEFAULT_FILTER, KINDS, filterObjects, isHd } from './objectsFilter'

/** The `nova-narrow` field (1° Pelican): 8 objects, five of them `hd` — the shape #37 is about. */
function narrowField(): ObjectOut[] {
  const rows: [number, string, string, ObjectKind][] = [
    [1, 'HD 198896', 'hd', 'star'],
    [2, 'HD 198639', 'hd', 'star'],
    [3, 'HD 198931', 'hd', 'star'],
    [4, 'HD 199081', 'hd', 'star'],
    [5, 'HD 199178', 'hd', 'star'],
    [6, '56 Cyg', 'bright', 'star'],
    [7, '57 Cyg', 'bright', 'star'],
    [8, 'IC 5070', 'ic', 'nebula'],
  ]
  return rows.map(([id, name, type, kind]) => ({
    id,
    catalog_names: [name],
    primary_name: name,
    type,
    kind,
    x: id * 10,
    y: id * 10,
    radius: kind === 'nebula' ? 903.19 : 0,
  }))
}

const names = (objects: ObjectOut[]) => objects.map((o) => o.primary_name)
const withHd = { ...DEFAULT_FILTER, hd: true }

describe('isHd', () => {
  it('is nova’s hd type, case-insensitively', () => {
    expect(isHd(narrowField()[0]!)).toBe(true)
    expect(isHd({ ...narrowField()[0]!, type: 'HD' })).toBe(true)
    expect(isHd(narrowField()[6]!)).toBe(false)
  })
})

describe('filterObjects', () => {
  it('shows every kind but hides the HD rows by default (#37)', () => {
    expect(DEFAULT_FILTER.hd).toBe(false)
    expect([...DEFAULT_FILTER.kinds]).toEqual(KINDS)
    expect(names(filterObjects(narrowField(), '', DEFAULT_FILTER))).toEqual(['56 Cyg', '57 Cyg', 'IC 5070'])
  })

  it('shows all eight once the HD toggle is on', () => {
    expect(filterObjects(narrowField(), '', withHd)).toHaveLength(8)
  })

  it('hides HD rows with the other stars when the star kind is off, whatever the toggle says', () => {
    const kinds = new Set<ObjectKind>(['nebula'])
    expect(names(filterObjects(narrowField(), '', { kinds, hd: true }))).toEqual(['IC 5070'])
  })

  it('searches case-insensitively within the shown kinds', () => {
    expect(names(filterObjects(narrowField(), 'cyg', DEFAULT_FILTER))).toEqual(['56 Cyg', '57 Cyg'])
  })

  it('matches a substring of the catalogue number', () => {
    expect(names(filterObjects(narrowField(), '198', withHd))).toEqual(['HD 198896', 'HD 198639', 'HD 198931'])
  })

  it('searches every catalogue name, not just the primary one', () => {
    const objects: ObjectOut[] = [
      { id: 1, catalog_names: ['NGC 1976', 'M 42'], primary_name: 'M 42', type: 'ngc', kind: 'nebula', x: 0, y: 0, radius: 40 },
    ]
    expect(filterObjects(objects, 'ngc 19', DEFAULT_FILTER)).toHaveLength(1)
  })

  it('ignores surrounding whitespace and keeps the input order', () => {
    expect(names(filterObjects(narrowField(), '  Cyg  ', DEFAULT_FILTER))).toEqual(['56 Cyg', '57 Cyg'])
  })

  it('shows nothing when every kind is off', () => {
    expect(filterObjects(narrowField(), '', { kinds: new Set(), hd: true })).toEqual([])
  })
})
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd frontend && npx vitest run src/editor/objectsFilter.test.ts`
Expected: FAIL (`DEFAULT_FILTER`, `KINDS`, `isHd` are not exported).

- [ ] **Step 4: Rewrite the filter module**

`frontend/src/editor/objectsFilter.ts`:

```ts
// The Objects tab's search and kind filter (SPEC § 6.3). Pure, so the filtering rules are tested
// without a DOM: the tab owns only the query string and the filter object.

import type { ObjectKind, ObjectOut } from '../api'

export const KINDS: readonly ObjectKind[] = ['galaxy', 'nebula', 'cluster', 'star', 'other']

export const KIND_LABELS: Record<ObjectKind, string> = {
  galaxy: 'Galaxies',
  nebula: 'Nebulae',
  cluster: 'Clusters',
  star: 'Stars',
  other: 'Other',
}

export interface ObjectsFilter {
  kinds: ReadonlySet<ObjectKind>
  /** Whether nova's `hd` rows show inside the `star` kind. Off to begin with (#37): a narrow
   *  field can return dozens of HD stars, most of them duplicates of a brighter row. The labels
   *  themselves are kept — only this list hides them. */
  hd: boolean
}

export const DEFAULT_FILTER: ObjectsFilter = { kinds: new Set<ObjectKind>(KINDS), hd: false }

export function isHd(o: ObjectOut): boolean {
  return o.type.toLowerCase() === 'hd'
}

/** The rows to show: objects whose kind is on (an `hd` row also needs the toggle) and whose *any*
 *  catalogue name contains `query` (case-insensitive substring — searching "198" has to find
 *  HD 198639 by its full name, not only by the primary name the preference picked). Input order
 *  is preserved. */
export function filterObjects(objects: ObjectOut[], query: string, filter: ObjectsFilter): ObjectOut[] {
  const q = query.trim().toLowerCase()
  return objects.filter(
    (o) =>
      filter.kinds.has(o.kind) &&
      (filter.hd || !isHd(o)) &&
      (q === '' || o.catalog_names.some((n) => n.toLowerCase().includes(q))),
  )
}
```

- [ ] **Step 5: Run the filter test**

Run: `cd frontend && npx vitest run src/editor/objectsFilter.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the tab and the tooltip**

`frontend/src/editor/ObjectsTab.tsx`: replace the chip imports and state with

```ts
import { primaryName } from './names'
import { DEFAULT_FILTER, KINDS, KIND_LABELS, filterObjects, type ObjectsFilter } from './objectsFilter'
…
  const preference = useEditor((s) => s.style?.name_preference ?? 'popular')
  const [filter, setFilter] = useState<ObjectsFilter>(DEFAULT_FILTER)
…
  const rows = useMemo(() => { … return filterObjects(all, query, filter) }, [objectOrder, objects, query, filter])

  const toggleKind = (kind: ObjectKind) =>
    setFilter((prev) => {
      const kinds = new Set(prev.kinds)
      if (!kinds.delete(kind)) kinds.add(kind)
      return { ...prev, kinds }
    })
  const toggleHd = () => setFilter((prev) => ({ ...prev, hd: !prev.hd }))
```

and the chip row becomes

```tsx
      <div className="chips">
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="chip"
            aria-pressed={filter.kinds.has(kind)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleKind(kind)}
          >
            {KIND_LABELS[kind]}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          aria-pressed={filter.hd}
          title="Nova's HD-catalogue rows, hidden by default: most duplicate a brighter star"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleHd}
        >
          HD stars
        </button>
      </div>
```

In the row: `const name = primaryName(obj.catalog_names, preference)`; the checkbox `aria-label={`Show ${name}`}`; the link button text `{name}`; the type column shows `{obj.kind}` instead of `{obj.type}` (import `ObjectKind` from `../api`). Update the component's header comment: "…the name is ranked here, not taken from the server, so a Style-tab preference change updates the list (#94)."

`frontend/src/editor/EditorCanvas.tsx:808`: `{primaryName(hovered.catalog_names, style.name_preference)}` (import `primaryName` from `./names`; `style` is non-null past the guard on line 709).

`frontend/src/editor/metrics.ts:74`: change the comment to "`obj.primary_name` is the server's ranking at fetch time, used by the plain export page only".

- [ ] **Step 7: Type-check, lint, run the editor suite**

Run: `cd frontend && npx tsc --noEmit && npx eslint src && npx vitest run src/editor`
Expected: clean and PASS. `smoke.spec.ts` relies on `.object-list input[type=checkbox]`, which is unchanged.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api.ts frontend/src/editor/objectsFilter.ts frontend/src/editor/objectsFilter.test.ts frontend/src/editor/ObjectsTab.tsx frontend/src/editor/EditorCanvas.tsx frontend/src/editor/metrics.ts frontend/src/editor/testDoc.ts frontend/src/editor/metrics.test.ts
git commit -m "feat: Objects tab filters by OpenNGC kind and ranks names client-side"
```

---

### Task 3: `ObjectRow` — memoised, per-row selectors, focus highlight (#75, #76)

**Files:**
- Modify: `frontend/src/editor/ObjectsTab.tsx`
- Modify: `frontend/src/styles.css:155-157`
- Test: `frontend/src/editor/ObjectsTab.test.tsx` (new)

**Interfaces:**
- Consumes: `primaryName`, `ObjectsFilter` from Task 2; store fields `labels`, `hoveredId`, `selectedIds`, actions `hover`, `panTo`, `setStyle`, `toggleObject`.
- Produces: `ObjectRow` (module-private, `memo`); CSS classes `.object-row.hovered`, `.object-row.selected`, `.object-row:focus-within`.

- [ ] **Step 1: Write the failing component test**

`frontend/src/editor/ObjectsTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectOut } from '../api'
import ObjectsTab from './ObjectsTab'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

const hd: ObjectOut = { id: 3, catalog_names: ['HD 37742'], primary_name: 'HD 37742', type: 'hd', kind: 'star', x: 1561, y: 1011, radius: 0 }

function load(extra: ObjectOut[] = []) {
  const doc = makeDoc()
  doc.objects.push(...extra)
  for (const o of extra) {
    doc.annotations.labels.push({ ...doc.annotations.labels[1]!, object_id: o.id, x: o.x, y: o.y })
  }
  useEditor.getState().load(doc)
}

beforeEach(() => load())
afterEach(() => {
  cleanup()
  useEditor.getState().reset()
})

const row = (name: string) => screen.getByRole('checkbox', { name: `Show ${name}` }).closest('li')!

describe('ObjectsTab', () => {
  it('lists the objects under the stored name preference and follows a Style-tab change (#94)', () => {
    render(<ObjectsTab />)
    expect(screen.getByRole('button', { name: 'M 42' })).toBeTruthy()
    act(() => useEditor.getState().setStyle({ name_preference: 'ngc_ic' }))
    expect(screen.getByRole('button', { name: 'NGC 1976' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'M 42' })).toBeNull()
  })

  it('hides hd rows until the HD toggle is on, and the star kind gates both', () => {
    load([hd])
    render(<ObjectsTab />)
    expect(screen.queryByRole('checkbox', { name: 'Show HD 37742' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'HD stars' }))
    expect(screen.getByRole('checkbox', { name: 'Show HD 37742' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stars' }))
    expect(screen.queryByRole('checkbox', { name: 'Show HD 37742' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Show Alnitak' })).toBeNull()
    expect(screen.getByText('1 of 3 objects')).toBeTruthy()
  })

  it('highlights a row and its marker on hover and on keyboard focus (#76)', () => {
    render(<ObjectsTab />)
    fireEvent.mouseEnter(row('M 42'))
    expect(useEditor.getState().hoveredId).toBe(1)
    fireEvent.mouseLeave(row('M 42'))
    expect(useEditor.getState().hoveredId).toBeNull()
    const box = screen.getByRole('checkbox', { name: 'Show Alnitak' })
    act(() => box.focus())
    expect(useEditor.getState().hoveredId).toBe(2)
    expect(row('Alnitak').className).toContain('hovered')
    act(() => box.blur())
    expect(useEditor.getState().hoveredId).toBeNull()
  })

  it('marks the selected label’s row', () => {
    render(<ObjectsTab />)
    act(() => useEditor.getState().select(1))
    expect(row('M 42').className).toContain('selected')
    expect(row('Alnitak').className).not.toContain('selected')
  })

  it('the checkbox disables an enabled label without touching the others', () => {
    render(<ObjectsTab />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show M 42' }))
    expect(useEditor.getState().labels.get(1)?.enabled).toBe(false)
    expect(useEditor.getState().labels.get(2)?.enabled).toBe(false)
  })
})
```

(`makeDoc` enables label 1 away from its object and leaves label 2 disabled; disabling needs no placement, so the test never touches the canvas measurer, which jsdom cannot provide.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/editor/ObjectsTab.test.tsx`
Expected: the focus and selected tests FAIL (no `onFocus`, no `selected` class); the others may pass already.

- [ ] **Step 3: Split out `ObjectRow`**

In `frontend/src/editor/ObjectsTab.tsx`, remove the `labels`, `hover`, `panTo` and `hoveredId` subscriptions from `ObjectsTab` (it keeps `objects`, `objectOrder`, `editable`, `preference`), and add above it:

```tsx
/** One row. Memoised with per-row selectors, so a drag frame or a marker hover re-renders the
 *  rows it concerns and not the whole list (#75). Keyboard focus inside the row highlights it and
 *  its marker exactly like hover (#76): `onFocus`/`onBlur` bubble in React, and the blur is
 *  ignored while the focus only moves between the row's own controls. */
const ObjectRow = memo(function ObjectRow({ obj, name, editable }: { obj: ObjectOut; name: string; editable: boolean }) {
  const id = obj.id
  const enabled = useEditor((s) => s.labels.get(id)?.enabled ?? false)
  const hasLabel = useEditor((s) => s.labels.has(id))
  const hovered = useEditor((s) => s.hoveredId === id)
  const selected = useEditor((s) => s.selectedIds.has(id))
  const hover = useEditor((s) => s.hover)
  const panTo = useEditor((s) => s.panTo)
  return (
    <li
      className={`object-row${hovered ? ' hovered' : ''}${selected ? ' selected' : ''}`}
      onMouseEnter={() => hover(id)}
      onMouseLeave={() => hover(null)}
      onFocus={() => hover(id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hover(null)
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        disabled={!editable || !hasLabel}
        aria-label={`Show ${name}`}
        onChange={() => toggleWithPlacement(id)}
      />
      <button
        type="button"
        className="link-button"
        title="Centre the view on this object"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => panTo(id)}
      >
        {name}
      </button>
      <span className="object-type">{obj.kind}</span>
      <span className="object-radius">{Math.round(obj.radius)} px</span>
    </li>
  )
})
```

and the list becomes

```tsx
      <ul className="object-list">
        {rows.map((obj) => (
          <ObjectRow key={obj.id} obj={obj} name={primaryName(obj.catalog_names, preference)} editable={editable} />
        ))}
      </ul>
```

Import `memo` from `react`. `bulk()` already reads the store through `enableWithPlacement`/`disableAll` (`getState()` at click time); it needs only `rows`, so leave it.

CSS, `frontend/src/styles.css`, replace line 156:

```css
.object-row:hover, .object-row:focus-within, .object-row.hovered { background: rgba(138, 180, 255, 0.12); }
.object-row.selected { box-shadow: inset 2px 0 0 var(--accent); }
```

- [ ] **Step 4: Run the component test, then the editor suite**

Run: `cd frontend && npx vitest run src/editor/ObjectsTab.test.tsx && npx vitest run src/editor && npx tsc --noEmit && npx eslint src`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/editor/ObjectsTab.tsx frontend/src/editor/ObjectsTab.test.tsx frontend/src/styles.css
git commit -m "feat: memoised Objects rows with per-row selectors and keyboard focus highlight"
```

---

### Task 4: Side panel — keyboard tablist, focusable panels, tab bodies kept mounted; `not-allowed` cursor while solving (#76)

**Files:**
- Modify: `frontend/src/editor/SidePanel.tsx`
- Modify: `frontend/src/styles.css:137`
- Modify: `frontend/src/editor/EditorCanvas.tsx:563-587` (`hitCircles`)
- Test: `frontend/src/editor/SidePanel.test.tsx` (new)

**Interfaces:**
- Consumes: `ObjectsTab`, `StyleTab`, `LayoutTab`, `ImageTab` unchanged; `api.imageDefaultStyle` and `loadBundledFont` mocked in the test as `StyleTab.test.tsx` does.
- Produces: tab ids `tab-<id>`, panel ids `panel-<id>`; tabs carry `aria-controls="panel-<id>"`, roving `tabIndex`; panels are `role="tabpanel"`, `tabIndex={0}`, `hidden` when not current.

- [ ] **Step 1: Write the failing test**

`frontend/src/editor/SidePanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidePanel from './SidePanel'
import { useEditor } from './store'
import { makeDoc } from './testDoc'

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, imageDefaultStyle: vi.fn() } }
})
vi.mock('./fonts', () => ({ loadBundledFont: vi.fn() }))

beforeEach(() => useEditor.getState().load(makeDoc()))
afterEach(() => {
  cleanup()
  useEditor.getState().reset()
})

const tab = (name: string) => screen.getByRole('tab', { name })

describe('SidePanel', () => {
  it('moves between tabs with the arrow keys, Home and End, focusing the new tab', () => {
    render(<SidePanel open onToggle={() => {}} />)
    tab('Objects').focus()
    fireEvent.keyDown(tab('Objects'), { key: 'ArrowRight' })
    expect(tab('Style').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Style'))
    fireEvent.keyDown(tab('Style'), { key: 'End' })
    expect(tab('Image').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Image'), { key: 'ArrowRight' })
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Objects'), { key: 'ArrowLeft' })
    expect(tab('Image').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab('Image'), { key: 'Home' })
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true')
  })

  it('only the current tab is in the tab order and its panel is focusable', () => {
    render(<SidePanel open onToggle={() => {}} />)
    expect(tab('Objects').tabIndex).toBe(0)
    expect(tab('Style').tabIndex).toBe(-1)
    const panel = screen.getByRole('tabpanel', { name: 'Objects' })
    expect(panel.tabIndex).toBe(0)
    expect(tab('Objects').getAttribute('aria-controls')).toBe(panel.id)
  })

  it('keeps a visited tab mounted, so its state survives a switch', () => {
    render(<SidePanel open onToggle={() => {}} />)
    fireEvent.change(screen.getByLabelText('Search objects'), { target: { value: 'M 4' } })
    fireEvent.click(tab('Layout'))
    expect(screen.getByRole('tabpanel', { name: 'Layout' }).hidden).toBe(false)
    expect(screen.getByLabelText('Search objects', { selector: 'input' }).closest('[role=tabpanel]')!.hidden).toBe(true)
    fireEvent.click(tab('Objects'))
    expect((screen.getByLabelText('Search objects') as HTMLInputElement).value).toBe('M 4')
  })

  it('does not mount a tab body before its first visit', () => {
    render(<SidePanel open onToggle={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Auto-arrange' })).toBeNull()
    fireEvent.click(tab('Layout'))
    expect(screen.getByRole('button', { name: 'Auto-arrange' })).toBeTruthy()
  })
})
```

(`getByLabelText` on a hidden panel: Testing Library's `hidden` filtering applies to `*ByRole` only, so the label query still finds the input inside the hidden Objects panel; the `*ByRole` queries above see only the visible panel. If `getByRole('tabpanel', { name: 'Layout' })` cannot resolve the name, `aria-labelledby` is missing — see Step 3.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/editor/SidePanel.test.tsx`
Expected: FAIL (no key handling, `tabIndex` 0 on every tab, the search value is lost).

- [ ] **Step 3: Rewrite `SidePanel`**

`frontend/src/editor/SidePanel.tsx`:

```tsx
import { useState, type ComponentType, type KeyboardEvent } from 'react'
import ImageTab from './ImageTab'
import LayoutTab from './LayoutTab'
import ObjectsTab from './ObjectsTab'
import StyleTab from './StyleTab'

type Tab = 'objects' | 'style' | 'layout' | 'image'

const TABS: { id: Tab; label: string; body: ComponentType }[] = [
  { id: 'objects', label: 'Objects', body: ObjectsTab },
  { id: 'style', label: 'Style', body: StyleTab },
  { id: 'layout', label: 'Layout', body: LayoutTab },
  { id: 'image', label: 'Image', body: ImageTab },
]

/** The editor's right-hand panel (design § 5). Collapses to a strip so the canvas can have the
 *  whole window; the open/closed state lives in `EditorPage` because the grid column is its CSS.
 *
 *  A tab body mounts on its first visit and then stays mounted behind `hidden`, so an export
 *  still rendering on the Image tab, or a search typed on the Objects tab, survives a switch
 *  (#76); a tab never opened costs nothing. The tablist follows the WAI-ARIA pattern: one tab
 *  stop, arrows / Home / End move and select, the panel itself is focusable. */
export default function SidePanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<Tab>('objects')
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set<Tab>(['objects']))

  const show = (id: Tab) => {
    setTab(id)
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab)
    let next: number
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    else return
    e.preventDefault()
    const id = TABS[next]!.id
    show(id)
    document.getElementById(`tab-${id}`)?.focus()
  }

  return (
    <aside className={open ? 'side-panel' : 'side-panel collapsed'}>
      <div className="side-panel-head">
        {/* Like the toolbar buttons: these act on click and never need the focus, so the canvas
            shortcuts stay alive and Space cannot re-click them. */}
        <button
          className="secondary panel-toggle"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggle}
        >
          {open ? '›' : '‹'}
        </button>
        {open && (
          <div className="tabs" role="tablist" onKeyDown={onKeyDown}>
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className="tab"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => show(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {open &&
        TABS.map(({ id, body: Body }) => (
          <div
            key={id}
            id={`panel-${id}`}
            role="tabpanel"
            aria-labelledby={`tab-${id}`}
            tabIndex={0}
            hidden={tab !== id}
            className="side-panel-body"
          >
            {visited.has(id) && <Body />}
          </div>
        ))}
    </aside>
  )
}
```

CSS, `frontend/src/styles.css`, after line 137:

```css
.side-panel-body[hidden] { display: none; }
```

(The panel's `flex: 1` would otherwise not matter, but an explicit rule keeps `hidden` authoritative if a later rule sets `display`.) The `aria-controls` clause of #76 is already satisfied: the tablist is not rendered while the panel is collapsed.

- [ ] **Step 4: The hit circles' cursor**

`frontend/src/editor/EditorCanvas.tsx`, in `hitCircles` (line ~571): replace the two hover handlers and add `editable` to the memo's dependency list:

```tsx
            // While a solve runs the click below no-ops; the cursor says so (#76).
            onMouseEnter={(e) => {
              hover(id)
              if (!editable) e.target.getStage()?.container().style.setProperty('cursor', 'not-allowed')
            }}
            onMouseLeave={(e) => {
              hover(null)
              e.target.getStage()?.container().style.removeProperty('cursor')
            }}
```

`[objectOrder, objects, style, view.scale, hover, editable]`.

- [ ] **Step 5: Run the tests, type-check, lint**

Run: `cd frontend && npx vitest run src/editor && npx tsc --noEmit && npx eslint src`
Expected: PASS, clean. `StyleTab.test.tsx` and `smoke.spec.ts` click tabs by role name, unchanged.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/editor/SidePanel.tsx frontend/src/editor/SidePanel.test.tsx frontend/src/editor/EditorCanvas.tsx frontend/src/styles.css
git commit -m "feat: keyboard tablist, focusable panels, tab bodies kept mounted, not-allowed cursor while solving"
```

---

### Task 5: Notices (#77)

**Files:**
- Create: `frontend/src/editor/notices.ts`, `frontend/src/editor/notices.test.ts`
- Modify: `frontend/src/editor/EditorCanvas.tsx:117,134,190,278,313,334-343,371-373,722-729,775` (size error, preview error, draw errors)
- Modify: `frontend/src/editor/autosave.ts:74-78`, `frontend/src/editor/autosave.test.ts`
- Modify: `frontend/src/editor/placement.ts:187-193`, `frontend/src/editor/placement.test.ts:79`, `frontend/src/editor/editing.ts:45`

**Interfaces:**
- Produces, in `notices.ts`: `CANVAS_SIZE_ERROR: string`; `STALE_DOCUMENT_MESSAGE: string`; `previewErrorSentence(status: number | null): string`; `probeStatus(url: string): Promise<number | null>`; `drawErrorNotice(count: number, firstName: string, firstMessage: string): string`; `isStaleDocumentStatus(status: number): boolean`. `placeNewLabel(state, measure, id): { x; y; collided }` (no longer nullable). `EntryProps.onDrawError: (id: number, message: string) => void`.

- [ ] **Step 1: Write the failing notices test**

`frontend/src/editor/notices.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { drawErrorNotice, isStaleDocumentStatus, previewErrorSentence, probeStatus } from './notices'

afterEach(() => vi.unstubAllGlobals())

describe('previewErrorSentence', () => {
  it('names the session for a 401 and a reload otherwise', () => {
    expect(previewErrorSentence(401)).toBe('Your session has expired. Log in again.')
    expect(previewErrorSentence(500)).toBe(
      'The preview could not be loaded. Reload the page; if it keeps failing, re-upload the image.',
    )
    expect(previewErrorSentence(null)).toBe(previewErrorSentence(500))
  })
})

describe('probeStatus', () => {
  it('returns the HEAD status, or null when the probe itself fails', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ status: 401 }).mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetch)
    expect(await probeStatus('/preview')).toBe(401)
    expect(fetch).toHaveBeenCalledWith('/preview', { method: 'HEAD', credentials: 'same-origin' })
    expect(await probeStatus('/preview')).toBeNull()
  })
})

describe('drawErrorNotice', () => {
  it('counts, names the first object and warns about the export', () => {
    expect(drawErrorNotice(1, 'M 42', 'the ascent table is missing')).toBe(
      'The label for M 42 could not be drawn: the ascent table is missing. The export may differ from this preview.',
    )
    expect(drawErrorNotice(3, 'M 42', 'x')).toBe(
      '3 labels could not be drawn (first: M 42): x. The export may differ from this preview.',
    )
  })
})

describe('isStaleDocumentStatus', () => {
  it('is the validation statuses only', () => {
    expect([400, 422].map(isStaleDocumentStatus)).toEqual([true, true])
    expect([401, 404, 409, 500].map(isStaleDocumentStatus)).toEqual([false, false, false, false])
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd frontend && npx vitest run src/editor/notices.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `notices.ts`**

```ts
// The editor's failure sentences (SPEC § 6.3, #77), kept out of the Konva component so they are
// tested without a browser. Every sentence names a next step; none carries server paths or raw
// exception text beyond the measurer's own message.

export const CANVAS_SIZE_ERROR = 'The editor could not size its canvas. Reload the page, or widen the window.'

/** A validation 4xx on save: the document no longer matches the server's objects (a re-solve
 *  landed between load and save). Shown in the conflict state — Reload, since a Retry can never
 *  succeed. */
export const STALE_DOCUMENT_MESSAGE = "This image's objects changed; reload the editor."

export function previewErrorSentence(status: number | null): string {
  if (status === 401) return 'Your session has expired. Log in again.'
  return 'The preview could not be loaded. Reload the page; if it keeps failing, re-upload the image.'
}

/** An `<img>` error carries no status, so the failing URL is asked once more with HEAD; null
 *  when even that fails (offline), which reads as the generic sentence. */
export async function probeStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    return res.status
  } catch {
    return null
  }
}

export function drawErrorNotice(count: number, firstName: string, firstMessage: string): string {
  const head = count === 1 ? `The label for ${firstName} could not be drawn` : `${count} labels could not be drawn (first: ${firstName})`
  return `${head}: ${firstMessage}. The export may differ from this preview.`
}

export function isStaleDocumentStatus(status: number): boolean {
  return status === 400 || status === 422
}
```

- [ ] **Step 4: Run the notices test**

Run: `cd frontend && npx vitest run src/editor/notices.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the canvas**

`frontend/src/editor/EditorCanvas.tsx`:

- Import `CANVAS_SIZE_ERROR, drawErrorNotice, previewErrorSentence, probeStatus` from `./notices`.
- Line 313: `else setSizeError(CANVAS_SIZE_ERROR)`.
- Lines 334-343, the preview `onerror`:

```ts
    el.onerror = () => {
      if (cancelled) return
      // The bitmap says only that it failed; the status decides the sentence (a 401 is the
      // session, not the file).
      void probeStatus(src).then((status) => {
        if (!cancelled) setLoadedPreview({ src, el: null, error: previewErrorSentence(status) })
      })
    }
```

- Draw errors: line 278 becomes `const [drawErrors, setDrawErrors] = useState<ReadonlyMap<number, string>>(new Map())`; lines 371-373 become

```ts
  // Every label whose draw threw, in failure order; the notice counts them and names the first.
  // A label that keeps failing reports once (the shape stops drawing after its first throw).
  const onDrawError = useCallback((id: number, message: string) => {
    setDrawErrors((prev) => (prev.has(id) ? prev : new Map(prev).set(id, message)))
  }, [])
```

`EntryProps.onDrawError` (line 117) becomes `(id: number, message: string) => void`; in `LabelEntry` (line 190) pass `onDrawError={(m) => onDrawError(label.object_id, m)}`. Line 725:

```ts
  if (drawErrors.size > 0) {
    const [firstId, firstMessage] = drawErrors.entries().next().value as [number, string]
    const first = objects.get(firstId)
    const name = first ? primaryName(first.catalog_names, style.name_preference) : `object ${firstId}`
    notices.push({ text: drawErrorNotice(drawErrors.size, name, firstMessage), error: true })
  }
```

- [ ] **Step 6: The save path**

`frontend/src/editor/autosave.ts:74-78`:

```ts
      if (err instanceof ApiError && err.status === 409) {
        useEditor.getState().markConflict(err.message)
      } else if (err instanceof ApiError && isStaleDocumentStatus(err.status)) {
        // The server's validation sentence would sit in the toolbar with a Retry that can never
        // succeed; the conflict state offers Reload instead (#77).
        useEditor.getState().markConflict(STALE_DOCUMENT_MESSAGE)
      } else {
        useEditor.getState().markSaveError(describeError(err))
      }
```

Import `STALE_DOCUMENT_MESSAGE, isStaleDocumentStatus` from `./notices`. Add to `frontend/src/editor/autosave.test.ts`, after the 409 test:

```ts
  it('422 → the stale-document sentence in the conflict state, with the history cleared', async () => {
    const f = fakeSave()
    stop = startAutosave('img', { save: f.save })
    f.setFail(new ApiError(422, "labels must list every object exactly once"))
    useEditor.getState().toggleObject(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(useEditor.getState().save).toEqual({
      status: 'conflict',
      message: "This image's objects changed; reload the editor.",
    })
    expect(useEditor.getState().undo).toEqual([])
  })
```

(Mirror the 409 test's exact setup at line 89 if it differs from this shape — same `fakeSave`, same `advanceTimersByTimeAsync`.)

- [ ] **Step 7: `placeNewLabel` throws**

`frontend/src/editor/placement.ts:187-193`:

```ts
/** The object's label measured with the current style, placed against every other enabled
 *  label's box and marker. Throws for an id the document does not hold — unreachable from the
 *  toggle path, which checks first, so a miss is a bug and must not enable the label unplaced. */
export function placeNewLabel(state: EditorState, measure: TextMeasurer, id: number): { x: number; y: number; collided: boolean } {
  const placed = placeNewLabels(state, measure, [id]).get(id)
  if (!placed) throw new Error(`placeNewLabel: object ${id} has no label to place`)
  return placed
}
```

`frontend/src/editor/editing.ts:45`: `state.toggleObject(id, placeNewLabel(state, measure ?? getMeasurer(), id))`.

`frontend/src/editor/placement.test.ts:79`: `expect(() => placeNewLabel(useEditor.getState(), measure, 999)).toThrow(/999/)` (rename the test to say it throws).

- [ ] **Step 8: Run the editor suite, type-check, lint**

Run: `cd frontend && npx vitest run src/editor && npx tsc --noEmit && npx eslint src`
Expected: PASS, clean.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/editor/notices.ts frontend/src/editor/notices.test.ts frontend/src/editor/EditorCanvas.tsx frontend/src/editor/autosave.ts frontend/src/editor/autosave.test.ts frontend/src/editor/placement.ts frontend/src/editor/placement.test.ts frontend/src/editor/editing.ts
git commit -m "fix: editor notices name a next step; validation 4xx on save offers Reload; placeNewLabel throws"
```

---

### Task 6: Playwright — the panel end to end

**Files:**
- Create: `frontend/e2e/panel.spec.ts`

**Interfaces:**
- Consumes: helpers `ensureSetUpAndSignedIn`, `ensureSolvedImage`, `currentImageId`, `fetchAnnotations`; the `window.__astrocaptionEditor.labelPositions` hook; the Style tab's "Primary name" select; chip and tab names from Tasks 2–4.

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from './fixtures'
import { currentImageId, ensureSetUpAndSignedIn, ensureSolvedImage, fetchAnnotations } from './helpers'

// Side panel (SPEC § 6.3): the Objects tab filters by kind with the HD toggle, its names follow
// the Style tab's preference without a reload (#94), the tablist works from the keyboard and a
// visited tab keeps its state across a switch (#76).
test('the side panel: kind chips, keyboard tabs, kept state, names follow the preference', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page)
  await card.getByRole('link', { name: 'Edit' }).click()
  await expect(page).toHaveURL(/\/images\/[0-9a-f-]+$/)
  await page.waitForFunction(() => window.__astrocaptionEditor?.labelPositions !== undefined)
  const imageId = currentImageId(page)

  // Kind chips: the Orion fixture has 8 bright stars, 9 NGC and 3 IC rows.
  const rows = page.locator('.object-list .object-row')
  await expect(page.getByText('20 of 20 objects')).toBeVisible()
  await page.getByRole('button', { name: 'Stars' }).click()
  await expect(page.getByText('12 of 20 objects')).toBeVisible()
  await expect(rows.filter({ hasText: 'star' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Stars' }).click()
  await expect(page.getByText('20 of 20 objects')).toBeVisible()
  // No hd rows in this field: the toggle changes nothing but stays pressable.
  await page.getByRole('button', { name: 'HD stars' }).click()
  await expect(page.getByRole('button', { name: 'HD stars' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'HD stars' }).click()

  // A search typed here survives a visit to another tab.
  await page.getByLabel('Search objects').fill('M 4')
  await page.getByRole('tab', { name: 'Image' }).click()
  await expect(page.getByRole('button', { name: 'Export' })).toBeVisible()
  await page.getByRole('tab', { name: 'Objects' }).click()
  await expect(page.getByLabel('Search objects')).toHaveValue('M 4')
  await page.getByLabel('Search objects').fill('')

  // Keyboard: ArrowRight selects and focuses the next tab.
  await page.getByRole('tab', { name: 'Objects' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Style' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Style' })).toBeFocused()

  // Names follow the preference: M 42 ↔ NGC 1976, then put the stored preference back (the data
  // dir is shared with the rest of the suite).
  const before = (await fetchAnnotations(page, imageId)).style.name_preference
  const other = before === 'popular' ? 'ngc_ic' : 'popular'
  const select = page.getByLabel('Primary name')
  await select.selectOption(other)
  await expect.poll(async () => (await fetchAnnotations(page, imageId)).style.name_preference, { timeout: 5_000 }).toBe(other)
  await page.getByRole('tab', { name: 'Objects' }).click()
  const expectName = other === 'ngc_ic' ? 'NGC 1976' : 'M 42'
  await expect(page.getByRole('button', { name: expectName, exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Style' }).click()
  await select.selectOption(before)
  await expect.poll(async () => (await fetchAnnotations(page, imageId)).style.name_preference, { timeout: 5_000 }).toBe(before)
})
```

If the fixture's counts differ (check with `python3 -c` over `backend/tests/fixtures/nova/annotations.json`: 8 `bright`, 9 `ngc`, 3 `ic`), fix the numbers in the spec, not the fixture.

- [ ] **Step 2: Run the browser suite**

Run: `make e2e`
Expected: all specs PASS, including `smoke.spec.ts` (its Objects-tab checkbox step is unchanged) and `parity.spec.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/panel.spec.ts
git commit -m "test: Playwright spec for the side panel (kind chips, keyboard tabs, kept state, names)"
```

---

### Task 7: SPEC.md, full gates, PR

**Files:**
- Modify: `docs/SPEC.md:200-202` (Objects tab), `docs/SPEC.md:308` (`GET /images/{id}/objects`)

- [ ] **Step 1: SPEC § 6.3 Objects**

Replace lines 200-202 with:

```markdown
1. **Objects** — searchable list of every object nova returned. Columns: checkbox (enabled), name, kind, radius. The name is ranked in the browser under the Style tab's name preference, so changing it updates the list at once. Kind chips — Galaxies, Nebulae, Clusters, Stars, Other — filter the list: nova's `bright`/`hd` rows are stars, the rest take OpenNGC's type (`G`/`GPair`/`GTrpl`/`GGroup` → galaxy; `Neb`/`EmN`/`RfN`/`HII`/`PN`/`SNR`/`DrkN` → nebula; `OCl`/`GCl`/`Cl+N` → cluster; anything else, including stars and associations listed as NGC objects, → other). An **HD stars** toggle, off by default (#37: a narrow field can return dozens of HD rows, most of them a brighter object's twin), shows nova's `hd` rows inside the stars. Hovering or keyboard-focusing a row highlights it and its marker on the canvas; clicking the name pans to it; the selected label's row is marked. Bulk actions are "Enable shown" / "Disable shown" (both act on the rows the search and filter currently show).
   Each is one change: the labels being enabled are placed one after another, each around the ones before it, and applied together, so a batch is one undo entry and one save. The min-size slider is not built.
```

After the Tabs list (before § 6.4) add:

```markdown
The tablist works from the keyboard (arrow keys, Home, End move and select; one tab stop; each panel is focusable). A tab body mounts on its first visit and stays mounted, so an export still rendering on the Image tab or a search typed on the Objects tab survives a switch. While a solve runs, the markers show a `not-allowed` cursor. Editor failure notices each name a next step: a canvas that could not be sized, a preview that failed to load (a 401 says the session has expired), labels that could not be drawn (counted, the first one named, "the export may differ from this preview") and a save the server rejected because the objects changed (Reload, as for a conflict).
```

`docs/SPEC.md:308`: `- \`GET /images/{id}/objects\` — each object carries \`kind\` (galaxy / nebula / cluster / star / other, computed from nova's type and OpenNGC at read time) beside \`catalog_names\` and \`primary_name\`.`

- [ ] **Step 2: Full gates**

Run: `make lint test && make e2e`
Expected: all green. Then `docker image ls` is not needed (no image change); `names.json` grew by a few hundred KB, well under the 400 MB budget.

- [ ] **Step 3: Commit and push**

```bash
git add docs/SPEC.md
git commit -m "docs: SPEC § 6.3 Objects tab kinds, panel keyboard and notices; § 8 kind"
git push -u origin feat/m4-pr5-objects-tab-notices
```

- [ ] **Step 4: Review ritual, then the PR**

Per CLAUDE.md: `/code-review high`, a silent-failure pass (pr-review-toolkit agent) on the diff, then `/simplify`; fix, re-run `make lint test`, and the owner smoke-tests on `make dev` before the PR is opened. Then:

```bash
gh pr create --title "feat: Objects tab kinds, side-panel keyboard and kept state, editor notices (milestone 4, PR 5)" --body-file /tmp/claude-1000/-home-dmitr-astrocaption/838b3de5-020a-4eea-847e-ee9b212e184d/scratchpad/pr5-body.md
```

with a body that lists the four areas, says `Closes #75 #76 #77 #94`, notes the regenerated `names.json` (OpenNGC master as of the run date), and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Stop after `gh pr checks --watch` is green: merging is the owner's call.
