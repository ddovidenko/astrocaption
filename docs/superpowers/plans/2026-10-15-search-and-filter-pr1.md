# Search and owner filters (PR 1 of #189) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A search box on the Images page and the public gallery that finds an image by title or by any catalogue name of any object in it, plus status and visibility chips for the owner, all held in the URL and carried by Show more.

**Architecture:** Both paged list endpoints take `q` (and the owner's `status` and `published`) as extra query parameters and keep the `{items, next}` page shape and the rowid keyset cursor. In SQLite the match is `instr(fold(title), ?)` or an `EXISTS` over `objects` with `fold_names(catalog_names)`, where `fold` and `fold_names` are two deterministic Python functions registered on every connection (case-fold plus whitespace removal, so "m27" finds "M 27"; `instr` means no `LIKE` wildcards to escape). In the browser a pure `listQuery.ts` module maps URL params to the API query and to the Show more href; one `ListFilters` component owns the box and chips; both pages read the query from `useSearchParams` and write it back with history replace.

**Tech Stack:** FastAPI + stdlib sqlite3 (Python 3.13+), React 19 + react-router + TypeScript strict, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-search-and-filter-design.md` (sections "API and storage (PR 1)", "Pages and URL state (PR 1)", "Errors", "Tests", "Documents"). The spec's SQL sketch uses `REPLACE(LOWER(…)) LIKE`; this plan replaces it with the registered `fold` functions and `instr` (Unicode case-folding, no wildcard escaping) and Task 9 amends the spec to say so.

## Global Constraints

- Python 3.13+, type hints everywhere, ruff defaults, mypy; Pydantic models for every request/response (CLAUDE.md).
- TypeScript strict; function components + hooks; component tests are `*.test.tsx` beside the component with `// @vitest-environment jsdom` on line 1; assert on the DOM or the store, never on internals.
- API responses never carry server paths or raw exception text; a hand-edited bad parameter is a plain 422.
- Public (logged-out) routes are read-only; `/api/gallery` ignores `status` and `published` and keeps `published = 1 AND solve_status = 'solved'`.
- Page shape `{items, next}` and the cursor rule (`before` = rows inserted before that row; a deleted cursor row is 422 "That page is no longer available; reload the list.") are unchanged.
- Results stay newest first (rowid DESC). No match count, no ranking.
- Never call nova.astrometry.net in tests; the e2e suite runs against the fake nova and the Orion fixture (title "Orion", names "M 42", "NGC 1976", "Orion Nebula").
- No new dependencies. Ask before adding one.
- `make lint test` green after every task; `make e2e` green at the end.
- Conventional commits; never push to `main`; branch `feat/189-search-filter` already exists with the spec committed.
- Never `git add -A`; stage by path.

## Review Focus

1. **Unicode titles.** A Cyrillic or accented title must be found by a lower-case query: `fold` uses `str.casefold`, not SQLite's ASCII `LOWER`. Pinned in Task 1 (`test_fold_casefolds_unicode_and_drops_whitespace`).
2. **Wildcards in the query.** "M_27" or "100%" must match literally, not everything: `instr`, not `LIKE`. Pinned in Task 1 (`test_list_images_q_treats_like_wildcards_literally`).
3. **A query of only whitespace** is no filter at all, not a search for nothing. Pinned in Task 1 (`test_list_images_blank_q_is_no_filter`) and Task 3 (`toPageQuery` omits an empty `q`).
4. **A slow old search answering after a fast new one** must not put the old results back. The Images page's sequence guard and the gallery's cancelled flag already cover it; Task 7 pins it for the gallery (`drops the answer of a search the visitor has already moved on from`).
5. **A filter change while a `?before=` cursor is in the URL** must start the new result set from the top. Pinned in Task 3 (`writeListQuery drops before`) and Task 7 (`a search typed on a followed Show more link starts the search from the top`).

---

### Task 1: `fold`, `ListFilter` and the storage filter

**Files:**
- Modify: `backend/app/db.py` (imports at top; `PAGE_LIMIT`/`UnknownCursor`/`ImagePage` block around lines 35-47; `connect()` around line 312; `_list_images`/`list_images`/`list_published_images` around lines 368-406)
- Test: `backend/tests/test_db.py`

**Interfaces:**
- Consumes: `Database._list_images(limit, before, where, params)` as it exists today.
- Produces:
  - `ListStatus = Literal["solving", "failed", "solved"]`
  - `@dataclass(frozen=True) class ListFilter: q: str = ""; status: ListStatus | None = None; published: bool | None = None`
  - `fold(text: str) -> str` and `fold_names(catalog_names_json: str) -> str` (module level, registered on every connection as SQL functions `fold` and `fold_names`)
  - `Database.list_images(limit=PAGE_LIMIT, before=None, filter=ListFilter()) -> ImagePage`
  - `Database.list_published_images(limit=PAGE_LIMIT, before=None, filter=ListFilter()) -> ImagePage`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_db.py` (the file already imports `Database`, `ImageRecord`, `SolveObject`, `SolveStatus`, `Path`, and defines `_plain_image(image_id, created, published=False)`):

```python
from app.db import ListFilter, fold, fold_names


def test_fold_casefolds_unicode_and_drops_whitespace() -> None:
    assert fold("  M 27 ") == "m27"
    assert fold("Туманность Андромеды") == "туманностьандромеды"
    assert fold("Straße") == "strasse"
    assert fold("") == ""


def test_fold_names_folds_every_name_in_the_json_array() -> None:
    names = fold_names('["NGC 6960", "C 34", "Veil Nebula"]')
    assert "ngc6960" in names
    assert "veilnebula" in names
    # Names are separated, so a query cannot bridge two of them.
    assert "c34veil" not in names


def _with_objects(db: Database, image_id: str, created: str, names: list[list[str]]) -> None:
    db.insert_image(_plain_image(image_id, created))
    db.replace_objects(
        image_id,
        [
            SolveObject(id=i, catalog_names=n, type="ngc", x=1.0, y=1.0, radius=1)
            for i, n in enumerate(names, start=1)
        ],
    )


def test_list_images_q_matches_title_primary_name_and_alias(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "veil", "2026-09-01T00:00:00Z", [["NGC 6960", "C 34", "Veil Nebula"]])
    _with_objects(db, "m27", "2026-09-02T00:00:00Z", [["NGC 6853", "M 27", "Dumbbell Nebula"]])
    db.insert_image(_plain_image("M31_stacked_final", "2026-09-03T00:00:00Z"))

    def ids(q: str) -> list[str]:
        return [r.id for r in db.list_images(filter=ListFilter(q=q)).items]

    assert ids("veil") == ["veil"]
    assert ids("NGC6960") == ["veil"]
    assert ids("ngc 6960") == ["veil"]
    assert ids("c 34") == ["veil"]
    assert ids("m27") == ["m27"]
    assert ids("dumbbell") == ["m27"]
    assert ids("m31") == ["M31_stacked_final"]
    assert ids("nebula") == ["m27", "veil"]  # newest first, both by an object name
    assert ids("andromeda") == []


def test_list_images_blank_q_is_no_filter(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("a", "2026-09-01T00:00:00Z"))
    db.insert_image(_plain_image("b", "2026-09-02T00:00:00Z"))
    assert [r.id for r in db.list_images(filter=ListFilter(q="   ")).items] == ["b", "a"]
    assert [r.id for r in db.list_images().items] == ["b", "a"]


def test_list_images_q_treats_like_wildcards_literally(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("M_27", "2026-09-01T00:00:00Z"))
    db.insert_image(_plain_image("M 27", "2026-09-02T00:00:00Z"))
    db.insert_image(_plain_image("100%", "2026-09-03T00:00:00Z"))
    assert [r.id for r in db.list_images(filter=ListFilter(q="M_27")).items] == ["M_27"]
    assert [r.id for r in db.list_images(filter=ListFilter(q="%")).items] == ["100%"]


def test_list_images_q_pages_inside_the_result_set(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    for n in range(5):
        db.insert_image(_plain_image(f"orion-{n}", f"2026-09-0{n + 1}T00:00:00Z"))
        db.insert_image(_plain_image(f"other-{n}", f"2026-09-0{n + 1}T12:00:00Z"))
    first = db.list_images(2, None, ListFilter(q="orion"))
    assert [r.id for r in first.items] == ["orion-4", "orion-3"]
    assert first.next == "orion-3"
    second = db.list_images(2, first.next, ListFilter(q="orion"))
    assert [r.id for r in second.items] == ["orion-2", "orion-1"]
    third = db.list_images(2, second.next, ListFilter(q="orion"))
    assert ([r.id for r in third.items], third.next) == (["orion-0"], None)


def test_list_images_status_and_published_filters(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    rows = [
        ("pending", SolveStatus.PENDING, False),
        ("solving", SolveStatus.SOLVING, False),
        ("failed", SolveStatus.FAILED, True),
        ("solved-pub", SolveStatus.SOLVED, True),
        ("solved-unpub", SolveStatus.SOLVED, False),
    ]
    for n, (image_id, status, published) in enumerate(rows):
        rec = _plain_image(image_id, f"2026-09-0{n + 1}T00:00:00Z", published)
        db.insert_image(rec.model_copy(update={"solve_status": status}))

    def ids(**kw: object) -> list[str]:
        return [r.id for r in db.list_images(filter=ListFilter(**kw)).items]  # type: ignore[arg-type]

    assert ids(status="solving") == ["solving", "pending"]
    assert ids(status="failed") == ["failed"]
    assert ids(status="solved") == ["solved-unpub", "solved-pub"]
    assert ids(published=True) == ["solved-pub", "failed"]
    assert ids(published=False) == ["solved-unpub", "solving", "pending"]
    assert ids(status="solved", published=True) == ["solved-pub"]
    assert ids(status="solved", published=True, q="unpub") == []


def test_list_published_images_takes_q_and_ignores_status_and_published(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "veil-unpub", "2026-09-01T00:00:00Z", [["NGC 6960", "Veil Nebula"]])
    db.insert_image(_plain_image("veil-pub", "2026-09-02T00:00:00Z", published=True))
    db.replace_objects(
        "veil-pub", [SolveObject(id=1, catalog_names=["NGC 6992", "Eastern Veil"], type="ngc", x=1.0, y=1.0, radius=1)]
    )
    db.insert_image(_plain_image("m27-pub", "2026-09-03T00:00:00Z", published=True))
    gallery = db.list_published_images(filter=ListFilter(q="veil"))
    assert [r.id for r in gallery.items] == ["veil-pub"]
    # The gallery's own conditions win: an owner filter cannot widen what visitors see.
    widened = db.list_published_images(filter=ListFilter(q="veil", published=False, status="failed"))
    assert [r.id for r in widened.items] == ["veil-pub"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_db.py -k "fold or list_images_q or status_and_published or takes_q" -v`
Expected: ImportError, `cannot import name 'ListFilter' from 'app.db'`.

- [ ] **Step 3: Implement `fold`, `fold_names`, `ListFilter` and the filter conditions**

In `backend/app/db.py`:

Add to the imports: `from dataclasses import dataclass` and `from typing import Literal, NamedTuple` (replace the existing `from typing import NamedTuple`).

After the `ImagePage` class (around line 47), add:

```python
ListStatus = Literal["solving", "failed", "solved"]
"""The owner's status chip: ``solving`` is every row the Images page polls (pending too)."""


@dataclass(frozen=True)
class ListFilter:
    """What narrows a paged list (SPEC § 8). An empty ``q`` and None filters mean "everything";
    the gallery takes only ``q`` and ignores the owner's two."""

    q: str = ""
    status: ListStatus | None = None
    published: bool | None = None


def fold(text: str) -> str:
    """The search form of a title, a catalogue name or a query: case-folded (Unicode, not
    SQLite's ASCII ``LOWER``) with every whitespace run removed, so "m27", "M 27" and "M  27"
    are the same string. Registered on every connection as the SQL function ``fold``."""
    return "".join(text.casefold().split())


def fold_names(catalog_names_json: str) -> str:
    """``fold`` of every name in an ``objects.catalog_names`` cell, newline-separated so a
    query cannot bridge two names. Registered as the SQL function ``fold_names``. A cell that
    is not a JSON list (never written by this code) folds to nothing rather than failing the
    whole query."""
    try:
        names = json.loads(catalog_names_json)
    except ValueError:
        return ""
    if not isinstance(names, list):
        return ""
    return "\n".join(fold(n) for n in names if isinstance(n, str))


#: One of these per `ListFilter.status`, over `images.solve_status`.
_STATUS_CONDITIONS: dict[str, tuple[str, tuple[object, ...]]] = {
    "solving": (
        "solve_status IN (?, ?)",
        (SolveStatus.PENDING.value, SolveStatus.SOLVING.value),
    ),
    "failed": ("solve_status = ?", (SolveStatus.FAILED.value,)),
    "solved": ("solve_status = ?", (SolveStatus.SOLVED.value,)),
}

_SEARCH_CONDITION = (
    "(instr(fold(title), ?) > 0 OR EXISTS ("
    "SELECT 1 FROM objects o WHERE o.image_id = images.id AND instr(fold_names(o.catalog_names), ?) > 0))"
)


def _filter_conditions(filter: ListFilter) -> tuple[list[str], list[object]]:
    """The WHERE fragments and their parameters for `filter`, in a fixed order."""
    conds: list[str] = []
    values: list[object] = []
    needle = fold(filter.q)
    if needle:
        conds.append(_SEARCH_CONDITION)
        values.extend((needle, needle))
    if filter.status is not None:
        cond, params = _STATUS_CONDITIONS[filter.status]
        conds.append(cond)
        values.extend(params)
    if filter.published is not None:
        conds.append("published = ?")
        values.append(1 if filter.published else 0)
    return conds, values
```

In `connect()`, register the two functions right after `conn.row_factory = sqlite3.Row`:

```python
            conn.row_factory = sqlite3.Row
            # The search's normaliser runs in Python so a Cyrillic title case-folds too and
            # a space in "M 27" never matters; `instr` rather than LIKE, so a "%" in the
            # query is a "%".
            conn.create_function("fold", 1, fold, deterministic=True)
            conn.create_function("fold_names", 1, fold_names, deterministic=True)
            conn.execute("PRAGMA foreign_keys = ON")
```

Replace `list_images` and `list_published_images` (and make `_list_images` take a list of conditions):

```python
    def _list_images(
        self,
        limit: int,
        before: str | None,
        conds: list[str],
        values: list[object],
    ) -> ImagePage:
        # (keep the existing comment block about rowid order and the keyset cursor)
        conds = list(conds)
        values = list(values)
        with self.connect() as conn:
            if before is not None:
                cursor = conn.execute("SELECT rowid FROM images WHERE id = ?", (before,)).fetchone()
                if cursor is None:
                    raise UnknownCursor(before)
                conds.append("rowid < ?")
                values.append(cursor[0])
            clause = f" WHERE {' AND '.join(conds)}" if conds else ""
            rows = conn.execute(
                f"SELECT * FROM images{clause} ORDER BY rowid DESC LIMIT ?",
                (*values, limit + 1),
            ).fetchall()
        items = [_row_to_image(r) for r in rows[:limit]]
        return ImagePage(items, items[-1].id if len(rows) > limit else None)

    def list_images(
        self, limit: int = PAGE_LIMIT, before: str | None = None, filter: ListFilter = ListFilter()
    ) -> ImagePage:
        conds, values = _filter_conditions(filter)
        return self._list_images(limit, before, conds, values)

    def list_published_images(
        self, limit: int = PAGE_LIMIT, before: str | None = None, filter: ListFilter = ListFilter()
    ) -> ImagePage:
        """The gallery's rows: published and currently solved, newest first (SPEC § 5.5),
        narrowed by the search only: the owner's status and published chips are not public."""
        conds, values = _filter_conditions(ListFilter(q=filter.q))
        return self._list_images(
            limit,
            before,
            ["published = 1", "solve_status = ?", *conds],
            [SolveStatus.SOLVED.value, *values],
        )
```

(`ListFilter()` as a default argument is safe because the dataclass is frozen.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_db.py -v`
Expected: all PASS, including the pre-existing paging tests.

- [ ] **Step 5: Lint and type-check**

Run: `make lint`
Expected: ruff, mypy clean. If mypy objects to `filter` shadowing the builtin, keep the name (ruff's A002 is not in the defaults) but confirm there is no `filter(...)` builtin use in `db.py`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/db.py backend/tests/test_db.py
git commit -m "feat: list filters in storage: fold/fold_names search over title and object names, status, published (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `q`, `status` and `published` on the two list endpoints

**Files:**
- Modify: `backend/app/api/images.py` (imports around line 20; `LimitParam`/`BeforeParam` and `list_images` around lines 335-356)
- Modify: `backend/app/api/gallery.py` (imports around lines 18-23; `list_gallery` around lines 74-93)
- Test: `backend/tests/test_api.py`, `backend/tests/test_gallery.py`

**Interfaces:**
- Consumes: `ListFilter`, `ListStatus` from Task 1.
- Produces:
  - `QParam = Annotated[str | None, Query(max_length=200)]`, `StatusParam = Annotated[ListStatus | None, Query(alias="status")]`, `PublishedParam = Annotated[bool | None, Query()]` exported from `api/images.py` for the gallery router.
  - `GET /api/images?q=&status=&published=` and `GET /api/gallery?q=` with the unchanged `{items, next}` body.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api.py` after `test_list_images_is_paged` (the file has `upload(client, path, title=...)` from conftest):

```python
def test_list_images_search_and_filters(client: TestClient, sample_jpeg: Path) -> None:
    veil = upload(client, sample_jpeg, title="Veil Nebula wide")["id"]
    m27 = upload(client, sample_jpeg, title="M27 final")["id"]
    other = upload(client, sample_jpeg, title="Untitled stack")["id"]

    def ids(**params: object) -> list[str]:
        resp = client.get("/api/images", params=params)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) == {"items", "next"}
        return [i["id"] for i in body["items"]]

    assert ids(q="veil") == [veil]
    assert ids(q="m 27") == [m27]
    assert ids(q="  ") == [other, m27, veil]
    assert ids(q="nothing-here") == []
    # Every upload is solved by the fake solver, or still on its way: both chips are accepted.
    assert set(ids(status="solved") + ids(status="solving")) == {veil, m27, other}
    assert ids(status="failed") == []
    assert ids(published="true") == []
    assert ids(published="false") == [other, m27, veil]
    # Paging works inside the result set.
    page = client.get("/api/images", params={"q": "l", "limit": 1}).json()
    assert [i["id"] for i in page["items"]] == [other]
    assert page["next"] == other
    rest = client.get("/api/images", params={"q": "l", "limit": 1, "before": page["next"]}).json()
    assert [i["id"] for i in rest["items"]] == [m27]
    # Hand-edited parameters are a plain 422, never a 500.
    assert client.get("/api/images", params={"status": "weird"}).status_code == 422
    assert client.get("/api/images", params={"published": "maybe"}).status_code == 422
    assert client.get("/api/images", params={"q": "x" * 201}).status_code == 422
```

Append to `backend/tests/test_gallery.py` after `test_gallery_is_paged_and_a_skipped_row_still_moves_the_cursor`:

```python
def test_gallery_search_finds_a_title_or_an_object_name_and_ignores_owner_filters(
    client: TestClient, anon_client: TestClient, sample_jpeg: Path
) -> None:
    published = published_image(client, sample_jpeg)  # title "Orion Field", Orion fixture objects
    unpublished = exported_image(client, sample_jpeg)

    def ids(**params: object) -> list[str]:
        resp = anon_client.get("/api/gallery", params=params)
        assert resp.status_code == 200, resp.text
        return [i["id"] for i in resp.json()["items"]]

    assert ids(q="orion field") == [published["id"]]
    assert ids(q="ngc1976") == [published["id"]]  # an object name, space-insensitively
    assert ids(q="m 42") == [published["id"]]
    assert ids(q="pleiades") == []
    # The owner's chips are not public: they are accepted and ignored, never widening the list.
    assert ids(published="false") == [published["id"]]
    assert ids(status="failed") == [published["id"]]
    assert unpublished["id"] not in ids(q="orion")
    assert anon_client.get("/api/gallery", params={"q": "x" * 201}).status_code == 422
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_api.py::test_list_images_search_and_filters tests/test_gallery.py::test_gallery_search_finds_a_title_or_an_object_name_and_ignores_owner_filters -v`
Expected: FAIL. The `q` is silently ignored today, so `ids(q="veil")` returns all three.

- [ ] **Step 3: Add the parameters**

In `backend/app/api/images.py`, extend the db import and the param aliases:

```python
from ..db import PAGE_LIMIT, Database, ListFilter, ListStatus, UnknownCursor, hash_of
```

```python
LimitParam = Annotated[int, Query(ge=1, le=100)]
BeforeParam = Annotated[str | None, Query(min_length=1)]
#: The search box (SPEC § 8): title or any object name, case- and space-insensitive.
QParam = Annotated[str | None, Query(max_length=200)]
#: `status` on the wire; `status_filter` in the handler, where `status` is fastapi's module.
StatusParam = Annotated[ListStatus | None, Query(alias="status")]
PublishedParam = Annotated[bool | None, Query()]


@router.get("")
async def list_images(
    settings: SettingsDep,
    db: DbDep,
    limit: LimitParam = PAGE_LIMIT,
    before: BeforeParam = None,
    q: QParam = None,
    status_filter: StatusParam = None,
    published: PublishedParam = None,
) -> Page[ImageOut]:
    try:
        page = db.list_images(limit, before, ListFilter(q=q or "", status=status_filter, published=published))
    except UnknownCursor:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, PAGE_GONE) from None
```

(`status` is already the imported `fastapi.status` module in this file, hence the `status_filter` name with the alias inside `Annotated`. Never combine an `Annotated[..., Query()]` with a `Query(...)` default value: FastAPI refuses that at import time.)

In `backend/app/api/gallery.py`:

```python
from ..db import PAGE_LIMIT, Database, ListFilter, UnknownCursor
...
from .images import PAGE_GONE, BeforeParam, LimitParam, QParam
...
@router.get("")
async def list_gallery(
    settings: SettingsDep,
    db: DbDep,
    limit: LimitParam = PAGE_LIMIT,
    before: BeforeParam = None,
    q: QParam = None,
) -> Page[GalleryItem]:
    try:
        page = db.list_published_images(limit, before, ListFilter(q=q or ""))
```

FastAPI ignores unknown query parameters, so `status` and `published` on the gallery route are accepted and dropped, which is what the test asserts.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_api.py tests/test_gallery.py -v`
Expected: all PASS.

- [ ] **Step 5: Lint, then commit**

Run: `make lint`
Expected: clean.

```bash
git add backend/app/api/images.py backend/app/api/gallery.py backend/tests/test_api.py backend/tests/test_gallery.py
git commit -m "feat: q, status and published parameters on the image and gallery lists (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `listQuery.ts` and the API client's query parameters

**Files:**
- Create: `frontend/src/pages/listQuery.ts`
- Create: `frontend/src/pages/listQuery.test.ts`
- Modify: `frontend/src/api.ts` (`PageQuery` and `paged` around lines 231-241)

**Interfaces:**
- Produces (in `listQuery.ts`):
  - `export type ListStatus = 'solving' | 'failed' | 'solved'`
  - `export interface ListQuery { q: string; status: ListStatus | null; published: boolean | null }`
  - `export const EMPTY_QUERY: ListQuery`
  - `export function readListQuery(params: URLSearchParams): ListQuery` (trims `q`; unknown `status`/`published` values read as null)
  - `export function writeListQuery(params: URLSearchParams, query: ListQuery): URLSearchParams` (new object; always deletes `before`; removes `q`, `status`, `published` and re-adds the set ones in that fixed order, so the same query is always the same URL; keeps anything else)
  - `export function isFiltered(query: ListQuery): boolean`
  - `export function toPageQuery(query: ListQuery): PageQuery` (only the set fields; an empty `q` is omitted)
  - `export function pageHref(query: ListQuery, before: string): string` (`?q=…&status=…&published=…&before=…`, `encodeURIComponent`, only the set fields, `before` last)
- Produces (in `api.ts`): `PageQuery` gains `q?: string; status?: ListStatus; published?: boolean`, and `paged()` emits them in the order `limit, q, status, published, before`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/pages/listQuery.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EMPTY_QUERY, isFiltered, pageHref, readListQuery, toPageQuery, writeListQuery } from './listQuery'

describe('readListQuery', () => {
  it('reads q, status and published from the URL and trims the text', () => {
    const q = readListQuery(new URLSearchParams('q=%20veil%20&status=failed&published=true'))
    expect(q).toEqual({ q: 'veil', status: 'failed', published: true })
  })

  it('reads an empty URL as the empty query and ignores unknown values', () => {
    expect(readListQuery(new URLSearchParams(''))).toEqual(EMPTY_QUERY)
    expect(readListQuery(new URLSearchParams('status=weird&published=maybe'))).toEqual(EMPTY_QUERY)
  })
})

describe('writeListQuery', () => {
  it('sets the filters, drops before and keeps unrelated params', () => {
    const out = writeListQuery(new URLSearchParams('before=img-7&other=1'), { q: 'm 27', status: 'solved', published: false })
    expect(out.toString()).toBe('other=1&q=m+27&status=solved&published=false')
  })

  it('removes the keys of unset filters', () => {
    const out = writeListQuery(new URLSearchParams('q=x&status=failed&published=true'), EMPTY_QUERY)
    expect(out.toString()).toBe('')
  })
})

describe('toPageQuery', () => {
  it('omits everything unset, including a blank q', () => {
    expect(toPageQuery(EMPTY_QUERY)).toEqual({})
    expect(toPageQuery({ q: '  ', status: null, published: null })).toEqual({})
    expect(toPageQuery({ q: 'veil', status: 'solving', published: true })).toEqual({ q: 'veil', status: 'solving', published: true })
  })
})

describe('isFiltered', () => {
  it('is true when any filter is set', () => {
    expect(isFiltered(EMPTY_QUERY)).toBe(false)
    expect(isFiltered({ ...EMPTY_QUERY, q: ' ' })).toBe(false)
    expect(isFiltered({ ...EMPTY_QUERY, published: false })).toBe(true)
  })
})

describe('pageHref', () => {
  it('carries the filters before the cursor, encoded', () => {
    expect(pageHref(EMPTY_QUERY, 'img 9')).toBe('?before=img%209')
    expect(pageHref({ q: 'm 27', status: 'failed', published: null }, 'img-9')).toBe('?q=m%2027&status=failed&before=img-9')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/listQuery.test.ts`
Expected: FAIL, cannot resolve `./listQuery`.

- [ ] **Step 3: Write `listQuery.ts` and extend `PageQuery`**

In `frontend/src/api.ts`, replace the `PageQuery`/`paged` block:

```ts
export type ListStatus = 'solving' | 'failed' | 'solved'

export interface PageQuery {
  limit?: number
  before?: string | null
  /** The search box (SPEC § 8): title or any object name, case- and space-insensitive. */
  q?: string
  status?: ListStatus
  published?: boolean
}

function paged(path: string, { limit, before, q, status, published }: PageQuery): string {
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (q) params.set('q', q)
  if (status) params.set('status', status)
  if (published !== undefined) params.set('published', String(published))
  if (before) params.set('before', before)
  const query = params.toString()
  return query ? `${path}?${query}` : path
}
```

`frontend/src/pages/listQuery.ts`:

```ts
import type { ListStatus, PageQuery } from '../api'

export type { ListStatus }

/** The search and filters of a list page (SPEC § 5.5, § 8). The URL is its only home: both
 *  pages read it with `readListQuery` and write it back with `writeListQuery`, so a result is
 *  linkable and a reload lands on the same list. */
export interface ListQuery {
  q: string
  status: ListStatus | null
  published: boolean | null
}

export const EMPTY_QUERY: ListQuery = { q: '', status: null, published: null }

const STATUSES: readonly ListStatus[] = ['solving', 'failed', 'solved']

function statusOf(value: string | null): ListStatus | null {
  return (STATUSES as readonly string[]).includes(value ?? '') ? (value as ListStatus) : null
}

function publishedOf(value: string | null): boolean | null {
  return value === 'true' ? true : value === 'false' ? false : null
}

/** The query a URL names; unknown values read as unset rather than erroring. */
export function readListQuery(params: URLSearchParams): ListQuery {
  return {
    q: (params.get('q') ?? '').trim(),
    status: statusOf(params.get('status')),
    published: publishedOf(params.get('published')),
  }
}

/** `params` with `query` written in and the cursor dropped: a changed filter is a new result
 *  set, and the old `before` belonged to the old one. Keys of unset filters are removed. */
export function writeListQuery(params: URLSearchParams, query: ListQuery): URLSearchParams {
  const out = new URLSearchParams(params)
  // Remove first, then append in one fixed order, so the same query is always the same URL
  // whichever filter was touched first.
  out.delete('before')
  for (const [key] of entries(query)) out.delete(key)
  for (const [key, value] of entries(query)) {
    if (value !== null) out.set(key, value)
  }
  return out
}

export function isFiltered(query: ListQuery): boolean {
  return entries(query).some(([, value]) => value !== null)
}

/** The API's view of the query: only what is set. */
export function toPageQuery(query: ListQuery): PageQuery {
  const page: PageQuery = {}
  const q = query.q.trim()
  if (q) page.q = q
  if (query.status) page.status = query.status
  if (query.published !== null) page.published = query.published
  return page
}

/** The Show more link: the current filters, then the cursor, so a followed link stays inside
 *  the result set (SPEC § 5.5). */
export function pageHref(query: ListQuery, before: string): string {
  const parts = entries(query)
    .filter((pair): pair is [string, string] => pair[1] !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  parts.push(`before=${encodeURIComponent(before)}`)
  return `?${parts.join('&')}`
}

/** The query's URL keys and string values, in URL order; null for an unset one. */
function entries(query: ListQuery): [string, string | null][] {
  const q = query.q.trim()
  return [
    ['q', q || null],
    ['status', query.status],
    ['published', query.published === null ? null : String(query.published)],
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/listQuery.test.ts src/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and type-check, then commit**

Run: `make lint`
Expected: eslint and tsc clean.

```bash
git add frontend/src/pages/listQuery.ts frontend/src/pages/listQuery.test.ts frontend/src/api.ts
git commit -m "feat: listQuery maps the list filters between the URL, the API and the pager link (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `ListFilters` component and its styles

**Files:**
- Create: `frontend/src/pages/ListFilters.tsx`
- Create: `frontend/src/pages/ListFilters.test.tsx`
- Modify: `frontend/src/styles.css` (the input rule on line 36; add `.list-filters` rules next to `.chips` around line 188)

**Interfaces:**
- Consumes: `ListQuery`, `EMPTY_QUERY`, `isFiltered` from Task 3.
- Produces: `export default function ListFilters({ query, onChange, owner, label }: { query: ListQuery; onChange: (next: ListQuery) => void; owner?: boolean; label: string })`. The input has `type="search"` and `aria-label={label}` (role `searchbox`). Typing calls `onChange` after 250 ms with the new `q`; chips call it at once; a "Clear" button (shown only when `isFiltered(query)`) calls it with `EMPTY_QUERY`. `owner` renders the two chip groups: Solving / Failed / Solved (`status`) and Published / Unpublished (`published`).
- `export const SEARCH_DEBOUNCE_MS = 250`.

- [ ] **Step 1: Write the failing tests**

`frontend/src/pages/ListFilters.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ListFilters, { SEARCH_DEBOUNCE_MS } from './ListFilters'
import { EMPTY_QUERY, type ListQuery } from './listQuery'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('ListFilters', () => {
  it('reports the typed text once the typing pauses', () => {
    const onChange = vi.fn()
    render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' })
    fireEvent.change(box, { target: { value: 'm 2' } })
    fireEvent.change(box, { target: { value: 'm 27' } })
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_QUERY, q: 'm 27' })
  })

  it('shows the chips to the owner only, one pressed per group, and a second press clears it', () => {
    const onChange = vi.fn()
    const query: ListQuery = { q: '', status: 'failed', published: null }
    const { rerender } = render(<ListFilters query={query} onChange={onChange} owner label="Search images" />)
    expect(pressed('Failed')).toBe('true')
    expect(pressed('Solved')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...query, status: 'solved' })
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...query, status: null })
    fireEvent.click(screen.getByRole('button', { name: 'Unpublished' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...query, published: false })

    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    expect(screen.queryByRole('button', { name: 'Failed' })).toBeNull()
  })

  it('offers Clear only while something is set, and Clear empties the box too', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    rerender(<ListFilters query={{ ...EMPTY_QUERY, q: 'veil' }} onChange={onChange} label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' }) as HTMLInputElement
    expect(box.value).toBe('veil')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_QUERY)
    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    expect(box.value).toBe('')
  })

  it('follows a query changed from outside (back button) without echoing it back', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search images" />)
    rerender(<ListFilters query={{ ...EMPTY_QUERY, q: 'orion' }} onChange={onChange} label="Search images" />)
    const box = screen.getByRole('searchbox', { name: 'Search images' }) as HTMLInputElement
    expect(box.value).toBe('orion')
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onChange).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/ListFilters.test.tsx`
Expected: FAIL, cannot resolve `./ListFilters`.

- [ ] **Step 3: Write the component**

`frontend/src/pages/ListFilters.tsx`:

```tsx
import { useEffect, useRef } from 'react'
import { EMPTY_QUERY, isFiltered, type ListQuery, type ListStatus } from './listQuery'

/** How long typing pauses before the search runs and lands in the URL. */
export const SEARCH_DEBOUNCE_MS = 250

const STATUS_CHIPS: readonly [ListStatus, string][] = [
  ['solving', 'Solving'],
  ['failed', 'Failed'],
  ['solved', 'Solved'],
]
const PUBLISHED_CHIPS: readonly [boolean, string][] = [
  [true, 'Published'],
  [false, 'Unpublished'],
]

/** The search box and filter chips above a list (SPEC § 5.5). The page owns the query (it
 *  lives in the URL); this only reports changes: the box after a short pause, a chip at once,
 *  Clear with the empty query. Within a group one chip is pressed at most, and pressing it
 *  again clears it. The owner's page gets the status and visibility groups; the gallery none. */
export default function ListFilters({
  query,
  onChange,
  owner = false,
  label,
}: {
  query: ListQuery
  onChange: (next: ListQuery) => void
  owner?: boolean
  label: string
}) {
  // Uncontrolled, as the Objects tab's box is (#90): the DOM owns the text while the owner
  // types, and the query only writes it back when it changed elsewhere (Clear, back button).
  const box = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (box.current && box.current.value.trim() !== query.q) box.current.value = query.q
  }, [query.q])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function typed(value: string) {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onChange({ ...query, q: value.trim() }), SEARCH_DEBOUNCE_MS)
  }

  return (
    <div className="list-filters" role="search">
      <input
        ref={box}
        type="search"
        aria-label={label}
        placeholder={label}
        defaultValue={query.q}
        onChange={(e) => typed(e.target.value)}
      />
      {owner && (
        <>
          <div className="chips" aria-label="Solve status">
            {STATUS_CHIPS.map(([value, text]) => (
              <Chip
                key={value}
                pressed={query.status === value}
                onClick={() => onChange({ ...query, status: query.status === value ? null : value })}
              >
                {text}
              </Chip>
            ))}
          </div>
          <div className="chips" aria-label="Visibility">
            {PUBLISHED_CHIPS.map(([value, text]) => (
              <Chip
                key={text}
                pressed={query.published === value}
                onClick={() => onChange({ ...query, published: query.published === value ? null : value })}
              >
                {text}
              </Chip>
            ))}
          </div>
        </>
      )}
      {isFiltered(query) && (
        <button type="button" className="secondary" onClick={() => onChange(EMPTY_QUERY)}>
          Clear
        </button>
      )}
    </div>
  )
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  )
}
```

Note on the "from outside" test: the sync effect writes the box, and a programmatic `value =` fires no React `onChange`, so nothing is echoed. The debounce closure captures `query` at typing time; a chip pressed during the 250 ms is overwritten by the pending search's `{...query}`. That is acceptable for a quarter second; do not add state to fix it.

In `frontend/src/styles.css`, change the input rule on line 36 to include search boxes, and add the layout rule after `.chip[aria-pressed='true']`:

```css
input[type='text'], input[type='search'], input[type='number'], input[type='password'], select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem 0.65rem; font: inherit; }
```

```css
.list-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin-bottom: 1rem; }
.list-filters input[type='search'] { flex: 1 1 14rem; min-width: 0; }
.list-filters .chips { gap: 0.35rem; }
```

Check there is a `button.secondary` style already (`grep -n "secondary" frontend/src/styles.css`); `ShowMore` uses `a.button.secondary`, so a `button.secondary` rule should exist. If only `a.button.secondary` exists, widen that selector to `button.secondary, a.button.secondary`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/ListFilters.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint, then commit**

Run: `make lint`
Expected: clean (watch for react-hooks/exhaustive-deps on the sync effect: `query.q` is the only dep used).

```bash
git add frontend/src/pages/ListFilters.tsx frontend/src/pages/ListFilters.test.tsx frontend/src/styles.css
git commit -m "feat: ListFilters: the search box and the owner's status and visibility chips (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Show more carries the filters

**Files:**
- Modify: `frontend/src/pages/ShowMore.tsx`
- Test: `frontend/src/pages/ShowMore.test.tsx`

**Interfaces:**
- Consumes: `pageHref`, `EMPTY_QUERY`, `ListQuery` from Task 3.
- Produces: `ShowMore` gains an optional prop `query?: ListQuery` (default `EMPTY_QUERY`); the link's `href` is `pageHref(query, next)`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/pages/ShowMore.test.tsx` inside the `describe`:

```tsx
  it('keeps the search and filters in the link so a followed page stays in the result set', () => {
    render(
      <ShowMore next="img-9" busy={false} error={null} onMore={() => {}} query={{ q: 'm 27', status: 'solved', published: null }} />,
    )
    expect(screen.getByRole('link', { name: 'Show more' }).getAttribute('href')).toBe('?q=m%2027&status=solved&before=img-9')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/pages/ShowMore.test.tsx`
Expected: FAIL: tsc/vitest complains about the unknown `query` prop, or the href is `?before=img-9`.

- [ ] **Step 3: Add the prop**

`frontend/src/pages/ShowMore.tsx`:

```tsx
import { EMPTY_QUERY, pageHref, type ListQuery } from './listQuery'

/** The pager (SPEC § 5.5, § 8): one "Show more" that appends the next page. A real link to
 *  `?…&before=<id>` carrying the current search and filters, so a crawler that runs the app
 *  can follow the chain inside the result set, while a click is handled here and never leaves
 *  the page. Nothing on the last page. */
export default function ShowMore({
  next,
  busy,
  error,
  onMore,
  query = EMPTY_QUERY,
}: {
  next: string | null
  busy: boolean
  error: string | null
  onMore: () => void
  query?: ListQuery
}) {
  if (next === null) return null
  return (
    <p className="show-more">
      <a
        className="button secondary"
        href={pageHref(query, next)}
        aria-disabled={busy}
        onClick={(e) => {
          e.preventDefault()
          if (!busy) onMore()
        }}
      >
        {busy ? 'Loading…' : 'Show more'}
      </a>
      {error && <span className="error">{error}</span>}
    </p>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/ShowMore.test.tsx`
Expected: PASS, including the existing `?before=img%209` case.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/ShowMore.tsx frontend/src/pages/ShowMore.test.tsx
git commit -m "feat: Show more carries the search and filters in its link (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The gallery page searches

**Files:**
- Modify: `frontend/src/pages/GalleryPage.tsx`
- Test: `frontend/src/pages/GalleryPage.test.tsx`

**Interfaces:**
- Consumes: `ListFilters` (Task 4), `readListQuery`, `writeListQuery`, `toPageQuery`, `isFiltered` (Task 3), `ShowMore` with `query` (Task 5).
- Produces: `/gallery?q=…` shows the matching published images; typing writes `q` into the URL with history replace after the debounce and drops `before`; "Nothing matches." when a search is active and empty.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('GalleryPage', …)` block in `frontend/src/pages/GalleryPage.test.tsx`. `act` must be added to the Testing Library import, `SEARCH_DEBOUNCE_MS` imported from `./ListFilters`, and a `useLocation` probe helps assert the URL:

```tsx
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { SEARCH_DEBOUNCE_MS } from './ListFilters'

/** Renders the page at `path` with the current URL search echoed into the DOM. */
function Url() {
  return <output data-testid="url">{useLocation().search}</output>
}
```

```tsx
  it('searches from the URL and shows the no-match sentence with a way out', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?q=veil']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Nothing matches.')).toBeTruthy()
    expect(api.gallery).toHaveBeenCalledWith({ q: 'veil', before: null })
    expect((screen.getByRole('searchbox', { name: 'Search the gallery' }) as HTMLInputElement).value).toBe('veil')
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
    expect(screen.queryByText('Nothing published yet.')).toBeNull()
  })

  it('writes a typed search into the URL after a pause and fetches the first page of it', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.gallery)
        .mockResolvedValueOnce({ items: [item], next: 'img-1' })
        .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
      render(
        <MemoryRouter initialEntries={['/gallery?before=img-7']}>
          <GalleryPage health={health()} />
          <Url />
        </MemoryRouter>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('link', { name: /Orion/ })).toBeTruthy()
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search the gallery' }), { target: { value: 'andromeda' } })
      expect(api.gallery).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
      // The cursor is gone from the URL: the search starts from the top of its own result set.
      expect(screen.getByTestId('url').textContent).toBe('?q=andromeda')
      expect(api.gallery).toHaveBeenLastCalledWith({ q: 'andromeda', before: null })
      expect(screen.getByRole('link', { name: /Andromeda/ })).toBeTruthy()
      expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries the search in the Show more link', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: 'img-1' })
    render(
      <MemoryRouter initialEntries={['/gallery?q=orion']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    const more = await screen.findByRole('link', { name: 'Show more' })
    expect(more.getAttribute('href')).toBe('?q=orion&before=img-1')
    fireEvent.click(more)
    expect(api.gallery).toHaveBeenLastCalledWith({ q: 'orion', before: 'img-1' })
  })

  it('drops the answer of a search the visitor has already moved on from', async () => {
    let answerSlow: (page: { items: GalleryItem[]; next: null }) => void = () => {}
    vi.mocked(api.gallery)
      .mockImplementationOnce(() => new Promise((resolve) => { answerSlow = resolve }))
      .mockResolvedValueOnce({ items: [{ ...item, id: 'img-3', title: 'Andromeda' }], next: null })
    const { rerender } = render(
      <MemoryRouter key="slow" initialEntries={['/gallery?q=slow']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    // The URL moves on (a second search) before the first answers. A new `key` remounts the
    // router: `initialEntries` is read once, so a plain rerender would keep the old URL.
    rerender(
      <MemoryRouter key="andromeda" initialEntries={['/gallery?q=andromeda']}>
        <GalleryPage health={health()} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: /Andromeda/ })).toBeTruthy()
    await act(async () => { answerSlow({ items: [item], next: null }) })
    expect(screen.queryByRole('link', { name: /Orion/ })).toBeNull()
  })
```

(`GalleryItem` must be added to the type import from `../api`.) The last test remounts a fresh router by `key`, which is the simplest way to change the URL from outside; the cancelled flag of the unmounted effect is what the assertion pins.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/GalleryPage.test.tsx`
Expected: the four new cases FAIL (no searchbox, `toHaveBeenCalledWith({ q: 'veil', before: null })` not satisfied).

- [ ] **Step 3: Wire the page**

Replace `frontend/src/pages/GalleryPage.tsx` with:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, ApiError, describeError, type GalleryItem, type HealthOut, type PageQuery } from '../api'
import GalleryCard from './GalleryCard'
import ListFilters from './ListFilters'
import { isFiltered, readListQuery, toPageQuery, writeListQuery, type ListQuery } from './listQuery'
import ShowMore from './ShowMore'

/** The public gallery (SPEC § 5.5): published images newest first, 24 at a time with Show more,
 *  hover to see the annotations. The same page serves the owner at /gallery, so what they see is
 *  what visitors see. With the gallery switched off it never calls the API: the shell already
 *  knows. The URL holds the search (`?q=`) and a followed Show more link's `?before=`; a
 *  typed search replaces the URL (no history entry per keystroke) and drops the cursor. */
export default function GalleryPage({ health }: { health: HealthOut }) {
  const enabled = health.public_gallery_enabled
  const [params, setParams] = useSearchParams()
  const start = params.get('before')
  // `readListQuery` builds a fresh object per render; round-tripping it through one string
  // gives an identity that changes only when the query does, safe as an effect dependency.
  const queryKey = JSON.stringify(readListQuery(params))
  const query = useMemo(() => JSON.parse(queryKey) as ListQuery, [queryKey])
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })

  const page = useCallback((before: string | null): PageQuery => ({ ...toPageQuery(query), before }), [query])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api
      .gallery(page(start))
      .then((result) => {
        if (cancelled) return
        setItems(result.items)
        setNext(result.next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, start, page])

  const showMore = useCallback(async () => {
    if (next === null) return
    setMore({ busy: true, error: null })
    try {
      const result = await api.gallery(page(next))
      setItems((shown) => [...(shown ?? []), ...result.items])
      setNext(result.next)
      setMore({ busy: false, error: null })
    } catch (err) {
      // The cursor image was unpublished meanwhile: the list is stale, start it over from the
      // page the URL names, or from the top when that cursor is gone as well.
      if (err instanceof ApiError && err.status === 422) {
        const result = await api
          .gallery(page(start))
          .catch(() => (start ? api.gallery(page(null)) : null))
          .catch(() => null)
        if (result) {
          setItems(result.items)
          setNext(result.next)
          setMore({ busy: false, error: null })
          return
        }
      }
      setMore({ busy: false, error: describeError(err) })
    }
  }, [next, start, page])

  const changeQuery = useCallback(
    (nextQuery: ListQuery) => setParams(writeListQuery(params, nextQuery), { replace: true }),
    [params, setParams],
  )

  if (!enabled) {
    return (
      <section className="gallery-off">
        {!health.authenticated && <p className="meta">Nothing to see here yet.</p>}
        {health.authenticated && <p className="meta">The public gallery is switched off in Config.</p>}
      </section>
    )
  }
  return (
    <>
      <ListFilters query={query} onChange={changeQuery} label="Search the gallery" />
      {error && <p className="error">{error}</p>}
      {!error && items === null && <p className="meta">Loading…</p>}
      {!error && items !== null && items.length === 0 && (
        <p className="gallery-empty">{isFiltered(query) ? 'Nothing matches.' : 'Nothing published yet.'}</p>
      )}
      {items !== null && items.length > 0 && (
        <section className="gallery" aria-label="Gallery">
          {items.map((item) => (
            <GalleryCard
              key={item.id}
              item={item}
              plain={item.thumb_url}
              annotated={item.annotated_preview_url}
              to={`/gallery/${item.id}`}
              frame="uniform"
            >
              {item.title}
            </GalleryCard>
          ))}
        </section>
      )}
      <ShowMore next={next} busy={more.busy} error={more.error} onMore={() => void showMore()} query={query} />
    </>
  )
}
```

Two existing tests assert `api.gallery` was called with exactly `{ before: null }` / `{ before: 'img-7' }` / `{ before: 'img-1' }`; `toPageQuery(EMPTY_QUERY)` is `{}`, so those still hold. The "says when nothing is published" test still finds "Nothing published yet.". The filter bar renders above the error and the empty state, so the visitor always has the box and the Clear button.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/GalleryPage.test.tsx`
Expected: PASS, all cases old and new.

- [ ] **Step 5: Lint, then commit**

Run: `make lint`
Expected: clean. `query` is memoised on the JSON string, so `react-hooks/exhaustive-deps` is satisfied without a disable comment.

```bash
git add frontend/src/pages/GalleryPage.tsx frontend/src/pages/GalleryPage.test.tsx
git commit -m "feat: the gallery searches by title and object name from the URL (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The Images page searches and filters

**Files:**
- Modify: `frontend/src/pages/ImagesPage.tsx` (imports lines 1-22; state and callbacks lines 32-120; `listFirst` lines 196-205; render lines 156-193)
- Test: `frontend/src/pages/ImagesPage.test.tsx`

**Interfaces:**
- Consumes: `ListFilters` (Task 4), `listQuery` (Task 3), `ShowMore` with `query` (Task 5).
- Produces: `/?q=…&status=…&published=…` on the owner's page; `listFirst(count, query)`; every list fetch (first load, refresh, Show more, 422 fallback) carries the query; the busy-row poll is untouched; "No images match." when filtered and empty.

- [ ] **Step 1: Write the failing tests**

Add a second `describe` to `frontend/src/pages/ImagesPage.test.tsx`. The existing `mount()` renders at `/`; add a `mountAt(path)` and the URL probe:

```tsx
import { useLocation } from 'react-router'
import { SEARCH_DEBOUNCE_MS } from './ListFilters'

function Url() {
  return <output data-testid="url">{useLocation().search}</output>
}

function mountAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ImagesPage health={health} refreshHealth={vi.fn(async () => health)} />
      <Url />
    </MemoryRouter>,
  )
}
```

```tsx
describe('ImagesPage search and filters (#189)', () => {
  it('fetches the list the URL names and shows the no-match sentence', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?q=veil&status=failed&published=true')
    await tick(0)
    expect(api.listImages).toHaveBeenCalledWith({ q: 'veil', status: 'failed', published: true })
    expect(screen.getByText('No images match.')).toBeTruthy()
    expect(screen.queryByText(/No images yet/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Published' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a chip rewrites the URL at once and a typed search after a pause, both from the top', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?before=old-cursor')
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Solved' }))
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('?status=solved')
    expect(api.listImages).toHaveBeenLastCalledWith({ status: 'solved' })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search images' }), { target: { value: 'm 27' } })
    await tick(SEARCH_DEBOUNCE_MS)
    expect(screen.getByTestId('url').textContent).toBe('?q=m+27&status=solved')
    expect(api.listImages).toHaveBeenLastCalledWith({ q: 'm 27', status: 'solved' })
  })

  it('a refresh after a card action re-queries with the current filters', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a', { published: true })], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    vi.mocked(api.setPublished).mockResolvedValue(image('a', { published: false }))
    mountAt('/?published=true')
    await tick(0)
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }))
    await tick(0)
    const calls = vi.mocked(api.listImages).mock.calls
    expect(calls[calls.length - 1]![0]).toEqual({ limit: 24, published: true, before: null })
  })

  it('Show more carries the filters and appends inside the result set', async () => {
    vi.mocked(api.listImages)
      .mockResolvedValueOnce({ items: [image('a')], next: 'a' })
      .mockResolvedValueOnce({ items: [image('b')], next: null })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?q=orion')
    await tick(0)
    const more = screen.getByRole('link', { name: 'Show more' })
    expect(more.getAttribute('href')).toBe('?q=orion&before=a')
    fireEvent.click(more)
    await tick(0)
    expect(api.listImages).toHaveBeenLastCalledWith({ q: 'orion', before: 'a' })
    expect(titles()).toEqual(['a', 'b'])
  })
})
```

The mock block at the top of the file must also stub `setPublished`: `api: { ...real.api, listImages: vi.fn(), config: vi.fn(), image: vi.fn(), setPublished: vi.fn() }`, and `afterEach` resets it. Add `fireEvent` to the Testing Library import. Check the card's button text with `grep -n "Unpublish" frontend/src/pages/ImagesPage.tsx` and adjust the name if the button reads differently.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/ImagesPage.test.tsx`
Expected: the four new cases FAIL (no searchbox; `listImages` called with `{}`), the two poll cases still PASS.

- [ ] **Step 3: Wire the page**

In `frontend/src/pages/ImagesPage.tsx`:

Imports: add `useMemo` to the React import, `useSearchParams` beside `Link` from `react-router`, and

```tsx
import ListFilters from './ListFilters'
import { isFiltered, readListQuery, toPageQuery, writeListQuery, type ListQuery } from './listQuery'
```

At the top of the component body (before the `images` state):

```tsx
  // The search and chips live in the URL (SPEC § 5.5): linkable, and a reload keeps them.
  const [params, setParams] = useSearchParams()
  // Round-tripped through one string so `query`'s identity changes only when the query does.
  const queryKey = JSON.stringify(readListQuery(params))
  const query = useMemo(() => JSON.parse(queryKey) as ListQuery, [queryKey])
  const changeQuery = useCallback(
    (next: ListQuery) => setParams(writeListQuery(params, next), { replace: true }),
    [params, setParams],
  )
```

`refresh`: pass the query to `listFirst` and depend on `query`:

```tsx
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const [page, cfg] = await Promise.all([
        listFirst(Math.max(PAGE_LIMIT, shown.current), query),
        api.config(),
        refreshHealth(),
      ])
      ...
  }, [applyPage, refreshHealth, query])
```

The first-load effect becomes the "load the list the URL names" effect; it re-runs on every filter change, which is the search fetch:

```tsx
  useEffect(() => {
    const mine = ++seq.current
    Promise.all([api.listImages(toPageQuery(query)), api.config()])
      .then(([page, cfg]) => {
        if (mine !== seq.current) return
        applyPage(page)
        setConfig(cfg)
        setNow(Date.now())
        setError(null)
      })
      .catch((err: unknown) => {
        if (mine === seq.current) setError(pageError(err))
      })
  }, [applyPage, query])
```

`showMore`: `api.listImages({ ...toPageQuery(query), before: next })` with `query` added to the deps.

`listFirst`:

```tsx
/** The first `count` images of `query` as one page: pages of at most 100 (the server's cap)
 *  joined, so a refresh keeps every card the owner has shown. */
async function listFirst(count: number, query: ListQuery): Promise<Page<ImageOut>> {
  const items: ImageOut[] = []
  let before: string | null = null
  do {
    const page: Page<ImageOut> = await api.listImages({
      ...toPageQuery(query),
      limit: Math.min(100, count - items.length),
      before,
    })
    items.push(...page.items)
    before = page.next
  } while (before !== null && items.length < count)
  return { items, next: before }
}
```

Render: the filter bar between the upload panel and the error line, the empty state split, and `ShowMore` given the query:

```tsx
      <UploadPanel ... />
      <ListFilters query={query} onChange={changeQuery} owner label="Search images" />
      {error && <p className="error">{error}</p>}
      <section className="images">
        {images.length === 0 && !isFiltered(query) && (
          <p className="meta">No images yet. Upload a finished JPG to start.</p>
        )}
        {images.length === 0 && isFiltered(query) && <p className="meta">No images match.</p>}
        {images.map((img) => ( ... ))}
      </section>
      <ShowMore next={next} busy={more.busy} error={more.error} onMore={() => void showMore()} query={query} />
```

Note the refresh test expects `{ limit: 24, published: true, before: null }`: `paged()` in `api.ts` orders keys itself, so object key order in the call does not matter to `toEqual`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/ImagesPage.test.tsx`
Expected: PASS, all six.

- [ ] **Step 5: Run the whole frontend suite and lint, then commit**

Run: `make lint test`
Expected: clean and green (backend and frontend).

```bash
git add frontend/src/pages/ImagesPage.tsx frontend/src/pages/ImagesPage.test.tsx
git commit -m "feat: the Images page searches and filters by status and visibility from the URL (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Playwright: a visitor searches the gallery

**Files:**
- Modify: `frontend/e2e/gallery.spec.ts` (inside the visitor block, after the hover assertions around line 36 and before `await galleryCard.click()`)

**Interfaces:**
- Consumes: the built app with Tasks 1-7; the Orion fixture (title "Orion", objects "M 42", "NGC 1976", "Orion Nebula").

- [ ] **Step 1: Add the search steps**

Insert before `await galleryCard.click()`:

```ts
      // Search (SPEC § 5.5): an object name finds the card space-insensitively, the query lands
      // in the URL, nonsense says so, and the URL alone reproduces the result.
      const search = pub.getByRole('searchbox', { name: 'Search the gallery' })
      await search.fill('ngc1976')
      await expect(pub).toHaveURL(/\?q=ngc1976$/)
      await expect(galleryCard).toBeVisible()
      await search.fill('zzqq')
      await expect(pub.getByText('Nothing matches.')).toBeVisible()
      await pub.getByRole('button', { name: 'Clear' }).click()
      await expect(pub).toHaveURL(/\/$/)
      await expect(galleryCard).toBeVisible()
      await pub.goto('/gallery?q=orion%20nebula')
      await expect(pub.locator('.gallery-card', { hasText: 'Orion' })).toBeVisible()
      await expect(pub.getByRole('searchbox', { name: 'Search the gallery' })).toHaveValue('orion nebula')
      await pub.goto('/')
      await expect(galleryCard).toBeVisible()
```

(`galleryCard` is a locator, so it re-resolves after navigation.)

- [ ] **Step 2: Run the e2e suite**

Run: `make e2e`
Expected: green, including `gallery.spec.ts`. If the `toHaveURL(/\?q=ngc1976$/)` step is flaky because the debounce has not fired, it is not: `toHaveURL` polls. If "Nothing matches." never shows, check the `q` reached the API in the Playwright trace before touching the page code.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/gallery.spec.ts
git commit -m "test: the visitor searches the gallery end to end (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: SPEC and the design note

**Files:**
- Modify: `docs/SPEC.md` (§ 5.5 bullet "Gallery shows published images only…" around lines 198-208; § 8 `GET /gallery` around lines 375-384 and `GET /images` around lines 424-425)
- Modify: `docs/superpowers/specs/2026-10-15-search-and-filter-design.md` (the SQL sketch in "API and storage (PR 1)")

- [ ] **Step 1: SPEC § 5.5**

After the sentence ending "its 3-second poll re-fetches as many cards as are shown." add:

```
  A search box above both lists finds an image by its title or by any catalogue name of any
  object in it, case- and space-insensitively ("m27", "M 27" and "NGC 6960" all work); the
  owner's list adds status chips (Solving, Failed, Solved) and visibility chips (Published,
  Unpublished). The search and chips live in the URL (`/gallery?q=veil`), so a result is
  linkable and a reload keeps it, and the Show more link carries them so a followed page stays
  inside the result set; changing a filter starts again from the top. An active search with no
  result says "Nothing matches." (owner: "No images match.") next to a Clear button.
```

- [ ] **Step 2: SPEC § 8**

Change the `GET /gallery` line to `GET /gallery?limit=24&before=<id>&q=<text>` and, after "`limit` is 1–100, default 24.", add:

```
  `q` (up to 200 characters) narrows the page to images whose title or any object's catalogue
  name contains the text after case-folding and removing whitespace, on both sides; blank is no
  filter. The cursor rule is unchanged, so `before` from a searched page continues that search.
```

Change the `GET /images` line to:

```
- `GET /images?limit=24&before=<id>&q=<text>&status=<solving|failed|solved>&published=<bool>` →
  `{items: ImageOut[], next}`, paged and searched exactly like `GET /gallery`; `status=solving`
  is every row the page polls (`pending` too); the gallery accepts and ignores `status` and
  `published`, so an owner filter can never widen what a visitor sees;
  `GET /images/{id}`, `DELETE /images/{id}`
```

- [ ] **Step 3: Amend the design note's SQL**

In the spec file, replace the `REPLACE(LOWER(…)) LIKE` block and the sentence after it with:

```
The search condition is

    (instr(fold(title), ?) > 0
     OR EXISTS (SELECT 1 FROM objects o WHERE o.image_id = images.id
                AND instr(fold_names(o.catalog_names), ?) > 0))

where `fold` (Unicode case-fold, whitespace removed) and `fold_names` (`fold` of every name in
the JSON cell, newline-separated) are Python functions registered on every connection, and the
parameter is `fold(q)`. `instr`, not `LIKE`: a `%` or `_` in the query is literal, and
`str.casefold` handles a Cyrillic title where SQLite's `LOWER` would not.
```

- [ ] **Step 4: Lint and test one last time, then commit**

Run: `make lint test`
Expected: green.

```bash
git add docs/SPEC.md docs/superpowers/specs/2026-10-15-search-and-filter-design.md
git commit -m "docs: search and owner filters in SPEC § 5.5 and § 8 (#189)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Review ritual and the PR

- [ ] **Step 1:** `/code-review high` on the branch; fix what it finds; `make lint test`.
- [ ] **Step 2:** Silent-failure pass: dispatch the `pr-review-toolkit:silent-failure-hunter` agent on `git diff main...HEAD`; fix; `make lint test`.
- [ ] **Step 3:** `/simplify`; fix; `make lint test`; `make e2e`.
- [ ] **Step 4:** Restart the dev unit (`sudo systemctl restart astrocaption-dev`) and hand over for the owner's smoke test on `make dev`: search "m27" and "ngc6960" on the Images page, press each chip, reload with the URL, Show more on a long search, the same on `/gallery` signed out. Wait for the verdict.
- [ ] **Step 5:** `git push -u origin feat/189-search-filter` and `gh pr create` with title `feat: search and owner filters on the Images page and the gallery (#189)` and a body that names the spec and plan, lists the parameters, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Reference the issue (`Part of #189`, not `Closes`: PR 2 closes it). `gh pr checks --watch`. Stop when CI is green and ask for the go before merging.
