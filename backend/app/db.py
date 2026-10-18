"""SQLite persistence via the standard-library ``sqlite3`` module.

One short-lived connection per operation (WAL mode), which keeps the solver task and
request handlers independent without a shared-connection lock.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Literal, NamedTuple

from pydantic import BaseModel, ValidationError

from .models import (
    Annotations,
    Calibration,
    ImageRecord,
    Label,
    ObjectKind,
    SolveHints,
    SolveObject,
    SolveStatus,
    StyleConfig,
    utcnow_iso,
    validate_dropping_bad_fields,
)
from .objects import classify, kind_of

log = logging.getLogger(__name__)

#: Rows per page when the caller does not say (SPEC § 8); the API clamps to 1..100.
PAGE_LIMIT = 24


class UnknownCursor(LookupError):
    """``before`` names no image: the row was deleted after the caller saw it."""


class ImagePage(NamedTuple):
    items: list[ImageRecord]
    #: The id to pass as ``before`` for the next page, or None when this is the last one.
    next: str | None


#: What makes a row a gallery row (SPEC § 5.5): published and currently solved. The list, the
#: sitemap and the head tags share it so they cannot drift (#187).
_GALLERY_CONDS = ("published = 1", "solve_status = ?")
_GALLERY_VALUES = (SolveStatus.SOLVED.value,)
_GALLERY_WHERE = " AND ".join(_GALLERY_CONDS)

# Every images column but the WCS header, which can run to kilobytes a row and which the
# sitemap and the head tags never read (#226). ``_row_to_image`` validates the rows, so a
# column that goes missing from this list fails the tests that read the light rows.
_LIGHT_COLUMNS = (
    "id, created_at, updated_at, title, original_name, original_path, preview_path, thumb_path,"
    " width, height, solve_status, solve_error, solve_failure, solve_scale, nova_submission_id,"
    " nova_job_id, calibration_json, solve_hints_json, published, exported_at, exported_hash,"
    " objects_catalog"
)


def _marks(values: Sequence[object]) -> str:
    """``?, ?, ?`` for an ``IN`` clause over ``values``."""
    return ", ".join("?" for _ in values)


ListStatus = Literal["solving", "failed", "solved"]
"""The owner's status chip: ``solving`` is every row the Images page polls (pending too)."""


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


#: The whole list, unfiltered (the frozen dataclass makes one shared instance safe).
NO_FILTER = ListFilter()


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


#: The rows a solve is still running on: what the worker resumes and the owner polls.
_BUSY_STATUSES = (SolveStatus.PENDING.value, SolveStatus.SOLVING.value)

#: One of these per `ListFilter.status`, over `images.solve_status`.
_STATUS_CONDITIONS: dict[ListStatus, tuple[str, tuple[object, ...]]] = {
    "solving": ("solve_status IN (?, ?)", _BUSY_STATUSES),
    "failed": ("solve_status = ?", (SolveStatus.FAILED.value,)),
    "solved": ("solve_status = ?", (SolveStatus.SOLVED.value,)),
}

_SEARCH_CONDITION = (
    "(instr(fold(title), ?) > 0 OR EXISTS ("
    "SELECT 1 FROM objects o WHERE o.image_id = images.id"
    " AND instr(fold_names(o.catalog_names), ?) > 0))"
)

#: An image with at least one stored object of the kind (schema 8); none at all matches nothing.
_KIND_CONDITION = "EXISTS (SELECT 1 FROM objects o WHERE o.image_id = images.id AND o.kind = ?)"


def _filter_conditions(filter: ListFilter) -> tuple[list[str], list[object]]:
    """The WHERE fragments and their parameters for `filter`, in a fixed order."""
    conds: list[str] = []
    values: list[object] = []
    if filter.status is not None:
        cond, params = _STATUS_CONDITIONS[filter.status]
        conds.append(cond)
        values.extend(params)
    if filter.published is not None:
        conds.append("published = ?")
        values.append(1 if filter.published else 0)
    if filter.kind is not None:
        conds.append(_KIND_CONDITION)
        values.append(filter.kind)
    # created_at is an ISO stamp that starts with the day, so string compares against
    # "YYYY-MM-DD" bound it, both ends inclusive. Ordering stays on rowid (#214), these only
    # select.
    if filter.since is not None:
        conds.append("created_at >= ?")
        values.append(filter.since.isoformat())
    if filter.until is not None:
        conds.append("substr(created_at, 1, 10) <= ?")
        values.append(filter.until.isoformat())
    # Last: SQLite tests the terms in this order, and the search's two Python functions cost
    # more per row than everything above.
    needle = fold(filter.q)
    if needle:
        conds.append(_SEARCH_CONDITION)
        values.extend((needle, needle))
    return conds, values


SCHEMA_VERSION = 8


# Statements that bring an existing database from version N-1 to N.
def _migrate_7_rehash_current_exports(conn: sqlite3.Connection) -> None:
    """Schema 7 widens ``content_hash`` to the objects' names (#217). An export whose recorded
    hash matched the old formula (style and labels only) was current: re-stamp it with the new
    one, so no owner finds every export "out of date" after an upgrade. A stale one stays as it
    is; a row without a layout cannot be re-hashed and stays as it is too. The catalogue stamps
    are cleared so the startup backfill revisits every image once and applies the names-only
    merges the previous build held back (additive; the labels do not move)."""
    rows = conn.execute(
        "SELECT i.id, i.exported_hash, a.style_json, a.labels_json FROM images i"
        " JOIN annotations a ON a.image_id = i.id WHERE i.exported_hash IS NOT NULL"
    ).fetchall()
    for row in rows:
        old = hashlib.sha256(f"{row['style_json']}\n{row['labels_json']}".encode()).hexdigest()[:32]
        if row["exported_hash"] != old:
            continue
        new = content_hash(row["style_json"], row["labels_json"], _names_text(conn, row["id"]))
        conn.execute("UPDATE images SET exported_hash = ? WHERE id = ?", (new, row["id"]))
    conn.execute("UPDATE images SET objects_catalog = NULL")


def _migrate_8_classify_objects(conn: sqlite3.Connection) -> None:
    """Schema 8 stores each object's Objects-tab kind (#189) so the list can filter on it. The
    column defaults to ``other``; every existing row is classified once, by the same pass that
    re-checks them at every start."""
    conn.execute("ALTER TABLE objects ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'")
    _reclassify(conn)


def _reclassify(conn: sqlite3.Connection) -> int:
    """Rewrite every stored ``kind`` that differs from what `classify` says today and return how
    many rows moved. The caller owns the transaction."""
    rows = conn.execute("SELECT image_id, id, catalog_names, type, kind FROM objects").fetchall()
    moved = [(kind, r["image_id"], r["id"]) for r in rows if (kind := _kind_of_row(r)) != r["kind"]]
    conn.executemany("UPDATE objects SET kind = ? WHERE image_id = ? AND id = ?", moved)
    return len(moved)


def _kind_of_row(row: sqlite3.Row) -> ObjectKind:
    """`classify` for a stored object row. A names cell this code never writes (not a JSON list
    of names, or an empty one) is ``other`` with a warning: one odd row must not roll the
    migration back and keep the server from starting."""
    try:
        names = json.loads(row["catalog_names"])
        if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
            raise ValueError("not a list of names")
    except ValueError:
        log.warning(
            "object kinds: could not classify object %s of image %s (its names cell is not a"
            " JSON list of names); stored as other",
            row["id"],
            row["image_id"],
        )
        return "other"
    return classify(row["type"], names)


MIGRATIONS: dict[int, tuple[str | Callable[[sqlite3.Connection], None], ...]] = {
    2: ("ALTER TABLE images ADD COLUMN solve_hints_json TEXT",),
    3: ("ALTER TABLE images ADD COLUMN solve_failure TEXT",),
    4: ("ALTER TABLE images ADD COLUMN exported_version INTEGER",),
    # 5 replaces the exported document's version with its content hash (#91): an undo back to the
    # exported document is a new version but the same content, and should read as exported.
    5: (
        "ALTER TABLE images ADD COLUMN exported_hash TEXT",
        "ALTER TABLE images DROP COLUMN exported_version",
    ),
    # 6: which objects.json version an image's objects were looked up against (#17); NULL
    # means "never", and the startup backfill fills it in.
    6: ("ALTER TABLE images ADD COLUMN objects_catalog TEXT",),
    # 7: the content hash covers the objects' names (#217); current exports are re-stamped and
    # the catalogue stamps cleared, so the backfill revisits every image once.
    7: (_migrate_7_rehash_current_exports,),
    # 8: each object's kind is stored (#189), so the list filter and the editor's chips agree.
    8: (_migrate_8_classify_objects,),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id                 TEXT PRIMARY KEY,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    title              TEXT NOT NULL,
    original_name      TEXT NOT NULL,
    original_path      TEXT NOT NULL,
    preview_path       TEXT NOT NULL,
    thumb_path         TEXT NOT NULL,
    width              INTEGER NOT NULL,
    height             INTEGER NOT NULL,
    solve_status       TEXT NOT NULL DEFAULT 'pending',
    solve_error        TEXT,
    solve_failure      TEXT,
    solve_scale        REAL NOT NULL DEFAULT 1.0,
    nova_submission_id INTEGER,
    nova_job_id        INTEGER,
    wcs_text           TEXT,
    calibration_json   TEXT,
    solve_hints_json   TEXT,
    published          INTEGER NOT NULL DEFAULT 0,
    exported_at        TEXT,
    exported_hash      TEXT,
    objects_catalog    TEXT
);
CREATE INDEX IF NOT EXISTS images_created_at ON images (created_at);

CREATE TABLE IF NOT EXISTS objects (
    image_id      TEXT NOT NULL REFERENCES images (id) ON DELETE CASCADE,
    id            INTEGER NOT NULL,
    catalog_names TEXT NOT NULL,
    type          TEXT NOT NULL,
    x             REAL NOT NULL,
    y             REAL NOT NULL,
    radius        REAL NOT NULL DEFAULT 0,
    kind          TEXT NOT NULL DEFAULT 'other',
    PRIMARY KEY (image_id, id)
);

CREATE TABLE IF NOT EXISTS annotations (
    image_id    TEXT PRIMARY KEY REFERENCES images (id) ON DELETE CASCADE,
    style_json  TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL
);
"""

# ImageRecord fields stored as JSON text under a different column name. Every other field
# maps to a column of the same name; enums bind as their string and bools as 0/1.
JSON_COLUMNS: dict[str, tuple[str, type[BaseModel]]] = {
    "calibration": ("calibration_json", Calibration),
    "solve_hints": ("solve_hints_json", SolveHints),
}
IMAGE_COLUMNS: tuple[str, ...] = tuple(
    JSON_COLUMNS[name][0] if name in JSON_COLUMNS else name for name in ImageRecord.model_fields
)


def _parse_json_column[T: BaseModel](row: sqlite3.Row, column: str, model: type[T]) -> T | None:
    """One corrupt JSON cell must not take the whole image list down."""
    raw = row[column]
    if not raw:
        return None
    try:
        return model.model_validate_json(raw)
    except ValueError as exc:
        log.warning("image %s: ignoring unreadable %s: %s", row["id"], column, exc)
        return None


def _row_to_image(row: sqlite3.Row) -> ImageRecord:
    data: dict[str, object] = dict(row)
    for name, (column, model) in JSON_COLUMNS.items():
        data[name] = _parse_json_column(row, column, model)
    return ImageRecord.model_validate(data)


def _encode(fields: Mapping[str, object]) -> dict[str, object]:
    """Record fields → column values."""
    values: dict[str, object] = {}
    for key, value in fields.items():
        if key in JSON_COLUMNS:
            values[JSON_COLUMNS[key][0]] = (
                value.model_dump_json() if isinstance(value, BaseModel) else None
            )
        else:
            values[key] = value
    return values


def _parse_column(raw_json: str) -> object:
    """A stored JSON column, or ``None`` when it is not JSON at all (a hand edit), so the
    tolerant loaders treat it like any other column of the wrong shape."""
    try:
        return json.loads(raw_json)
    except (ValueError, RecursionError):  # not JSON, over the int-digit limit, nested too deep
        return None


def _load_style(raw_json: str, image_id: str) -> StyleConfig:
    """Tolerant load of a stored style: a row written before hex validation existed (an early
    ``config.json`` could carry ``"text_color": "white"``) must not 500 every GET/export/
    re-solve for that image. Drop only the fields that fail and let the model's defaults fill
    them back in; a column that is not an object at all is all defaults. Never log the value,
    only the field name."""
    raw = _parse_column(raw_json)
    if not isinstance(raw, dict):
        log.warning("image %s: stored style is not a JSON object; using the defaults", image_id)
        return StyleConfig()
    try:
        style, dropped = validate_dropping_bad_fields(StyleConfig, raw)
    except ValidationError:  # nothing left to drop (a model-level error): all defaults
        log.warning("image %s: stored style is unreadable; using the defaults", image_id)
        return StyleConfig()
    if dropped:
        log.warning("image %s: dropping unreadable style fields %s", image_id, sorted(dropped))
    return style


def _load_labels(raw_json: str, image_id: str) -> list[Label]:
    """Tolerant load of the stored labels, with the policy of ``_load_style`` per label (#69):
    a field that no longer validates falls back to its default, so no object loses its label.
    A label whose position is unreadable or absent (this build always writes ``x`` and ``y``)
    is disabled and unpinned rather than shown at the top-left corner, so Reset positions can
    place it when the owner turns it back on. Only an entry that is not an object or has no
    readable ``object_id`` is dropped: there is nothing to attach it to. Logged by object id
    and field name, never by value."""
    raw = _parse_column(raw_json)
    if not isinstance(raw, list):
        log.warning("image %s: stored labels are not a JSON list; using none", image_id)
        return []
    labels: list[Label] = []
    repaired: list[tuple[int, list[str]]] = []
    unreadable = 0
    for entry in raw:
        if not isinstance(entry, dict):
            unreadable += 1
            continue
        try:
            label, dropped = validate_dropping_bad_fields(Label, entry)
        except ValidationError:
            unreadable += 1
            continue
        if dropped:
            repaired.append((label.object_id, sorted(dropped)))
        if not {"x", "y"} <= entry.keys() - dropped.keys():
            label = label.model_copy(update={"enabled": False, "pinned": False})
        labels.append(label)
    if repaired:
        log.warning("image %s: dropping unreadable label fields %s", image_id, repaired)
    if unreadable:
        log.warning("image %s: dropping %d unreadable label entries", image_id, unreadable)
    return labels


def _image_update(image_id: str, fields: Mapping[str, object]) -> tuple[str, dict[str, object]]:
    """The ``UPDATE images`` statement and its parameters for ``fields`` plus a fresh
    ``updated_at``; unknown columns are refused before anything is sent to SQLite."""
    values = _encode(fields)
    unknown = set(values) - set(IMAGE_COLUMNS)
    if unknown:
        raise ValueError(f"unknown image columns: {sorted(unknown)}")
    values["updated_at"] = utcnow_iso()
    assignments = ", ".join(f"{k} = :{k}" for k in values)
    values["id"] = image_id
    return f"UPDATE images SET {assignments} WHERE id = :id", values


def _annotation_row(ann: Annotations) -> tuple[str, str]:
    """``(style_json, labels_json)`` for the ``annotations`` table's write path, shared by
    ``save_annotations`` and ``update_annotations_if_version``."""
    return ann.style.model_dump_json(), json.dumps([lab.model_dump() for lab in ann.labels])


def names_text(objects: Iterable[SolveObject]) -> str:
    """The objects' names as the ``objects`` table stores them, one object per line in id order:
    the third input of ``content_hash``."""
    return "\n".join(json.dumps(o.catalog_names) for o in sorted(objects, key=lambda o: o.id))


def _names_text(conn: sqlite3.Connection, image_id: str) -> str:
    rows = conn.execute(
        "SELECT catalog_names FROM objects WHERE image_id = ? ORDER BY id", (image_id,)
    ).fetchall()
    return "\n".join(r["catalog_names"] for r in rows)


def hash_of(ann: Annotations, objects: Iterable[SolveObject]) -> str:
    """``content_hash`` of ``ann`` over ``objects`` as the write path would store them (the PUT
    response carries it without a second read)."""
    return content_hash(*_annotation_row(ann), names_text(objects))


def content_hash(style_json: str, labels_json: str, names: str) -> str:
    """The rendered document's identity by content, over the text the rows store (the write
    paths dump the models deterministically, so equal documents hash alike): the style, the
    labels and the objects' names, which the label text is built from (#217).
    ``Annotations.content_hash`` and ``images.exported_hash`` are this; the pages compare them
    (#91)."""
    return hashlib.sha256(f"{style_json}\n{labels_json}\n{names}".encode()).hexdigest()[:32]


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


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    # -- connection management -------------------------------------------------

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            conn.row_factory = sqlite3.Row
            # The search's normaliser runs in Python so a Cyrillic title case-folds too and
            # a space in "M 27" never matters; `instr` rather than LIKE, so a "%" in the
            # query is a "%".
            conn.create_function("fold", 1, fold, deterministic=True)
            conn.create_function("fold_names", 1, fold_names, deterministic=True)
            conn.execute("PRAGMA foreign_keys = ON")
            yield conn
        finally:
            conn.close()

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"database schema {version} is newer than this build ({SCHEMA_VERSION});"
                    " upgrade AstroCaption or restore a matching data directory"
                )
            if version < 1:
                conn.executescript(SCHEMA)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                return
            for target in range(version + 1, SCHEMA_VERSION + 1):
                # SQLite DDL is transactional: a failed step leaves the old version stamped.
                conn.execute("BEGIN")
                try:
                    for step in MIGRATIONS[target]:
                        if callable(step):
                            step(conn)
                        else:
                            conn.execute(step)
                    conn.execute(f"PRAGMA user_version = {target}")
                    conn.execute("COMMIT")
                except Exception:
                    conn.execute("ROLLBACK")
                    raise

    # -- images -----------------------------------------------------------------

    def insert_image(self, rec: ImageRecord) -> None:
        fields = {
            **rec.model_dump(exclude=set(JSON_COLUMNS)),
            **{name: getattr(rec, name) for name in JSON_COLUMNS},
        }
        values = _encode(fields)
        cols = ", ".join(IMAGE_COLUMNS)
        params = ", ".join(f":{c}" for c in IMAGE_COLUMNS)
        with self.connect() as conn:
            conn.execute(f"INSERT INTO images ({cols}) VALUES ({params})", values)

    def get_image(self, image_id: str) -> ImageRecord | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        return _row_to_image(row) if row else None

    def _list_images(
        self, limit: int, before: str | None, conds: list[str], values: list[object]
    ) -> ImagePage:
        # "Newest first" is insertion order: rowid, not created_at. created_at is a wall-clock
        # stamp with whole-second resolution, so rows a moment apart tie there, and a host whose
        # clock is stepped backwards (WSL2 does it every half minute) stamps a later upload with
        # an earlier time (#214). rowid never does either: without AUTOINCREMENT SQLite reuses a
        # deleted newest row's rowid, but that is still the highest. Paging is keyset on the same
        # order (SPEC § 8): the page after `before` is everything inserted before that row, so an
        # upload or a delete elsewhere never shifts it. One row more than asked tells whether a
        # page follows.
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
        self, limit: int = PAGE_LIMIT, before: str | None = None, filter: ListFilter = NO_FILTER
    ) -> ImagePage:
        conds, values = _filter_conditions(filter)
        return self._list_images(limit, before, conds, values)

    def list_published_images(
        self, limit: int = PAGE_LIMIT, before: str | None = None, filter: ListFilter = NO_FILTER
    ) -> ImagePage:
        """The gallery's rows: published and currently solved, newest first (SPEC § 5.5), then
        whatever `filter` narrows further. Which filters are public is the gallery endpoint's
        business (it declares only the public ones); here an owner field can only narrow."""
        conds, values = _filter_conditions(filter)
        return self._list_images(
            limit, before, [*_GALLERY_CONDS, *conds], [*_GALLERY_VALUES, *values]
        )

    def published_images(self, limit: int | None = None) -> list[ImageRecord]:
        """The gallery's rows newest first, all of them or the newest ``limit``: the sitemap
        and the head tags (#187). Without the WCS header (#226)."""
        sql = f"SELECT {_LIGHT_COLUMNS} FROM images WHERE {_GALLERY_WHERE} ORDER BY rowid DESC"
        params: list[object] = [*_GALLERY_VALUES]
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_to_image(r) for r in rows]

    def count_published_images(self) -> int:
        """How many gallery rows there are (files on disk not checked): the gallery page's
        description (#187)."""
        with self.connect() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) FROM images WHERE {_GALLERY_WHERE}", _GALLERY_VALUES
            ).fetchone()
        return int(row[0])

    def images_needing_solve(self) -> list[ImageRecord]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE solve_status IN (?, ?) ORDER BY created_at",
                _BUSY_STATUSES,
            ).fetchall()
        return [_row_to_image(r) for r in rows]

    def images_for_catalog_backfill(self, version: str) -> list[ImageRecord]:
        """Solved images with a stored WCS whose objects were last looked up against another
        catalogue version (or never), oldest first."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE solve_status = ? AND wcs_text IS NOT NULL"
                " AND (objects_catalog IS NULL OR objects_catalog != ?)"
                " ORDER BY created_at, rowid",
                (SolveStatus.SOLVED.value, version),
            ).fetchall()
        return [_row_to_image(r) for r in rows]

    def update_image(self, image_id: str, fields: Mapping[str, object]) -> None:
        """Update the given record fields; ``updated_at`` is always refreshed."""
        sql, values = _image_update(image_id, fields)
        with self.connect() as conn:
            cur = conn.execute(sql, values)
        if cur.rowcount == 0:
            # Allowed: the worker writes to rows a delete may have removed meanwhile. Said here
            # rather than passed over in silence (#80).
            log.debug("update_image: no row with id %s (fields %s)", image_id, sorted(values))

    def store_solve_result(
        self,
        image_id: str,
        objects: list[SolveObject],
        ann: Annotations,
        fields: Mapping[str, object],
    ) -> bool:
        """A finished solve, in one transaction (#174): the objects replaced, the layout
        upserted and the row updated (``fields`` plus ``updated_at``), so a reader of
        ``/objects`` and ``/annotations`` sees either the previous solve or this one, never the
        new objects with the old labels. False, with nothing written, when the image row is
        gone: a delete landed during the solve, and its objects and layout must not come back.
        """
        sql, values = _image_update(image_id, fields)
        style_json, labels_json = _annotation_row(ann)
        with self.connect() as conn:
            conn.execute("BEGIN")
            try:
                cur = conn.execute(sql, values)
                if cur.rowcount == 0:
                    conn.execute("ROLLBACK")
                    log.debug("store_solve_result: no row with id %s; nothing stored", image_id)
                    return False
                conn.execute("DELETE FROM objects WHERE image_id = ?", (image_id,))
                conn.executemany(_INSERT_OBJECT, _object_rows(image_id, objects))
                conn.execute(
                    "INSERT INTO annotations (image_id, style_json, labels_json, version,"
                    " updated_at) VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT (image_id) DO UPDATE SET style_json = excluded.style_json,"
                    " labels_json = excluded.labels_json, version = excluded.version,"
                    " updated_at = excluded.updated_at",
                    (image_id, style_json, labels_json, ann.version, ann.updated_at),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        return True

    def delete_image(self, image_id: str) -> bool:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
            return cur.rowcount > 0

    # -- objects ----------------------------------------------------------------

    def replace_objects(self, image_id: str, objects: list[SolveObject]) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN")
            conn.execute("DELETE FROM objects WHERE image_id = ?", (image_id,))
            conn.executemany(_INSERT_OBJECT, _object_rows(image_id, objects))
            conn.execute("COMMIT")

    def reclassify_objects(self) -> int:
        """Bring every stored ``kind`` in line with what `classify` says today and return how
        many rows moved. Run at every start: a release that ships a new names table changes the
        answer for some objects, and the editor's chips and the list filter read the column, so
        nothing else would notice until a re-solve."""
        with self.connect() as conn:
            conn.execute("BEGIN")
            moved = _reclassify(conn)
            conn.execute("COMMIT")
        return moved

    def get_objects(self, image_id: str) -> list[SolveObject]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM objects WHERE image_id = ? ORDER BY id", (image_id,)
            ).fetchall()
        return [_row_to_object(r) for r in rows]

    def count_objects(self, image_id: str) -> int:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM objects WHERE image_id = ?", (image_id,)
            ).fetchone()
        return int(row[0])

    def object_counts(self, image_ids: Sequence[str]) -> dict[str, int]:
        """Objects per image for ``image_ids`` (one page of the list, #226); images without
        objects are absent."""
        if not image_ids:
            return {}
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT image_id, COUNT(*) AS n FROM objects"
                f" WHERE image_id IN ({_marks(image_ids)}) GROUP BY image_id",
                tuple(image_ids),
            )
            return {r["image_id"]: int(r["n"]) for r in rows}

    def annotations_hashes(self, image_ids: Sequence[str]) -> dict[str, str]:
        """``content_hash`` of the stored annotations rows for ``image_ids``, by image id (one
        page of the list, #226); images without annotations are absent."""
        if not image_ids:
            return {}
        marks, params = _marks(image_ids), tuple(image_ids)
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT image_id, style_json, labels_json FROM annotations WHERE image_id IN ({marks})",
                params,
            )
            names: dict[str, list[str]] = {}
            for r in conn.execute(
                f"SELECT image_id, catalog_names FROM objects WHERE image_id IN ({marks}) ORDER BY id",
                params,
            ):
                names.setdefault(r["image_id"], []).append(r["catalog_names"])
            return {
                r["image_id"]: content_hash(
                    r["style_json"], r["labels_json"], "\n".join(names.get(r["image_id"], []))
                )
                for r in rows
            }

    def annotations_hash(self, image_id: str) -> str | None:
        """One row's ``content_hash`` without decoding its document (``image_out`` needs no more)."""
        with self.connect() as conn:
            row = conn.execute(
                "SELECT style_json, labels_json FROM annotations WHERE image_id = ?", (image_id,)
            ).fetchone()
            if row is None:
                return None
            names = _names_text(conn, image_id)
        return content_hash(row["style_json"], row["labels_json"], names)

    # -- annotations --------------------------------------------------------------

    def save_annotations(self, ann: Annotations) -> None:
        style_json, labels_json = _annotation_row(ann)
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO annotations (image_id, style_json, labels_json, version, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT (image_id) DO UPDATE SET style_json = excluded.style_json,"
                " labels_json = excluded.labels_json, version = excluded.version,"
                " updated_at = excluded.updated_at",
                (ann.image_id, style_json, labels_json, ann.version, ann.updated_at),
            )

    def update_annotations_if_version(self, ann: Annotations, expected_version: int) -> bool:
        """Store ``ann`` only if the row still holds ``expected_version`` (optimistic
        concurrency for the editor's autosave). False when another writer got there first,
        or when the image has no annotations row."""
        style_json, labels_json = _annotation_row(ann)
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE annotations SET style_json = ?, labels_json = ?, version = ?,"
                " updated_at = ? WHERE image_id = ? AND version = ?",
                (
                    style_json,
                    labels_json,
                    ann.version,
                    ann.updated_at,
                    ann.image_id,
                    expected_version,
                ),
            )
            return cur.rowcount == 1

    def get_annotations(self, image_id: str) -> Annotations | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM annotations WHERE image_id = ?", (image_id,)
            ).fetchone()
            if row is None:
                return None
            names = _names_text(conn, image_id)
        return Annotations(
            image_id=row["image_id"],
            style=_load_style(row["style_json"], image_id),
            labels=_load_labels(row["labels_json"], image_id),
            version=row["version"],
            updated_at=row["updated_at"],
            content_hash=content_hash(row["style_json"], row["labels_json"], names),
        )
