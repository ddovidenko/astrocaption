# Object kind and upload-date filters (PR 2 of #189) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter the Images page and the public gallery by the kind of object in the photo (Galaxies, Nebulae, Clusters, Stars, Other) and by the upload date (From/To), stored in the URL and carried by Show more like the search and chips PR 1 added; close #189.

**Architecture:** Schema 8 adds `objects.kind TEXT NOT NULL DEFAULT 'other'`, filled once by a Python migration step that runs `kind_of` over every stored object, and written at insert by both objects writers (`replace_objects` and `store_solve_result`) through one shared row builder. `GET /images/{id}/objects` reads the column back, so the editor's chips and the list filter can never disagree. `ListFilter` gains `kind`, `since` and `until`; `_filter_conditions` turns them into an `EXISTS` on `objects.kind` and two string compares on `created_at` (`>= since`, `< until + 1 day`), which keeps the rowid keyset cursor untouched. In the browser `ListQuery` gains the same three fields, `ListFilters` shows a kind chip group and two native `type="date"` inputs on both pages, and nothing else in the pages changes: the URL hook, `isFiltered`, the Show more href and the empty sentences all derive from `ListQuery`.

**Tech Stack:** FastAPI + stdlib sqlite3 (Python 3.13+, Pydantic `date` for the parameters), React 19 + react-router + TypeScript strict, vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-search-and-filter-design.md`, section "Object kind and date range (PR 2)", plus "Errors", "Tests" and "Documents". PR 1 (#228) is merged; this plan starts from `main` at `9a8053a` or later.

## Global Constraints

- Python 3.13+, type hints everywhere, ruff defaults, mypy; Pydantic models for every request/response (CLAUDE.md).
- TypeScript strict; function components + hooks; component tests are `*.test.tsx` beside the component with `// @vitest-environment jsdom` on line 1; assert on the DOM or the store, never on internals.
- API responses never carry server paths or raw exception text; a hand-edited bad parameter (`kind=stars`, `since=yesterday`) is a plain 422 from Pydantic.
- Public (logged-out) routes are read-only; `/api/gallery` keeps `published = 1 AND solve_status = 'solved'` first and `kind`, `since`, `until` only narrow it. It still ignores `status` and `published`.
- Page shape `{items, next}` and the cursor rule (`before` = rows inserted before that row; a deleted cursor row is 422 "That page is no longer available; reload the list.") are unchanged. Results stay newest first (rowid DESC).
- Kinds are exactly `galaxy | nebula | cluster | star | other` (`ObjectKind` in `backend/app/models.py` and `frontend/src/api.ts`); labels are the Objects tab's (`KIND_LABELS` in `frontend/src/editor/objectsFilter.ts`: Galaxies, Nebulae, Clusters, Stars, Other).
- `since` and `until` are `YYYY-MM-DD`, on `created_at` in UTC, both ends inclusive; `until` becomes a strict less-than on the following day.
- Migrations are forward only, one transaction per version, stamped with `PRAGMA user_version`; `SCHEMA_VERSION` becomes 8.
- Never call nova.astrometry.net in tests; the e2e suite runs against the fake nova and the Orion fixture (title "Orion", objects led by M 42, kind nebula; nova's `bright` rows are stars; no galaxy in the field).
- No new dependencies. Ask before adding one.
- `make lint test` green after every task; `make e2e` green at the end.
- Conventional commits; never push to `main`; branch `feat/189-kind-dates` from `main`. Never `git add -A`; stage by path. Subagents never touch `data/`.
- The PR closes #189 (`Closes #189` in its body, and nowhere in a part-1 PR).

## Review Focus

1. **`since` later than `until`** is an empty list, not an error: the owner swapped two pickers and should see "No images match." and Clear. Pinned in Task 2 (`test_list_images_date_range_is_inclusive_and_inverted_is_empty`).
2. **`until` on the upload's own day** must include an image uploaded at 23:59:59 UTC that day: the compare is `< next day`, not `<= until`. Pinned in Task 2 (same test, the `late` row).
3. **An image with no objects** (unsolved, failed, or a solve that found nothing) matches no kind, not `other`: the filter is an `EXISTS` on rows, and an absent row is no row. Pinned in Task 2 (`test_list_images_kind_needs_a_stored_object_of_that_kind`).
4. **A half-typed date in the picker** must not break the page: Chromium reports `''` for a partial entry, which reads as "no bound" until the date is complete. Pinned in Task 5 (`a cleared or half-typed date drops that bound`).
5. **A database the previous build wrote** must come up with every object classified, and the editor must report the stored kind, not a recomputed one. Pinned in Task 1 (`test_migration_from_v7_classifies_every_stored_object` and `test_objects_endpoint_reports_the_stored_kind`).

---

### Task 1: Schema 8, the stored `kind`, and the objects endpoint reading it

**Files:**
- Modify: `backend/app/models.py:59-68` (`SolveObject`), `backend/app/models.py:87-89` (`ObjectKind` docstring)
- Modify: `backend/app/db.py` (imports; `SCHEMA_VERSION`/migrations block at lines 124-164; `SCHEMA` objects table at lines 194-203; `_row_to_object` at line 369; `store_solve_result` at lines 547-555; `replace_objects` at lines 577-589)
- Modify: `backend/app/api/images.py:441-451` (`_object_out`)
- Test: `backend/tests/test_db.py`, `backend/tests/test_api.py`

**Interfaces:**
- Consumes: `kind_of(obj: SolveObject) -> ObjectKind` from `backend/app/objects.py` (stars by nova's type, catalogue rows by source, the rest by the names table). `objects.py` imports `catalog`, `models` and `wcs`, none of which import `db`, so `db` may import it.
- Produces:
  - `SolveObject.kind: ObjectKind | None = None` ("None until stored; `Database` classifies at insert and reads it back").
  - `objects.kind TEXT NOT NULL DEFAULT 'other'` column; `SCHEMA_VERSION = 8`; `MIGRATIONS[8] = (_migrate_8_classify_objects,)`.
  - `_object_rows(image_id: str, objects: Iterable[SolveObject]) -> list[tuple[object, ...]]` (module level in `db.py`), the one place an objects row is built, with `kind_of(o)` as the last value.
  - `Database.get_objects(image_id)` returns objects whose `kind` is set.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_db.py` (it already imports `SCHEMA_VERSION`, `Database`, `SolveObject`, `SolveStatus`, `Path`, `json`, and defines `_plain_image(image_id, created, published=False)` and `_with_objects(db, image_id, created, names, published=False)`):

```python
def test_migration_from_v7_classifies_every_stored_object(tmp_path: Path) -> None:
    """A database the previous build wrote has objects but no ``kind`` column. Schema 8 adds
    it and fills it from the names table and nova's type, so the kind filter and the editor's
    chips agree from the first start."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    _with_objects(
        db,
        "field",
        "2026-09-01T00:00:00Z",
        [["NGC 224", "M 31"], ["NGC 1976", "M 42"], ["NGC 1912", "M 38"], ["Foo 1"]],
    )
    with db.connect() as conn:  # rewind to the version-7 shape
        conn.execute("ALTER TABLE objects DROP COLUMN kind")
        conn.execute(
            "INSERT INTO objects (image_id, id, catalog_names, type, x, y, radius)"
            " VALUES ('field', 5, '[\"ι Ori\"]', 'bright', 1, 1, 0)"
        )
        conn.execute("PRAGMA user_version = 7")
    db.init()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        kinds = {
            row["id"]: row["kind"]
            for row in conn.execute("SELECT id, kind FROM objects WHERE image_id = 'field'")
        }
    assert kinds == {1: "galaxy", 2: "nebula", 3: "cluster", 4: "other", 5: "star"}
    db.init()  # idempotent


def test_migration_from_v7_with_no_objects_still_stamps(tmp_path: Path) -> None:
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:
        conn.execute("ALTER TABLE objects DROP COLUMN kind")
        conn.execute("PRAGMA user_version = 7")
    db.init()
    with db.connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert "kind" in {row["name"] for row in conn.execute("PRAGMA table_info(objects)")}


def test_replace_objects_stores_the_kind_and_get_objects_reads_it(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("a", "2026-09-01T00:00:00Z"))
    db.replace_objects(
        "a",
        [
            SolveObject(id=1, catalog_names=["NGC 224"], type="ngc", x=1.0, y=1.0, radius=1),
            SolveObject(id=2, catalog_names=["ι Ori"], type="bright", x=1.0, y=1.0, radius=0),
            SolveObject(id=3, catalog_names=["LDN 1"], type="ldn", x=1.0, y=1.0, radius=1),
        ],
    )
    assert [o.kind for o in db.get_objects("a")] == ["galaxy", "star", "nebula"]
    # The stored object is the one the Objects tab and the kind filter share.
    with db.connect() as conn:
        rows = conn.execute("SELECT id, kind FROM objects WHERE image_id = 'a' ORDER BY id")
        assert [(r["id"], r["kind"]) for r in rows] == [(1, "galaxy"), (2, "star"), (3, "nebula")]


def test_store_solve_result_stores_the_kind(settings: Settings) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db, "solved")
    ann = Annotations(image_id=rec.id, style=StyleConfig(), labels=[], version=1)
    ok = db.store_solve_result(
        rec.id,
        [SolveObject(id=1, catalog_names=["NGC 1976", "M 42"], type="ngc", x=1.0, y=1.0, radius=1)],
        ann,
        {"solve_status": SolveStatus.SOLVED},
    )
    assert ok
    assert [o.kind for o in db.get_objects(rec.id)] == ["nebula"]
```

`store_solve_result(image_id, objects, ann, fields)` is the signature at `backend/app/db.py:524`; `Annotations(image_id=, style=StyleConfig(), labels=[], version=1)` is how `test_db.py` line 252 builds one, and `Settings`, `seed_image`, `Annotations` and `StyleConfig` are already imported there.

Append to `backend/tests/test_api.py` (it already imports `Database`, `Settings`, `Path`, `TestClient`, and `upload`, `wait_for_status`, `list_ids` come from `tests.conftest`; check the `from tests.conftest import` line and add `list_ids` if it is missing):

```python
def test_objects_endpoint_reports_the_stored_kind(
    client: TestClient, sample_jpeg: Path, settings: Settings
) -> None:
    """The editor's chips read the column the kind filter uses, so the two cannot disagree. A
    kind changed in the database (a names-table update applied by a later backfill) is what the
    endpoint reports, not a recomputation."""
    image_id = upload(client, sample_jpeg)["id"]
    assert wait_for_status(client, image_id, {"solved", "failed"})["solve_status"] == "solved"
    objects = client.get(f"/api/images/{image_id}/objects").json()
    assert objects[0]["kind"] == "nebula"  # M 42, from the column
    with Database(settings.db_path).connect() as conn:
        conn.execute("UPDATE objects SET kind = 'cluster' WHERE image_id = ? AND id = 1", (image_id,))
    assert client.get(f"/api/images/{image_id}/objects").json()[0]["kind"] == "cluster"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_db.py -k "v7 or stores_the_kind" tests/test_api.py -k "stored_kind" -v`
Expected: FAIL. The migration tests fail on `ALTER TABLE objects DROP COLUMN kind` ("no such column: kind"); the kind tests fail with `AttributeError: 'SolveObject' object has no attribute 'kind'` or `[None, None, None] != [...]`; the API test fails on `no such column: kind`.

- [ ] **Step 3: Add `kind` to `SolveObject`**

In `backend/app/models.py`, `SolveObject` (line 59):

```python
class SolveObject(BaseModel):
    """One catalogued object nova found in the field, in original pixels."""

    id: int
    catalog_names: list[str] = Field(min_length=1)
    type: str
    x: float
    y: float
    radius: float = 0.0
    #: The Objects-tab bucket. None until stored: ``Database`` classifies at insert (schema 8)
    #: and reads it back, so the editor's chips and the list's kind filter share one answer.
    kind: ObjectKind | None = None
```

`ObjectKind` is defined below `SolveObject` in the file (line 87). Pydantic resolves the forward reference because the module has `from __future__ import annotations`; if it does not, move the `ObjectKind = Literal[...]` line above `SolveObject`. Update `ObjectKind`'s docstring: replace "computed at read time from OpenNGC's type (see ``app.catalog.kind_for``) and nova's object type" with "stored per object at insert (``objects.kind``, schema 8) from OpenNGC's type (see ``app.catalog.kind_for``) and nova's object type". Update `ObjectOut.kind`'s comment (line 548) the same way: "the stored Objects-tab bucket (schema 8): nova's ``bright``/``hd`` rows are ``star``, rows OpenNGC classifies take its kind, everything else is ``other``".

- [ ] **Step 4: Schema 8 in `db.py`**

Imports: add `from .objects import kind_of` beside the other relative imports. Run `cd backend && .venv/bin/python -c "import app.db"` once; a circular import would surface here.

Replace `SCHEMA_VERSION = 7` with `SCHEMA_VERSION = 8` and add, after `_migrate_7_rehash_current_exports`:

```python
def _migrate_8_classify_objects(conn: sqlite3.Connection) -> None:
    """Schema 8 stores each object's Objects-tab kind (#189) so the list can filter on it. The
    column defaults to ``other``; every existing row is classified once, by the same rule the
    insert path uses."""
    conn.execute("ALTER TABLE objects ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'")
    rows = conn.execute("SELECT image_id, id, catalog_names, type FROM objects").fetchall()
    conn.executemany(
        "UPDATE objects SET kind = ? WHERE image_id = ? AND id = ?",
        [
            (
                kind_of(
                    SolveObject(
                        id=r["id"],
                        catalog_names=json.loads(r["catalog_names"]),
                        type=r["type"],
                        x=0.0,
                        y=0.0,
                    )
                ),
                r["image_id"],
                r["id"],
            )
            for r in rows
        ],
    )
```

Add to `MIGRATIONS`:

```python
    # 8: each object's kind is stored (#189), so the list filter and the editor's chips agree.
    8: (_migrate_8_classify_objects,),
```

In `SCHEMA`, the objects table, add `kind` after `radius`:

```sql
    radius        REAL NOT NULL DEFAULT 0,
    kind          TEXT NOT NULL DEFAULT 'other',
    PRIMARY KEY (image_id, id)
```

Add one row builder at module level, next to `_row_to_object`:

```python
#: The objects table's insert, shared by the solve's write and ``replace_objects``.
_INSERT_OBJECT = (
    "INSERT INTO objects (image_id, id, catalog_names, type, x, y, radius, kind)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
)


def _object_rows(image_id: str, objects: Iterable[SolveObject]) -> list[tuple[object, ...]]:
    """One parameter tuple per object for ``_INSERT_OBJECT``; the kind is classified here, at
    the only place a row is written, whatever the caller's ``kind`` says."""
    return [
        (image_id, o.id, json.dumps(o.catalog_names), o.type, o.x, o.y, o.radius, kind_of(o))
        for o in objects
    ]
```

(`Iterable` is already imported from `collections.abc` for `hash_of`; check the import line.)

Replace the two inserts. In `store_solve_result` (line 548):

```python
                conn.executemany(_INSERT_OBJECT, _object_rows(image_id, objects))
```

In `replace_objects` (line 581):

```python
            conn.executemany(_INSERT_OBJECT, _object_rows(image_id, objects))
```

`_row_to_object` reads the column:

```python
def _row_to_object(row: sqlite3.Row) -> SolveObject:
    return SolveObject(
        id=row["id"],
        catalog_names=json.loads(row["catalog_names"]),
        type=row["type"],
        x=row["x"],
        y=row["y"],
        radius=row["radius"],
        kind=row["kind"],
    )
```

- [ ] **Step 5: The objects endpoint reads the stored kind**

In `backend/app/api/images.py`, `_object_out`:

```python
def _object_out(o: SolveObject, preference: NamePreference) -> ObjectOut:
    return ObjectOut(
        id=o.id,
        catalog_names=o.catalog_names,
        primary_name=o.primary_name_for(preference),
        type=o.type,
        # Stored at insert (schema 8) so the list's kind filter reports the same bucket; an
        # object that never went through the database (none reaches here) is classified now.
        kind=o.kind if o.kind is not None else kind_of(o),
        x=o.x,
        y=o.y,
        radius=o.radius,
    )
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_db.py tests/test_api.py tests/test_objects.py tests/test_catalog_backfill.py -q`
Expected: all pass. If `test_migration_from_v1_adds_hints_column` or the other rewind tests fail with "no such column: kind" when they rebuild, they do not touch the objects table and should not; read the failure before changing anything.

- [ ] **Step 7: Lint and commit**

Run: `make lint`
Expected: clean.

```bash
git add backend/app/models.py backend/app/db.py backend/app/api/images.py backend/tests/test_db.py backend/tests/test_api.py
git commit -m "feat: store each object's kind (schema 8) and read it back in the editor (#189)"
```

---

### Task 2: `ListFilter.kind`, `since`, `until` in storage

**Files:**
- Modify: `backend/app/db.py:50-121` (`ListFilter`, `_filter_conditions`)
- Test: `backend/tests/test_db.py`

**Interfaces:**
- Consumes: `ObjectKind` from `.models`; `objects.kind` from Task 1.
- Produces:
  - `ListFilter.kind: ObjectKind | None = None`, `ListFilter.since: date | None = None`, `ListFilter.until: date | None = None` (`datetime.date`).
  - `_filter_conditions` emits, in order after the PR 1 conditions: `EXISTS (SELECT 1 FROM objects o WHERE o.image_id = images.id AND o.kind = ?)`, `created_at >= ?` (`since.isoformat()`), `created_at < ?` (`(until + timedelta(days=1)).isoformat()`).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_db.py` (add `from datetime import date` to its imports; `_ids(db, **filter)` already builds a `ListFilter` from keyword arguments):

```python
def test_list_images_kind_needs_a_stored_object_of_that_kind(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "andromeda", "2026-09-01T00:00:00Z", [["NGC 224", "M 31"], ["ι Ori"]])
    _with_objects(db, "orion", "2026-09-02T00:00:00Z", [["NGC 1976", "M 42"]])
    _with_objects(db, "unknown", "2026-09-03T00:00:00Z", [["Foo 1"]])
    db.insert_image(_plain_image("no-objects", "2026-09-04T00:00:00Z"))
    assert _ids(db, kind="galaxy") == ["andromeda"]
    assert _ids(db, kind="nebula") == ["orion"]
    assert _ids(db, kind="star") == ["andromeda"]  # nova's `bright` rows are stars
    assert _ids(db, kind="other") == ["unknown"]  # a stored row of kind other, not "no row"
    assert _ids(db, kind="cluster") == []
    # Independent of the search: a nebula whose names contain "m 4".
    assert _ids(db, kind="nebula", q="m 4") == ["orion"]
    assert _ids(db, kind="galaxy", q="m 4") == []


def test_list_images_date_range_is_inclusive_and_inverted_is_empty(tmp_path: Path) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    db.insert_image(_plain_image("before", "2026-09-30T23:59:59+00:00"))
    db.insert_image(_plain_image("first", "2026-10-01T00:00:00+00:00"))
    db.insert_image(_plain_image("late", "2026-10-02T23:59:59+00:00"))
    db.insert_image(_plain_image("after", "2026-10-03T00:00:00+00:00"))
    assert _ids(db, since=date(2026, 10, 1)) == ["after", "late", "first"]
    assert _ids(db, until=date(2026, 10, 2)) == ["late", "first", "before"]
    # Both ends inclusive, to the last second of the `until` day.
    assert _ids(db, since=date(2026, 10, 1), until=date(2026, 10, 2)) == ["late", "first"]
    assert _ids(db, since=date(2026, 10, 2), until=date(2026, 10, 2)) == ["late"]
    # Swapped pickers are an empty list, not an error.
    assert _ids(db, since=date(2026, 10, 3), until=date(2026, 10, 1)) == []
    # The stamp's spelling of UTC does not matter: "Z" sorts after any digit too.
    db.insert_image(_plain_image("zulu", "2026-10-02T12:00:00Z"))
    assert _ids(db, since=date(2026, 10, 2), until=date(2026, 10, 2)) == ["zulu", "late"]


def test_list_published_images_narrows_by_kind_and_date_inside_the_gallery_rows(
    tmp_path: Path,
) -> None:
    db = Database(tmp_path / "t.sqlite")
    db.init()
    _with_objects(db, "m31-unpub", "2026-10-01T00:00:00Z", [["NGC 224"]])
    _with_objects(db, "m31-pub", "2026-10-02T00:00:00Z", [["NGC 224"]], True)
    _with_objects(db, "m42-pub", "2026-10-03T00:00:00Z", [["NGC 1976"]], True)
    gallery = lambda **f: [r.id for r in db.list_published_images(filter=ListFilter(**f)).items]  # type: ignore[arg-type]  # noqa: E731
    assert gallery(kind="galaxy") == ["m31-pub"]
    assert gallery(since=date(2026, 10, 3)) == ["m42-pub"]
    assert gallery(kind="galaxy", until=date(2026, 10, 1)) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_db.py -k "kind_needs or date_range or narrows_by_kind" -v`
Expected: FAIL with `TypeError: ListFilter.__init__() got an unexpected keyword argument 'kind'` (and `since`).

- [ ] **Step 3: Extend `ListFilter` and `_filter_conditions`**

In `backend/app/db.py`, add `from datetime import date, timedelta` to the imports and `ObjectKind` to the `.models` import. `ListFilter` becomes:

```python
@dataclass(frozen=True)
class ListFilter:
    """What narrows a paged list (SPEC § 8). An empty ``q`` and None filters mean "everything";
    the gallery endpoint declares only the public fields (``q``, ``kind``, ``since``, ``until``)
    and never sets the owner's two. ``since`` and ``until`` are upload days in UTC, both
    inclusive."""

    q: str = ""
    status: ListStatus | None = None
    published: bool | None = None
    kind: ObjectKind | None = None
    since: date | None = None
    until: date | None = None
```

Add below `_SEARCH_CONDITION`:

```python
#: An image with at least one stored object of the kind (schema 8); none at all matches nothing.
_KIND_CONDITION = "EXISTS (SELECT 1 FROM objects o WHERE o.image_id = images.id AND o.kind = ?)"
```

Extend `_filter_conditions` after the `published` branch:

```python
    if filter.kind is not None:
        conds.append(_KIND_CONDITION)
        values.append(filter.kind)
    # created_at is an ISO stamp that starts with the day, so a plain string compare against
    # "YYYY-MM-DD" bounds it; `until` is inclusive, hence "< the next day". Ordering stays on
    # rowid (#214), these only select.
    if filter.since is not None:
        conds.append("created_at >= ?")
        values.append(filter.since.isoformat())
    if filter.until is not None:
        conds.append("created_at < ?")
        values.append((filter.until + timedelta(days=1)).isoformat())
    return conds, values
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_db.py -q`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

Run: `make lint`
Expected: clean (if ruff objects to the `lambda` assignment despite the `noqa`, turn `gallery` into a nested `def`).

```bash
git add backend/app/db.py backend/tests/test_db.py
git commit -m "feat: ListFilter narrows by object kind and upload-date range (#189)"
```

---

### Task 3: `kind`, `since`, `until` on both list endpoints

**Files:**
- Modify: `backend/app/api/images.py:333-357` (parameter aliases and `list_images`)
- Modify: `backend/app/api/gallery.py:74-85` (`list_gallery`)
- Test: `backend/tests/test_api.py`, `backend/tests/test_gallery.py`

**Interfaces:**
- Consumes: `ListFilter(kind=, since=, until=)` from Task 2.
- Produces: `KindParam = Annotated[ObjectKind | None, Query()]`, `DateParam = Annotated[date | None, Query()]` in `api/images.py`, imported by `api/gallery.py` as `QParam` already is. Both endpoints take `kind`, `since`, `until`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_api.py` (helpers: `upload`, `wait_for_status`, `list_ids` from `tests.conftest`; `client` is signed in):

```python
def test_list_images_filters_by_kind_and_upload_day(client: TestClient, sample_jpeg: Path) -> None:
    image_id = upload(client, sample_jpeg)["id"]
    assert wait_for_status(client, image_id, {"solved", "failed"})["solve_status"] == "solved"
    created = client.get(f"/api/images/{image_id}").json()["created_at"][:10]  # the UTC day

    def ids(**params: object) -> list[str]:
        return list_ids(client, "/api/images", **params)

    assert ids(kind="nebula") == [image_id]  # M 42
    assert ids(kind="star") == [image_id]  # nova's bright rows
    assert ids(kind="galaxy") == []
    assert ids(since=created, until=created) == [image_id]
    assert ids(until="2000-01-01") == []
    assert ids(since="2999-01-01") == []
    assert ids(kind="nebula", q="orion", since=created) == [image_id]
    for bad in ({"kind": "stars"}, {"since": "yesterday"}, {"until": "2026-13-01"}, {"since": "16/10/2026"}):
        resp = client.get("/api/images", params=bad)
        assert resp.status_code == 422, bad
        assert "Traceback" not in resp.text and "/home/" not in resp.text
```

Append to `backend/tests/test_gallery.py` (helpers `published_image`, `exported_image`, `list_ids` as the PR 1 test above it uses them):

```python
def test_gallery_filters_by_kind_and_upload_day(
    client: TestClient, anon_client: TestClient, sample_jpeg: Path
) -> None:
    published = published_image(client, sample_jpeg)
    exported_image(client, sample_jpeg)  # unpublished: never listed, whatever the filter
    created = published["created_at"][:10]

    def ids(**params: object) -> list[str]:
        return list_ids(anon_client, "/api/gallery", **params)

    assert ids(kind="nebula") == [published["id"]]
    assert ids(kind="galaxy") == []
    assert ids(since=created, until=created) == [published["id"]]
    assert ids(until="2000-01-01") == []
    assert anon_client.get("/api/gallery", params={"kind": "planet"}).status_code == 422
    assert anon_client.get("/api/gallery", params={"since": "soon"}).status_code == 422
```

`published_image` returns the `ImageOut` body (`test_gallery.py:87`), which carries `created_at`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_api.py tests/test_gallery.py -k "kind_and_upload_day" -v`
Expected: FAIL: `ids(kind="galaxy")` returns the image (the parameter is ignored), and the 422 assertions fail with 200.

- [ ] **Step 3: Declare the parameters**

In `backend/app/api/images.py`, add `from datetime import date` and `ObjectKind` to the `..models` import, then after `PublishedParam`:

```python
#: Public filters (SPEC § 8): an object kind stored at insert, and upload days in UTC.
KindParam = Annotated[ObjectKind | None, Query()]
DateParam = Annotated[date | None, Query()]
```

`list_images`:

```python
@router.get("")
async def list_images(
    settings: SettingsDep,
    db: DbDep,
    limit: LimitParam = PAGE_LIMIT,
    before: BeforeParam = None,
    q: QParam = "",
    status_filter: StatusParam = None,
    published: PublishedParam = None,
    kind: KindParam = None,
    since: DateParam = None,
    until: DateParam = None,
) -> Page[ImageOut]:
    try:
        page = db.list_images(
            limit,
            before,
            ListFilter(
                q=q, status=status_filter, published=published, kind=kind, since=since, until=until
            ),
        )
```

In `backend/app/api/gallery.py`, extend the import from `.images` with `DateParam, KindParam`, then:

```python
@router.get("")
async def list_gallery(
    settings: SettingsDep,
    db: DbDep,
    limit: LimitParam = PAGE_LIMIT,
    before: BeforeParam = None,
    q: QParam = "",
    kind: KindParam = None,
    since: DateParam = None,
    until: DateParam = None,
) -> Page[GalleryItem]:
    try:
        page = db.list_published_images(
            limit, before, ListFilter(q=q, kind=kind, since=since, until=until)
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_api.py tests/test_gallery.py -q`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

Run: `make lint`
Expected: clean.

```bash
git add backend/app/api/images.py backend/app/api/gallery.py backend/tests/test_api.py backend/tests/test_gallery.py
git commit -m "feat: kind, since and until on the images and gallery list endpoints (#189)"
```

---

### Task 4: `ListQuery` and `PageQuery` carry kind and dates

**Files:**
- Modify: `frontend/src/api.ts:235-253` (`PageQuery`, `paged`)
- Modify: `frontend/src/pages/listQuery.ts`
- Test: `frontend/src/pages/listQuery.test.ts`

**Interfaces:**
- Consumes: `ObjectKind` from `../api`; `KINDS` from `../editor/objectsFilter`.
- Produces:
  - `PageQuery.kind?: ObjectKind`, `PageQuery.since?: string`, `PageQuery.until?: string` (`YYYY-MM-DD`), written by `paged` in the order `q, status, published, kind, since, until, before`.
  - `ListQuery.kind: ObjectKind | null`, `ListQuery.since: string | null`, `ListQuery.until: string | null`; `EMPTY_QUERY` has all three null; `readListQuery` accepts a kind only from `KINDS` and a date only matching `/^\d{4}-\d{2}-\d{2}$/`; `writeListQuery`/`pageHref` spell the keys in the order `q, status, published, kind, since, until`; `toPageQuery` passes the three through; `isFiltered` is true when any is set.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/pages/listQuery.test.ts`, replace the two `readListQuery` tests and the `toPageQuery` test with these, and add the new `writeListQuery` case:

```ts
describe('readListQuery', () => {
  it('reads every filter from the URL and trims the text', () => {
    const q = readListQuery(new URLSearchParams('q=%20veil%20&status=failed&published=true&kind=nebula&since=2026-10-01&until=2026-10-31'))
    expect(q).toEqual({ q: 'veil', status: 'failed', published: true, kind: 'nebula', since: '2026-10-01', until: '2026-10-31' })
  })

  it('reads an empty URL as the empty query and ignores unknown values', () => {
    expect(readListQuery(new URLSearchParams(''))).toEqual(EMPTY_QUERY)
    expect(readListQuery(new URLSearchParams('status=weird&published=maybe&kind=planet&since=yesterday&until=2026-1-1'))).toEqual(EMPTY_QUERY)
  })
})
```

```ts
  it('spells every filter in one fixed order', () => {
    const out = writeListQuery(new URLSearchParams('until=2026-10-31&kind=galaxy'), { q: '', status: null, published: null, kind: 'galaxy', since: '2026-10-01', until: '2026-10-31' })
    expect(out.toString()).toBe('kind=galaxy&since=2026-10-01&until=2026-10-31')
  })
```

```ts
describe('toPageQuery', () => {
  it('omits everything unset, including a blank q', () => {
    expect(toPageQuery(EMPTY_QUERY)).toEqual({})
    expect(toPageQuery({ ...EMPTY_QUERY, q: '  ' })).toEqual({})
    expect(toPageQuery({ q: 'veil', status: 'solving', published: true, kind: 'star', since: '2026-10-01', until: null })).toEqual({
      q: 'veil',
      status: 'solving',
      published: true,
      kind: 'star',
      since: '2026-10-01',
    })
  })
})
```

In the `isFiltered` test add `expect(isFiltered({ ...EMPTY_QUERY, until: '2026-10-31' })).toBe(true)`. In the `pageHref` test change the second expectation's input to `{ ...EMPTY_QUERY, q: 'm 27', status: 'failed', kind: 'nebula' }` and the expected href to `'?q=m+27&status=failed&kind=nebula&before=img-9'`.

Every other object literal of type `ListQuery` in the test file (`{ q: 'm 27', status: 'solved', published: false }` and the like) must gain the three fields: write them as `{ ...EMPTY_QUERY, q: 'm 27', status: 'solved', published: false }`. `tsc` will list each one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/listQuery.test.ts`
Expected: FAIL on the first `readListQuery` test (`kind`, `since`, `until` missing from the result) and the fixed-order test (`kind=galaxy` kept from the input, nothing else written).

- [ ] **Step 3: Extend `PageQuery` and `paged`**

In `frontend/src/api.ts`:

```ts
export interface PageQuery {
  limit?: number
  before?: string | null
  /** The search box (SPEC § 8): title or any object name, case- and space-insensitive. */
  q?: string
  status?: ListStatus
  published?: boolean
  /** An image with at least one object of this kind (SPEC § 8). */
  kind?: ObjectKind
  /** Upload days in UTC, `YYYY-MM-DD`, both inclusive. */
  since?: string
  until?: string
}

function paged(path: string, { limit, before, q, status, published, kind, since, until }: PageQuery): string {
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (q) params.set('q', q)
  if (status) params.set('status', status)
  if (published !== undefined) params.set('published', String(published))
  if (kind) params.set('kind', kind)
  if (since) params.set('since', since)
  if (until) params.set('until', until)
  if (before) params.set('before', before)
  const query = params.toString()
  return query ? `${path}?${query}` : path
}
```

`ObjectKind` is declared at line 116 of the same file.

- [ ] **Step 4: Extend `listQuery.ts`**

```ts
import type { ListStatus, ObjectKind, PageQuery } from '../api'
import { KINDS } from '../editor/objectsFilter'

/** The search and filters of a list page (SPEC § 5.5, § 8). The URL is its only home: both
 *  pages read it with `readListQuery` and write it back with `writeListQuery`, so a result is
 *  linkable and a reload lands on the same list. `since` and `until` are upload days in UTC,
 *  `YYYY-MM-DD`, as the API and a native date input both spell them. */
export interface ListQuery {
  q: string
  status: ListStatus | null
  published: boolean | null
  kind: ObjectKind | null
  since: string | null
  until: string | null
}

export const EMPTY_QUERY: ListQuery = { q: '', status: null, published: null, kind: null, since: null, until: null }
```

Add beside `statusOf`/`publishedOf`:

```ts
function kindOf(value: string | null): ObjectKind | null {
  return value !== null && (KINDS as readonly string[]).includes(value) ? (value as ObjectKind) : null
}

/** A day as the API takes it; anything else (a hand-edited URL) reads as no bound. */
const DAY = /^\d{4}-\d{2}-\d{2}$/

function dayOf(value: string | null): string | null {
  return value !== null && DAY.test(value) ? value : null
}
```

`readListQuery`:

```ts
export function readListQuery(params: URLSearchParams): ListQuery {
  return {
    q: (params.get('q') ?? '').trim(),
    status: statusOf(params.get('status')),
    published: publishedOf(params.get('published')),
    kind: kindOf(params.get('kind')),
    since: dayOf(params.get('since')),
    until: dayOf(params.get('until')),
  }
}
```

`toPageQuery` gains, after the `published` line:

```ts
  if (query.kind) page.kind = query.kind
  if (query.since) page.since = query.since
  if (query.until) page.until = query.until
```

`entries` gains three rows after `published`:

```ts
    ['kind', query.kind],
    ['since', query.since],
    ['until', query.until],
```

`writeListQuery`, `isFiltered` and `pageHref` need no change: they iterate `entries`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/ && npx tsc --noEmit -p .`
Expected: `listQuery.test.ts` passes. `tsc` lists every `ListQuery` literal elsewhere that lacks the new fields (`ListFilters.test.tsx` line 32 and any in the page tests): fix each with `{ ...EMPTY_QUERY, ... }`. The page tests still pass: the pages derive everything from `ListQuery`.

- [ ] **Step 6: Lint and commit**

Run: `make lint`
Expected: clean.

```bash
git add frontend/src/api.ts frontend/src/pages/listQuery.ts frontend/src/pages/listQuery.test.ts frontend/src/pages/ListFilters.test.tsx
git commit -m "feat: the list query carries an object kind and an upload-date range (#189)"
```

(Add any other test file `tsc` made you touch to the `git add`.)

---

### Task 5: Kind chips and date inputs in `ListFilters`

**Files:**
- Modify: `frontend/src/pages/ListFilters.tsx`
- Modify: `frontend/src/styles.css:40` (input rule), `:196-197` (`.list-filters`)
- Test: `frontend/src/pages/ListFilters.test.tsx`

**Interfaces:**
- Consumes: `ListQuery`, `EMPTY_QUERY`, `isFiltered` from `./listQuery` (Task 4); `KINDS`, `KIND_LABELS` from `../editor/objectsFilter`; `Chip` from `../Chip`.
- Produces: `ListFilters` renders, for every caller, a chip group `role="group" aria-label="Object kind"` with the five kinds (one pressed at most, pressing it again clears it, patch `{ kind }`), and two `type="date"` inputs labelled `From` and `To` (patches `{ since }` / `{ until }`, `null` when the value is empty). The owner's status and visibility groups stay as they are. Clear empties the dates too.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/pages/ListFilters.test.tsx` (it has `pressed(name)`, fake timers, `EMPTY_QUERY`, `ListQuery`):

```ts
  it('offers the kind chips to everyone, one pressed at most, and a second press clears it', () => {
    const onChange = vi.fn()
    const query: ListQuery = { ...EMPTY_QUERY, kind: 'nebula' }
    render(<ListFilters query={query} onChange={onChange} label="Search the gallery" />)
    expect(pressed('Nebulae')).toBe('true')
    expect(pressed('Galaxies')).toBe('false')
    expect(screen.getByRole('group', { name: 'Object kind' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Galaxies' }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'galaxy' })
    fireEvent.click(screen.getByRole('button', { name: 'Nebulae' }))
    expect(onChange).toHaveBeenLastCalledWith({ kind: null })
  })

  it('reports a chosen day at once and follows one set from outside', () => {
    const onChange = vi.fn()
    const { rerender } = render(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    const from = screen.getByLabelText('From') as HTMLInputElement
    const to = screen.getByLabelText('To') as HTMLInputElement
    expect(from.type).toBe('date')
    fireEvent.change(from, { target: { value: '2026-10-01' } })
    expect(onChange).toHaveBeenLastCalledWith({ since: '2026-10-01' })
    fireEvent.change(to, { target: { value: '2026-10-31' } })
    expect(onChange).toHaveBeenLastCalledWith({ until: '2026-10-31' })
    rerender(<ListFilters query={{ ...EMPTY_QUERY, since: '2026-09-01' }} onChange={onChange} label="Search the gallery" />)
    expect(from.value).toBe('2026-09-01')
    expect(to.value).toBe('')
  })

  it('a cleared or half-typed date drops that bound', () => {
    // Chromium reports '' while a date is being typed; that is "no bound" until it is complete.
    const onChange = vi.fn()
    render(<ListFilters query={{ ...EMPTY_QUERY, since: '2026-10-01' }} onChange={onChange} label="Search the gallery" />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ since: null })
  })

  it('Clear empties the dates with the rest', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ListFilters query={{ ...EMPTY_QUERY, kind: 'star', since: '2026-10-01', until: '2026-10-31' }} onChange={onChange} label="Search the gallery" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_QUERY)
    rerender(<ListFilters query={EMPTY_QUERY} onChange={onChange} label="Search the gallery" />)
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('')
    expect(pressed('Stars')).toBe('false')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/pages/ListFilters.test.tsx`
Expected: FAIL: no button "Nebulae", no label "From".

- [ ] **Step 3: Implement**

`frontend/src/pages/ListFilters.tsx` becomes:

```tsx
import { useEffect, useRef } from 'react'
import { SEARCH_MAX_LENGTH } from '../api'
import Chip from '../Chip'
import { KIND_LABELS, KINDS } from '../editor/objectsFilter'
import { EMPTY_QUERY, isFiltered, STATUS_LABELS, type ListQuery } from './listQuery'

/** How long typing pauses before the search runs and lands in the URL. */
export const SEARCH_DEBOUNCE_MS = 250

const PUBLISHED_LABELS: readonly [boolean, string][] = [
  [true, 'Published'],
  [false, 'Unpublished'],
]

/** The search box and filter chips above a list (SPEC § 5.5). The page owns the query (it
 *  lives in the URL); this only reports patches: the box's text after a short pause, a chip or
 *  a date at once, Clear as the empty query. Within a group one chip is pressed at most, and
 *  pressing it again clears it. Everyone gets the kind chips and the upload-day range; the
 *  owner's page adds the status and visibility groups. */
export default function ListFilters({
  query,
  onChange,
  owner = false,
  label,
}: {
  query: ListQuery
  onChange: (patch: Partial<ListQuery>) => void
  owner?: boolean
  label: string
}) {
  // Uncontrolled, as the Objects tab's box is (#90): the DOM owns the text while the owner
  // types, and the query only writes it back when it changed elsewhere (Clear, back button).
  // The date inputs follow the same rule: a half-typed date reads as '' and must not be
  // overwritten by a controlled re-render mid-entry.
  const box = useRef<HTMLInputElement>(null)
  const since = useRef<HTMLInputElement>(null)
  const until = useRef<HTMLInputElement>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (box.current && box.current.value.trim() !== query.q) box.current.value = query.q
  }, [query.q])
  useEffect(() => {
    if (since.current && since.current.value !== (query.since ?? '')) since.current.value = query.since ?? ''
  }, [query.since])
  useEffect(() => {
    if (until.current && until.current.value !== (query.until ?? '')) until.current.value = query.until ?? ''
  }, [query.until])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function typed(value: string) {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onChange({ q: value.trim() }), SEARCH_DEBOUNCE_MS)
  }

  // Text typed inside the pause has not reached the query yet, so the box effect above would
  // not empty it, and the timer would put it back onto the cleared URL.
  function clear() {
    window.clearTimeout(timer.current)
    if (box.current) box.current.value = ''
    onChange(EMPTY_QUERY)
  }

  return (
    <div className="list-filters" role="search">
      <input
        ref={box}
        type="search"
        aria-label={label}
        placeholder={label}
        maxLength={SEARCH_MAX_LENGTH}
        defaultValue={query.q}
        onChange={(e) => typed(e.target.value)}
      />
      {owner && (
        <>
          <div className="chips" role="group" aria-label="Solve status">
            {Object.entries(STATUS_LABELS).map(([value, text]) => (
              <Chip
                key={value}
                pressed={query.status === value}
                onClick={() => onChange({ status: query.status === value ? null : (value as ListQuery['status']) })}
              >
                {text}
              </Chip>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Visibility">
            {PUBLISHED_LABELS.map(([value, text]) => (
              <Chip key={text} pressed={query.published === value} onClick={() => onChange({ published: query.published === value ? null : value })}>
                {text}
              </Chip>
            ))}
          </div>
        </>
      )}
      <div className="chips" role="group" aria-label="Object kind">
        {KINDS.map((kind) => (
          <Chip key={kind} pressed={query.kind === kind} onClick={() => onChange({ kind: query.kind === kind ? null : kind })}>
            {KIND_LABELS[kind]}
          </Chip>
        ))}
      </div>
      <span className="date-range">
        <label>
          From <input ref={since} type="date" defaultValue={query.since ?? ''} onChange={(e) => onChange({ since: e.target.value || null })} />
        </label>
        <label>
          To <input ref={until} type="date" defaultValue={query.until ?? ''} onChange={(e) => onChange({ until: e.target.value || null })} />
        </label>
      </span>
      {isFiltered(query) && (
        <button type="button" className="secondary" onClick={clear}>
          Clear
        </button>
      )}
    </div>
  )
}
```

Keep the existing `clear` function exactly as PR 1 left it if it differs only in comments. The `label` elements wrap their inputs, so `getByLabelText('From')` resolves without `htmlFor`.

In `frontend/src/styles.css` line 40, add `input[type='date']` to the selector list:

```css
input[type='text'], input[type='search'], input[type='number'], input[type='password'], input[type='date'], select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem 0.65rem; font: inherit; }
```

After the `.list-filters input[type='search']` rule add:

```css
.list-filters .date-range { display: inline-flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; }
.list-filters .date-range label { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--muted); font-size: 0.85rem; }
.list-filters input[type='date'] { padding: 0.3rem 0.5rem; color-scheme: dark; }
```

`color-scheme: dark` makes Chromium's picker icon match the dark page (the `:root` already declares `color-scheme: dark`, so this is belt and braces for the input).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/pages/`
Expected: all pass, including PR 1's `ListFilters` tests (the search box, status chips, Clear and the maxLength pin are untouched).

- [ ] **Step 5: Lint and commit**

Run: `make lint`
Expected: clean.

```bash
git add frontend/src/pages/ListFilters.tsx frontend/src/pages/ListFilters.test.tsx frontend/src/styles.css
git commit -m "feat: kind chips and an upload-day range on both list pages (#189)"
```

---

### Task 6: The pages pass the new filters through

**Files:**
- Test: `frontend/src/pages/ImagesPage.test.tsx`, `frontend/src/pages/GalleryPage.test.tsx`

**Interfaces:**
- Consumes: everything above. No production change is expected: `ImagesPage` and `GalleryPage` read the query through `useListQuery` and call `toPageQuery`, and `ShowMore` builds its href with `pageHref`. These tests pin that the plumbing really is generic; if one fails, the fix belongs in the page, not the test.

- [ ] **Step 1: Write the tests**

Append to the `ImagesPage search and filters (#189)` describe in `frontend/src/pages/ImagesPage.test.tsx` (helpers `mountAt`, `tick`, `image`, `config`):

```ts
  it('kind and dates reach the API from the URL and ride on the Show more link', async () => {
    vi.mocked(api.listImages).mockResolvedValue({ items: [image('a')], next: 'a' })
    vi.mocked(api.config).mockResolvedValue(config)
    mountAt('/?kind=nebula&since=2026-10-01&until=2026-10-31')
    await tick(0)
    expect(api.listImages).toHaveBeenCalledWith({ kind: 'nebula', since: '2026-10-01', until: '2026-10-31' })
    expect(screen.getByRole('button', { name: 'Nebulae' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-10-01')
    expect(screen.getByRole('link', { name: 'Show more' }).getAttribute('href')).toBe('?kind=nebula&since=2026-10-01&until=2026-10-31&before=a')
    fireEvent.click(screen.getByRole('button', { name: 'Galaxies' }))
    await tick(0)
    expect(screen.getByTestId('url').textContent).toBe('?kind=galaxy&since=2026-10-01&until=2026-10-31')
    expect(api.listImages).toHaveBeenLastCalledWith({ kind: 'galaxy', since: '2026-10-01', until: '2026-10-31' })
  })
```

Append to the `GalleryPage` describe in `frontend/src/pages/GalleryPage.test.tsx` (`item`, `health`, `Url`):

```ts
  it('kind and dates reach the API from the URL, and a chosen day drops the cursor', async () => {
    vi.mocked(api.gallery).mockResolvedValue({ items: [item], next: null })
    render(
      <MemoryRouter initialEntries={['/gallery?kind=nebula&before=img-7']}>
        <GalleryPage health={health()} />
        <Url />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('link', { name: /Orion/ })).toBeTruthy()
    expect(api.gallery).toHaveBeenCalledWith({ kind: 'nebula', before: 'img-7' })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } })
    expect(await screen.findByText('?kind=nebula&until=2026-10-31')).toBeTruthy()
    expect(api.gallery).toHaveBeenLastCalledWith({ kind: 'nebula', until: '2026-10-31', before: null })
  })
```

- [ ] **Step 2: Run them**

Run: `cd frontend && npx vitest run src/pages/ImagesPage.test.tsx src/pages/GalleryPage.test.tsx`
Expected: PASS without a production change. If either fails, read the assertion: a wrong href order means `entries` in `listQuery.ts` (Task 4) is out of order; a missing API field means `toPageQuery` or `paged` dropped it. Fix there and re-run. Record in the ledger that these passed first time if they did (they pin plumbing, they are not RED tests).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ImagesPage.test.tsx frontend/src/pages/GalleryPage.test.tsx
git commit -m "test: kind and date filters reach both list APIs from the URL (#189)"
```

---

### Task 7: The visitor filters the gallery end to end

**Files:**
- Modify: `frontend/e2e/gallery.spec.ts` (the search step after "Nothing matches." and before the `Clear` click, around lines 40-50)

**Interfaces:**
- Consumes: the fake nova's Orion field (M 42 is a nebula; nova's `bright` rows are stars; no galaxy), the gallery's kind chips and date inputs from Task 5, the API from Task 3.

- [ ] **Step 1: Extend the step**

Replace the lines from `await search.fill('zzqq')` through the `scrollbarGutter` expectation with:

```ts
      await search.fill('zzqq')
      await expect(pub.getByText('Nothing matches.')).toBeVisible()
      expect(await pub.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toBe('stable')
      await search.fill('')
      await expect(galleryCard).toBeVisible()
      // Kind chips and the upload-day range (SPEC § 5.5): M 42 is a nebula, nothing in the
      // field is a galaxy; the fixture was uploaded moments ago, so yesterday..tomorrow holds
      // it and a range that ended two days ago does not.
      await pub.getByRole('button', { name: 'Nebulae' }).click()
      await expect(pub).toHaveURL(/\?kind=nebula$/)
      await expect(galleryCard).toBeVisible()
      await pub.getByRole('button', { name: 'Galaxies' }).click()
      await expect(pub.getByText('Nothing matches.')).toBeVisible()
      await pub.getByRole('button', { name: 'Galaxies' }).click()
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
      await pub.getByLabel('From').fill(day(-1))
      await pub.getByLabel('To').fill(day(1))
      await expect(pub).toHaveURL(new RegExp(`\\?since=${day(-1)}&until=${day(1)}$`))
      await expect(galleryCard).toBeVisible()
      await pub.getByLabel('To').fill(day(-2))
      await expect(pub.getByText('Nothing matches.')).toBeVisible()
```

The `Clear` click that follows stays: it must now also empty the two pickers (asserted by `toHaveURL(/\/$/)` and the card being visible).

- [ ] **Step 2: Run the gallery spec**

Run: `cd frontend && npm run build && E2E_START_APP=1 npx playwright test e2e/gallery.spec.ts --project=chromium`
Expected: 1 passed. If `fill` on the date input rejects the value, Playwright wants `YYYY-MM-DD` exactly, which `day()` produces; if the URL regex fails on the `From` fill alone landing first (`?since=...` without `until`), the second `toHaveURL` still waits for the final state, so look at the actual URL in the error before changing the test.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/gallery.spec.ts
git commit -m "test: the visitor filters the gallery by kind and upload day end to end (#189)"
```

---

### Task 8: SPEC § 5.5, § 7, § 8 and the INSTALL note

**Files:**
- Modify: `docs/SPEC.md:202-209` (§ 5.5 sentence), `:360-367` (§ 7 objects table), `:391-393` and `:435-438` (§ 8)
- Modify: `docs/INSTALL.md:181-184` (upgrade paragraph)

- [ ] **Step 1: SPEC § 5.5**

In the sentence starting "A search box above both lists" (line 202), after "visibility chips (Published, Unpublished)." insert:

```
  Both lists add kind chips (Galaxies, Nebulae, Clusters, Stars, Other: an image with at least
  one object of that kind, as the Objects tab buckets them) and an upload-day range (From, To:
  native date inputs, UTC days, both inclusive).
```

- [ ] **Step 2: SPEC § 7**

In the `objects` table (line 360), after the `radius` row add:

```
  kind          text  (galaxy|nebula|cluster|star|other: the Objects-tab bucket, stored at insert
                       and backfilled once by schema 8, so the list filter and the editor agree)
```

- [ ] **Step 3: SPEC § 8**

After "continues that search." (line 393) insert:

```
  `kind` (galaxy|nebula|cluster|star|other) keeps images with at least one stored object of
  that kind; `since` and `until` (`YYYY-MM-DD`) bound the upload day in UTC, both inclusive, and
  an inverted range is simply empty. Any of these malformed is 422.
```

Change the `GET /images` line (435) to:

```
- `GET /images?limit=24&before=<id>&q=<text>&status=<solving|failed|solved>&published=<bool>&kind=<kind>&since=<day>&until=<day>` →
```

and in the sentence after it, "the gallery accepts and ignores `status` and `published`" stays; add "and takes `q`, `kind`, `since` and `until` like the owner's list".

- [ ] **Step 4: INSTALL**

After the catalogue paragraph (line 184) add:

```
The first start after upgrading to a release with the kind filter also classifies every stored
object once (the objects table gains a `kind` column; a moment per thousand objects), so the
Images page and the gallery can filter by it.
```

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md docs/INSTALL.md
git commit -m "docs: kind and upload-day filters in SPEC § 5.5, § 7, § 8 and the upgrade note (#189)"
```

---

### Task 9: Whole-branch verification

- [ ] **Step 1: Full suites**

Run: `make lint test`
Expected: clean; pytest and vitest green.

Run: `make e2e`
Expected: 15 passed, 1 skipped (the dev-proxy project).

- [ ] **Step 2: The dev database migrates**

The owner's `make dev` database (`data/astrocaption.sqlite`, schema 7, 558 objects) migrates on the unit's next start. Restart it and check the log and the column, read-only:

```bash
sudo systemctl restart astrocaption-dev && sleep 4 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/api/health
python3 -c "import sqlite3; c=sqlite3.connect('file:data/astrocaption.sqlite?mode=ro', uri=True); print(c.execute('PRAGMA user_version').fetchone(), c.execute('SELECT kind, COUNT(*) FROM objects GROUP BY kind').fetchall())"
```

Expected: `200`, `(8,)`, and a spread over galaxy/nebula/cluster/star/other with no row left at a kind the data does not justify (the 10 Andromeda fields are galaxies; the Veil fields nebulae). Record the counts in the ledger. This is the one step that touches `data/`; it is the owner's checkout and the migration is what a self-hoster's first start does. Back it up first: `cp data/astrocaption.sqlite /tmp/claude-1000/-home-dmitr-astrocaption/614a03cf-d19a-4a14-94e0-c8888b66ef47/scratchpad/astrocaption.sqlite.pre-8` (a read, then a copy, never a write to `data/`).

- [ ] **Step 3: Hand to the owner**

Smoke list for the owner on `make dev` (the unit is already on the branch): Images page: press each kind chip (Galaxies gives the M31/M33/NGC 7331 fields, Nebulae the Veil, M 27, M 16/17, Clusters M 35/37/38, Stars nearly everything, Other the comet and NGC fields OpenNGC does not classify); set From and To around a known upload day; reload with the URL; Show more under Stars; Clear. Gallery signed out: the same, plus a pasted `/gallery?kind=nebula&since=2026-09-01`. Editor: open an image, the Objects tab's chips bucket the rows as before.

Then the review ritual (CLAUDE.md): `/code-review high`, the silent-failure pass, `/simplify`; fix; `make lint test`; wait for the owner's verdict; push; `gh pr create` with `Closes #189`; `gh pr checks --watch`; stop for the owner's go before merging.
