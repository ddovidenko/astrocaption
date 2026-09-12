# Annotations API (Milestone 3, PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the editor save a layout and ask the server to re-place it: `PUT /api/images/{id}/annotations` with optimistic concurrency (409 on a stale version) and `POST /api/images/{id}/autoarrange`, both validating the document against the image's objects and the font bundle; plus the typed client calls the editor (PR 4) will use, and the 422 wording for list-shaped bodies (#66).

**Architecture:** One request model, `AnnotationsUpdate` (style, labels, version), shared by both routes; one validation helper in `backend/app/api/images.py` that turns a bad document into a plain 422 (object ids must belong to the image and appear once; the font must be bundled; colours are `#RRGGBB` by model pattern). The PUT stores through a new compare-and-swap in `db.py` (`UPDATE ... WHERE version = ?`) so two editors cannot both win; the winner's row is returned. Autoarrange runs `layout.autoplace` on the submitted document and returns it without storing. Colour fields on `StyleConfig` and `Label` gain the `#RRGGBB` pattern already used by `StyleOverrides`, so a bad colour is refused at the API instead of failing inside Pillow at export.

**Tech Stack:** FastAPI, pydantic, stdlib sqlite3, pytest; TypeScript types + fetch wrappers in `frontend/src/api.ts`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 4 (API and persistence), § 8 item 3; `docs/SPEC.md` § 7 (annotations table), § 8 (`GET/PUT /images/{id}/annotations`, `POST /images/{id}/autoarrange`); issue #66.

Scope judgment: the design's PR 3 line is backend-only; this plan also adds the four typed client calls in `frontend/src/api.ts` (types for the documents already exist since PR 2) because PR 4 consumes them unchanged and they are twelve lines.

## Global Constraints

- Python 3.13+ (CI runs 3.14), type hints everywhere, ruff (line length 100, isort), mypy strict over `app`, `tests`, `scripts`. TypeScript strict. No new dependencies.
- Never call nova.astrometry.net from tests; the `FakeSolver` + recorded fixtures in `backend/tests/conftest.py` drive solves.
- API responses never carry raw exception text or a submitted value (CLAUDE.md, #45): 422 wording comes from `VALIDATION_MESSAGES` in `backend/app/models.py` (by pydantic error type) or from fixed sentences in the route. The `HEX_COLOR` pattern is the model's own, so "must match ^#[0-9A-Fa-f]{6}$" is allowed.
- Geometry stays in original-image pixels; the server never rescales label positions.
- Design § 4 wording is binding: the 409 detail is exactly `This image was changed elsewhere. Reload to continue editing.`
- Stored document semantics: PUT stores `version + 1` and a fresh `updated_at`; the stored document is the response. Autoarrange returns the same version and does not store.
- After Python edits run `make format`; `make lint test` at the repo root before every commit.
- Dev servers run as the systemd unit `astrocaption-dev`; never run `npm ci`, `npm install` or `make install` on this checkout. If a Makefile rule triggers `npm ci` (it does when `package.json` changes), restart the unit afterwards: `sudo systemctl restart astrocaption-dev`. This PR does not change `package.json`.
- Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N
  ```
- Branch `feat/annotations-api` from `main` (999f284 or later). Stop after `gh pr create` and `gh pr checks --watch`; the owner merges.

## File map

| File | Responsibility |
|---|---|
| `backend/app/models.py` (modify) | `HEX_COLOR` moved above `StyleConfig`; colour patterns on `StyleConfig` and `Label.color`; `text_override` max length; `AnnotationsUpdate`; `MAX_LABELS`; list-length entries in `VALIDATION_MESSAGES`. |
| `backend/app/db.py` (modify) | `Database.update_annotations_if_version(ann, expected_version) -> bool` (compare-and-swap). |
| `backend/app/api/images.py` (modify) | `_annotations_target` (404/409 gate), `_validate_document` (422s), `PUT .../annotations`, `POST .../autoarrange`. |
| `backend/tests/test_models.py`, `test_db.py`, `test_validation_errors.py` (modify) | Model, CAS and wording tests. |
| `backend/tests/test_annotations_api.py` (create) | Route tests for PUT and autoarrange. |
| `frontend/src/api.ts` (modify) | `AnnotationsUpdate` type; `api.objects`, `api.annotations`, `api.saveAnnotations`, `api.autoarrange`. |
| `docs/SPEC.md` § 8 (modify) | PUT/409/422 and autoarrange semantics. |

---

### Task 1: Models and the compare-and-swap write

**Files:**
- Modify: `backend/app/models.py` (`StyleConfig`, `Label`, `VALIDATION_MESSAGES`, new `AnnotationsUpdate`)
- Modify: `backend/app/db.py` (after `save_annotations`)
- Modify: `backend/tests/test_models.py`, `backend/tests/test_db.py`, `backend/tests/test_validation_errors.py`

**Interfaces:**
- Produces: `models.AnnotationsUpdate(style: StyleConfig, labels: list[Label], version: int)` (extra fields such as `image_id`/`updated_at` ignored, `version >= 1`, `len(labels) <= MAX_LABELS`); `models.MAX_LABELS = 5000`; `models.MAX_TEXT_OVERRIDE = 200`; `Database.update_annotations_if_version(ann: Annotations, expected_version: int) -> bool`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_models.py`:

```python
from app.models import AnnotationsUpdate, Label, StyleConfig  # extend the existing import line


def test_style_and_label_colours_must_be_hex() -> None:
    for field in ("text_color", "marker_color", "leader_color", "halo_color"):
        with pytest.raises(ValidationError) as exc:
            StyleConfig.model_validate({field: "red"})
        assert exc.value.errors()[0]["type"] == "string_pattern_mismatch"
    with pytest.raises(ValidationError):
        Label(object_id=1, color="red")
    assert Label(object_id=1, color="#ABCdef").color == "#ABCdef"
    assert StyleConfig().text_color == "#FFFFFF"  # the defaults still validate


def test_annotations_update_ignores_server_fields_and_bounds_the_rest() -> None:
    doc = AnnotationsUpdate.model_validate(
        {
            "image_id": "ignored",
            "updated_at": "ignored",
            "style": StyleConfig().model_dump(),
            "labels": [{"object_id": 1, "x": 10, "y": 20}],
            "version": 3,
        }
    )
    assert doc.version == 3 and doc.labels[0].x == 10 and not hasattr(doc, "image_id")
    with pytest.raises(ValidationError):
        AnnotationsUpdate.model_validate({"style": {}, "labels": [], "version": 0})
    with pytest.raises(ValidationError) as exc:
        Label(object_id=1, text_override="x" * 201)
    assert exc.value.errors()[0]["type"] == "string_too_long"
```

Append to `backend/tests/test_db.py` (it already builds a `Database` in a tmp dir; reuse its helper or fixture):

```python
def test_update_annotations_if_version_is_a_compare_and_swap(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    db.init()
    first = Annotations(image_id="img", style=StyleConfig(), labels=[], version=1)
    db.save_annotations(first)
    newer = first.model_copy(update={"version": 2, "labels": [Label(object_id=1)]})
    assert db.update_annotations_if_version(newer, expected_version=1)
    stored = db.get_annotations("img")
    assert stored is not None and stored.version == 2 and len(stored.labels) == 1
    stale = first.model_copy(update={"version": 2, "labels": []})
    assert not db.update_annotations_if_version(stale, expected_version=1)  # someone else won
    assert db.get_annotations("img") == stored
    assert not db.update_annotations_if_version(newer, expected_version=1)  # no row for "other"
```

(imports: `from app.models import Annotations, Label, StyleConfig`; note `Annotations` has `updated_at` defaulting to now, so compare `stored` to itself as above, not to `newer`.)

Add to the parametrize list in `backend/tests/test_validation_errors.py`:

```python
        ({"type": "too_short", "ctx": {"field_type": "List", "min_length": 1, "actual_length": 0}}, "must have at least 1 items"),
        ({"type": "too_long", "ctx": {"field_type": "List", "max_length": 5000, "actual_length": 5001}}, "must have at most 5000 items"),
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_models.py tests/test_db.py tests/test_validation_errors.py -q`
Expected: ImportError on `AnnotationsUpdate` and `AttributeError` on `update_annotations_if_version` after fixing imports; the colour test fails because `StyleConfig` accepts "red".

- [ ] **Step 3: Implement**

`backend/app/models.py`: move `HEX_COLOR = r"^#[0-9A-Fa-f]{6}$"` up to just above `class StyleConfig` (delete the later definition), add `MAX_TEXT_OVERRIDE = 200` and `MAX_LABELS = 5000` next to `MAX_FONT_SIZE`, and change the fields:

```python
class StyleConfig(BaseModel):
    """Global style for one image. All lengths are original-image pixels; colours are #RRGGBB."""

    font_file: str = "Inter-Regular.ttf"
    font_size: int = Field(default=24, ge=MIN_FONT_SIZE, le=MAX_FONT_SIZE)
    text_color: str = Field(default="#FFFFFF", pattern=HEX_COLOR)
    marker_color: str = Field(default="#FFD54A", pattern=HEX_COLOR)
    leader_color: str = Field(default="#FFD54A", pattern=HEX_COLOR)
    halo: bool = True
    halo_color: str = Field(default="#000000", pattern=HEX_COLOR)
    ...


class Label(BaseModel):
    ...
    text_override: str | None = Field(default=None, max_length=MAX_TEXT_OVERRIDE)
    color: str | None = Field(default=None, pattern=HEX_COLOR)
    ...
```

After `class Annotations`, add:

```python
class AnnotationsUpdate(BaseModel):
    """What the editor sends to ``PUT /annotations`` and ``POST /autoarrange``: the document it
    holds. ``image_id`` and ``updated_at`` are the server's and are ignored if present; ``version``
    is the one it loaded, for the conflict check."""

    style: StyleConfig
    labels: list[Label] = Field(max_length=MAX_LABELS)
    version: int = Field(ge=1)
```

In `VALIDATION_MESSAGES` add:

```python
    "too_short": "must have at least {min_length} items",
    "too_long": "must have at most {max_length} items",
```

`backend/app/db.py`, after `save_annotations`:

```python
    def update_annotations_if_version(self, ann: Annotations, expected_version: int) -> bool:
        """Store ``ann`` only if the row still holds ``expected_version`` (optimistic
        concurrency for the editor's autosave). False when another writer got there first,
        or when the image has no annotations row."""
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE annotations SET style_json = ?, labels_json = ?, version = ?,"
                " updated_at = ? WHERE image_id = ? AND version = ?",
                (
                    ann.style.model_dump_json(),
                    json.dumps([lab.model_dump() for lab in ann.labels]),
                    ann.version,
                    ann.updated_at,
                    ann.image_id,
                    expected_version,
                ),
            )
            return cur.rowcount == 1
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q`
Expected: all pass. If an existing test builds a `StyleConfig` or `Label` with a non-hex colour, that test is asserting behaviour this task removes on purpose: change its colour to `#RRGGBB` form and say so in the report.

- [ ] **Step 5: Lint and commit**

```bash
make format && make lint test
git add backend/app/models.py backend/app/db.py backend/tests/test_models.py backend/tests/test_db.py backend/tests/test_validation_errors.py
git commit -m "feat: annotations update model, hex colours on the style and a versioned write

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 2: `PUT /api/images/{id}/annotations`

**Files:**
- Modify: `backend/app/api/images.py` (after `get_annotations`)
- Create: `backend/tests/test_annotations_api.py`

**Interfaces:**
- Consumes: `AnnotationsUpdate`, `Database.update_annotations_if_version`, `fonts.list_fonts`, `_get_or_404`, `db.get_objects`.
- Produces: `_annotations_target(db, image_id) -> tuple[ImageRecord, Annotations]` (404 when the image is unknown or has no annotations row, 409 while `solve_status` is `pending`/`solving`); `_validate_document(doc: AnnotationsUpdate, objects: list[SolveObject], settings: Settings) -> None` (422s); route `put_annotations`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_annotations_api.py`:

```python
"""``PUT /api/images/{id}/annotations`` (design § 4): the editor's autosave with a version check."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import upload, wait_for_status  # move these helpers into conftest if they live in test_api.py

CONFLICT = "This image was changed elsewhere. Reload to continue editing."


def solved_image(client: TestClient, sample_jpeg: Path) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
    image_id = upload(client, sample_jpeg, title="Orion")["id"]
    assert wait_for_status(client, image_id, {"solved", "failed"})["solve_status"] == "solved"
    ann = client.get(f"/api/images/{image_id}/annotations").json()
    objects = client.get(f"/api/images/{image_id}/objects").json()
    return image_id, ann, objects


def test_put_stores_the_document_with_a_bumped_version(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    ann["labels"][0]["x"] += 25.5
    ann["labels"][0]["collided"] = False
    ann["style"]["text_color"] = "#ABCDEF"
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 200, resp.text
    stored = resp.json()
    assert stored["version"] == ann["version"] + 1
    assert stored["updated_at"] != ann["updated_at"] or stored["updated_at"] >= ann["updated_at"]
    assert stored["labels"][0]["x"] == ann["labels"][0]["x"]
    assert stored["style"]["text_color"] == "#ABCDEF"
    assert client.get(f"/api/images/{image_id}/annotations").json() == stored


def test_put_with_a_stale_version_is_a_409_and_writes_nothing(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    first = client.put(f"/api/images/{image_id}/annotations", json=ann).json()
    ann["labels"][0]["x"] = -1.0  # a second editor still holding the old version
    resp = client.put(f"/api/images/{image_id}/annotations", json=ann)
    assert resp.status_code == 409
    assert resp.json() == {"detail": CONFLICT}
    assert client.get(f"/api/images/{image_id}/annotations").json() == first


def test_put_validates_objects_font_and_colours_without_echoing(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, objects = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/annotations"

    unknown = {**ann, "labels": ann["labels"] + [{"object_id": 999_999}]}
    resp = client.put(url, json=unknown)
    assert resp.status_code == 422 and "999999" not in resp.text
    assert resp.json()["detail"] == "labels: every label must name one of this image's objects, once."

    duplicate = {**ann, "labels": ann["labels"] + [ann["labels"][0]]}
    assert client.put(url, json=duplicate).status_code == 422

    bad_font = {**ann, "style": {**ann["style"], "font_file": "Comic-Sans.ttf"}}
    resp = client.put(url, json=bad_font)
    assert resp.status_code == 422 and "Comic" not in resp.text
    assert resp.json()["detail"] == "style.font_file is not a bundled font."

    bad_colour = {**ann, "style": {**ann["style"], "marker_color": "orange"}}
    resp = client.put(url, json=bad_colour)
    assert resp.status_code == 422 and "orange" not in resp.text
    assert resp.json()["detail"] == "style.marker_color: must match ^#[0-9A-Fa-f]{6}$"

    bad_label_colour = {**ann, "labels": [{**ann["labels"][0], "color": "orange"}] + ann["labels"][1:]}
    resp = client.put(url, json=bad_label_colour)
    assert resp.status_code == 422 and "orange" not in resp.text

    assert client.put(url, json={**ann, "version": 0}).status_code == 422
    assert client.get(url).json() == ann  # nothing above was stored
    assert len(objects) == 20


def test_put_needs_a_solved_image(client: TestClient, sample_jpeg: Path, tmp_path: Path) -> None:
    doc = {"style": {}, "labels": [], "version": 1}
    assert client.put("/api/images/nope/annotations", json=doc).status_code == 404
    # an uploaded image that has not finished solving: 409 while solving, 404 once failed with no row
    # (use the FakeSolver knobs in conftest: job_polls high enough to observe "solving")
```

For the last test, follow `test_export_and_resolve_conflict_while_solving` in `backend/tests/test_api.py` (it builds a client whose solver stays in `solving`); assert a PUT during the solve is `409` with detail `"The image is still being solved; try again when it is done."`, and that a never-solved image (a client with `solver_factory=lambda: None` as `test_missing_key_gives_guidance` does) gets `404` with `"Image has not been solved yet."`.

`upload` and `wait_for_status` currently live in `backend/tests/test_api.py`; move them (unchanged) to `backend/tests/conftest.py` and import them in `test_api.py` so both modules share them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_annotations_api.py -q`
Expected: `405 Method Not Allowed` from every PUT (no route yet).

- [ ] **Step 3: Implement**

`backend/app/api/images.py`, after `get_annotations`:

```python
SOLVING_MESSAGE = "The image is still being solved; try again when it is done."
CONFLICT_MESSAGE = "This image was changed elsewhere. Reload to continue editing."
OBJECTS_MESSAGE = "labels: every label must name one of this image's objects, once."
FONT_MESSAGE = "style.font_file is not a bundled font."


def _annotations_target(db: Database, image_id: str) -> tuple[ImageRecord, Annotations]:
    """The image and its stored layout, or the 404/409 the editor shows."""
    rec = _get_or_404(db, image_id)
    if rec.solve_status in (SolveStatus.PENDING, SolveStatus.SOLVING):
        raise HTTPException(status.HTTP_409_CONFLICT, SOLVING_MESSAGE)
    ann = db.get_annotations(image_id)
    if ann is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image has not been solved yet.")
    return rec, ann


def _validate_document(doc: AnnotationsUpdate, objects: list[SolveObject], settings: Settings) -> None:
    """Plain 422s for what the models cannot check: object ids and the font bundle. Messages
    never repeat the submitted value (CLAUDE.md)."""
    ids = [lab.object_id for lab in doc.labels]
    known = {o.id for o in objects}
    if len(set(ids)) != len(ids) or not set(ids) <= known:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, OBJECTS_MESSAGE)
    if doc.style.font_file not in {f.file for f in list_fonts(settings.fonts_dir)}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, FONT_MESSAGE)


@router.put("/{image_id}/annotations")
async def put_annotations(
    image_id: str, doc: AnnotationsUpdate, settings: SettingsDep, db: DbDep
) -> Annotations:
    """The editor's autosave (design § 4): stored as version + 1 when ``doc.version`` is still
    the stored one, else 409 and nothing written."""
    _, stored = _annotations_target(db, image_id)
    _validate_document(doc, db.get_objects(image_id), settings)
    if doc.version != stored.version:
        raise HTTPException(status.HTTP_409_CONFLICT, CONFLICT_MESSAGE)
    ann = Annotations(
        image_id=image_id, style=doc.style, labels=doc.labels, version=doc.version + 1
    )
    if not db.update_annotations_if_version(ann, expected_version=doc.version):
        raise HTTPException(status.HTTP_409_CONFLICT, CONFLICT_MESSAGE)  # lost the race
    return ann
```

Imports to add: `AnnotationsUpdate` from `..models`, `list_fonts` from `..fonts`. The early `doc.version != stored.version` check gives the common case a clear answer before validation-free work; the compare-and-swap is what makes it correct under a race.

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q`
Expected: all pass, including `test_api.py` after the helper move.

- [ ] **Step 5: Lint and commit**

```bash
make format && make lint test
git add backend/app/api/images.py backend/tests/test_annotations_api.py backend/tests/test_api.py backend/tests/conftest.py
git commit -m "feat: PUT /api/images/{id}/annotations with a version conflict check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 3: `POST /api/images/{id}/autoarrange`

**Files:**
- Modify: `backend/app/api/images.py` (after `put_annotations`)
- Modify: `backend/tests/test_annotations_api.py`

**Interfaces:**
- Consumes: `_annotations_target`, `_validate_document`, `layout.autoplace(width, height, style, labels, objects, fonts_dir)`.
- Produces: route `autoarrange` returning `Annotations` (same version as submitted, stored `updated_at`, not stored).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_annotations_api.py`:

```python
def test_autoarrange_places_enabled_labels_and_stores_nothing(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, objects = solved_image(client, sample_jpeg)
    moved = {**ann, "labels": [{**lab, "x": 0.0, "y": 0.0, "collided": True} for lab in ann["labels"]]}
    resp = client.post(f"/api/images/{image_id}/autoarrange", json=moved)
    assert resp.status_code == 200, resp.text
    placed = resp.json()
    assert placed["version"] == ann["version"]
    assert placed["image_id"] == image_id
    enabled = [lab for lab in placed["labels"] if lab["enabled"]]
    disabled = [lab for lab in placed["labels"] if not lab["enabled"]]
    assert enabled and all((lab["x"], lab["y"]) != (0.0, 0.0) for lab in enabled)
    assert all((lab["x"], lab["y"]) == (0.0, 0.0) for lab in disabled)  # untouched
    assert not any(lab["collided"] for lab in enabled)
    # the initial layout, reproduced: same positions as the solve produced
    by_id = {lab["object_id"]: lab for lab in ann["labels"]}
    for lab in enabled:
        assert (lab["x"], lab["y"]) == (by_id[lab["object_id"]]["x"], by_id[lab["object_id"]]["y"])
    assert client.get(f"/api/images/{image_id}/annotations").json() == ann  # not stored


def test_autoarrange_validates_like_put(client: TestClient, sample_jpeg: Path) -> None:
    image_id, ann, _ = solved_image(client, sample_jpeg)
    url = f"/api/images/{image_id}/autoarrange"
    resp = client.post(url, json={**ann, "labels": ann["labels"] + [{"object_id": 999_999}]})
    assert resp.status_code == 422 and resp.json()["detail"] == OBJECTS_MESSAGE_TEXT
    resp = client.post(url, json={**ann, "style": {**ann["style"], "font_file": "Nope.ttf"}})
    assert resp.status_code == 422 and "Nope" not in resp.text
    assert client.post("/api/images/nope/autoarrange", json=ann).status_code == 404
```

(`OBJECTS_MESSAGE_TEXT` = the same sentence as in Task 2; define it once at the top of the test module.) The "initial layout, reproduced" assertion holds because the solve placed the same labels from the object positions with no fixed obstacles; `autoplace` is deterministic.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_annotations_api.py -q -k autoarrange`
Expected: 404/405 from the POST (no route).

- [ ] **Step 3: Implement**

```python
@router.post("/{image_id}/autoarrange")
async def autoarrange(
    image_id: str, doc: AnnotationsUpdate, settings: SettingsDep, db: DbDep
) -> Annotations:
    """Run the placer on every enabled label of the submitted document (no fixed labels) and
    return the result without storing it; the editor applies it and autosaves (design § 4)."""
    rec, stored = _annotations_target(db, image_id)
    objects = db.get_objects(image_id)
    _validate_document(doc, objects, settings)
    labels = await asyncio.to_thread(
        autoplace, rec.width, rec.height, doc.style, doc.labels, objects, settings.fonts_dir
    )
    return Annotations(
        image_id=image_id,
        style=doc.style,
        labels=labels,
        version=doc.version,
        updated_at=stored.updated_at,
    )
```

Import `autoplace` from `..layout`. The placer measures text with Pillow for every enabled label, so it runs in a thread like the export does.

- [ ] **Step 4: Run the tests, lint, commit**

```bash
cd backend && .venv/bin/pytest -q && cd .. && make format && make lint test
git add backend/app/api/images.py backend/tests/test_annotations_api.py
git commit -m "feat: POST /api/images/{id}/autoarrange runs the placer on the editor's document

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
```

---

### Task 4: Client calls, SPEC § 8, verification, PR

**Files:**
- Modify: `frontend/src/api.ts` (type after `Annotations`; four entries in `api`)
- Modify: `docs/SPEC.md` § 8

- [ ] **Step 1: Client calls**

In `frontend/src/api.ts`, after `export interface Annotations { ... }`:

```ts
/** What the editor sends back: its document minus the server-owned fields. Mirrors AnnotationsUpdate. */
export type AnnotationsUpdate = Pick<Annotations, 'style' | 'labels' | 'version'>
```

In the `api` object, after `resolve`:

```ts
  objects: (id: string) => request<ObjectOut[]>(`/api/images/${id}/objects`),
  annotations: (id: string) => request<Annotations>(`/api/images/${id}/annotations`),
  /** 409 (ApiError.status) means the stored version moved: reload before editing further. */
  saveAnnotations: (id: string, doc: AnnotationsUpdate) =>
    request<Annotations>(`/api/images/${id}/annotations`, json('PUT', doc)),
  autoarrange: (id: string, doc: AnnotationsUpdate) =>
    request<Annotations>(`/api/images/${id}/autoarrange`, json('POST', doc)),
```

Run: `cd frontend && npm run lint --silent && npm test --silent` — clean (no test needed for four one-line wrappers; `tsc` checks the types against `Annotations`/`ObjectOut`).

- [ ] **Step 2: SPEC § 8**

Replace the two lines

```
- `GET/PUT /images/{id}/annotations` (PUT is autosaved by the editor, debounced 500 ms)
- `POST /images/{id}/autoarrange` → new labels array (server runs the same placer)
```

with

```
- `GET/PUT /images/{id}/annotations`. `PUT` is the editor's autosave (debounced 500 ms): body = {style, labels,
  version as loaded}; every `labels[].object_id` must be one of the image's objects and appear once, `style.font_file`
  must be bundled, colours are `#RRGGBB`, else a plain 422. Stored as `version + 1` with a fresh `updated_at`, and the
  stored document is the response. If the stored version differs from the submitted one: 409
  `This image was changed elsewhere. Reload to continue editing.` and nothing is written (a compare-and-swap in the
  database, so two editors cannot both win). 404 before the first solve, 409 while a solve is running.
- `POST /images/{id}/autoarrange` → the same document with every enabled label re-placed by the placer (§ 6.4, no
  fixed labels), same version, not stored; the editor applies it and autosaves. Validated like `PUT`.
```

- [ ] **Step 3: Full verification and PR**

```bash
make lint test
git add frontend/src/api.ts docs/SPEC.md
git commit -m "feat: typed client calls for the annotations API and SPEC § 8

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N"
git push -u origin feat/annotations-api
```

PR: `gh pr create --title "feat: annotations API (milestone 3, PR 3)" --body-file <file>` with body:

```
Milestone 3, PR 3 of 8 (design § 4; plan docs/superpowers/plans/2026-09-12-annotations-api.md).

- `PUT /api/images/{id}/annotations`: the editor's autosave. Validates object ids (once each, all of this image), the bundled font and `#RRGGBB` colours with plain 422s; stores `version + 1` through a compare-and-swap; 409 "This image was changed elsewhere. Reload to continue editing." when the version moved; 404 before the first solve, 409 during one.
- `POST /api/images/{id}/autoarrange`: runs the placer on the submitted document's enabled labels and returns it unsaved.
- `StyleConfig`/`Label` colours now carry the `#RRGGBB` pattern (a bad colour used to reach Pillow at export); `text_override` capped at 200 characters; list-length 422 wording added. Closes #66
- `frontend/src/api.ts`: `objects`, `annotations`, `saveAnnotations`, `autoarrange` for PR 4.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Ukpr5zaBbiD93v2geqyN5N
```

Then `gh pr checks --watch` and stop; the owner smoke-tests (`curl` the PUT with a stale version, or wait for PR 4's editor) and says "merge".
