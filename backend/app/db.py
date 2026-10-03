"""SQLite persistence via the standard-library ``sqlite3`` module.

One short-lived connection per operation (WAL mode), which keeps the solver task and
request handlers independent without a shared-connection lock.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path

from pydantic import BaseModel, ValidationError

from .models import (
    Annotations,
    Calibration,
    ImageRecord,
    Label,
    SolveHints,
    SolveObject,
    SolveStatus,
    StyleConfig,
    utcnow_iso,
    validate_dropping_bad_fields,
)

log = logging.getLogger(__name__)

SCHEMA_VERSION = 5

# Statements that bring an existing database from version N-1 to N.
MIGRATIONS: dict[int, tuple[str, ...]] = {
    2: ("ALTER TABLE images ADD COLUMN solve_hints_json TEXT",),
    3: ("ALTER TABLE images ADD COLUMN solve_failure TEXT",),
    4: ("ALTER TABLE images ADD COLUMN exported_version INTEGER",),
    # 5 replaces the exported document's version with its content hash (#91): an undo back to the
    # exported document is a new version but the same content, and should read as exported.
    5: (
        "ALTER TABLE images ADD COLUMN exported_hash TEXT",
        "ALTER TABLE images DROP COLUMN exported_version",
    ),
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
    exported_hash      TEXT
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
    except ValueError:  # JSONDecodeError and the int-digit limit both subclass it
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
    style, dropped = validate_dropping_bad_fields(StyleConfig, raw)
    if dropped:
        log.warning("image %s: dropping unreadable style fields %s", image_id, sorted(dropped))
    return style


def _load_labels(raw_json: str, image_id: str) -> list[Label]:
    """Tolerant load of the stored labels, with the policy of ``_load_style`` per label (#69):
    a field that no longer validates falls back to its default, so no object loses its label.
    A label whose position could not be read is disabled rather than shown at the top-left
    corner. Only an entry without a readable ``object_id`` is dropped: there is nothing to
    attach it to. Logged by object id and field name, never by value."""
    raw = _parse_column(raw_json)
    if not isinstance(raw, list):
        log.warning("image %s: stored labels are not a JSON list; using none", image_id)
        return []
    labels: list[Label] = []
    repaired: dict[int, list[str]] = {}
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
            repaired[label.object_id] = sorted(dropped)
            if {"x", "y"} & dropped.keys():
                label = label.model_copy(update={"enabled": False})
        labels.append(label)
    if repaired:
        log.warning("image %s: dropping unreadable label fields %s", image_id, repaired)
    if unreadable:
        log.warning("image %s: dropping %d label(s) naming no object", image_id, unreadable)
    return labels


def _annotation_row(ann: Annotations) -> tuple[str, str]:
    """``(style_json, labels_json)`` for the ``annotations`` table's write path, shared by
    ``save_annotations`` and ``update_annotations_if_version``."""
    return ann.style.model_dump_json(), json.dumps([lab.model_dump() for lab in ann.labels])


def hash_of(ann: Annotations) -> str:
    """``content_hash`` of ``ann`` as the write path would store it (the PUT response carries it
    without a second read)."""
    return content_hash(*_annotation_row(ann))


def content_hash(style_json: str, labels_json: str) -> str:
    """The document's identity by content, over the text the row stores (the write path dumps
    the models deterministically, so equal documents hash alike). ``Annotations.content_hash``
    and ``images.exported_hash`` are this; the pages compare them (#91)."""
    return hashlib.sha256(f"{style_json}\n{labels_json}".encode()).hexdigest()[:32]


def _row_to_object(row: sqlite3.Row) -> SolveObject:
    return SolveObject(
        id=row["id"],
        catalog_names=json.loads(row["catalog_names"]),
        type=row["type"],
        x=row["x"],
        y=row["y"],
        radius=row["radius"],
    )


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    # -- connection management -------------------------------------------------

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            conn.row_factory = sqlite3.Row
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
                    for statement in MIGRATIONS[target]:
                        conn.execute(statement)
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

    def _list_images(self, where: str = "", params: tuple[object, ...] = ()) -> list[ImageRecord]:
        # created_at has whole-second resolution (utcnow_iso), so two rows inserted within the
        # same second tie there; rowid (insertion order) breaks the tie the way "id" (a random
        # UUID) cannot.
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM images{where} ORDER BY created_at DESC, rowid DESC", params
            ).fetchall()
        return [_row_to_image(r) for r in rows]

    def list_images(self) -> list[ImageRecord]:
        return self._list_images()

    def list_published_images(self) -> list[ImageRecord]:
        """The gallery's rows: published and currently solved, newest first (SPEC § 5.5)."""
        return self._list_images(
            " WHERE published = 1 AND solve_status = ?", (SolveStatus.SOLVED.value,)
        )

    def images_needing_solve(self) -> list[ImageRecord]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE solve_status IN (?, ?) ORDER BY created_at",
                (SolveStatus.PENDING.value, SolveStatus.SOLVING.value),
            ).fetchall()
        return [_row_to_image(r) for r in rows]

    def update_image(self, image_id: str, fields: Mapping[str, object]) -> None:
        """Update the given record fields; ``updated_at`` is always refreshed."""
        values = _encode(fields)
        unknown = set(values) - set(IMAGE_COLUMNS)
        if unknown:
            raise ValueError(f"unknown image columns: {sorted(unknown)}")
        values["updated_at"] = utcnow_iso()
        assignments = ", ".join(f"{k} = :{k}" for k in values)
        values["id"] = image_id
        with self.connect() as conn:
            conn.execute(f"UPDATE images SET {assignments} WHERE id = :id", values)

    def delete_image(self, image_id: str) -> bool:
        with self.connect() as conn:
            cur = conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
            return cur.rowcount > 0

    # -- objects ----------------------------------------------------------------

    def replace_objects(self, image_id: str, objects: list[SolveObject]) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN")
            conn.execute("DELETE FROM objects WHERE image_id = ?", (image_id,))
            conn.executemany(
                "INSERT INTO objects (image_id, id, catalog_names, type, x, y, radius)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (image_id, o.id, json.dumps(o.catalog_names), o.type, o.x, o.y, o.radius)
                    for o in objects
                ],
            )
            conn.execute("COMMIT")

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

    def object_counts(self) -> dict[str, int]:
        with self.connect() as conn:
            rows = conn.execute("SELECT image_id, COUNT(*) AS n FROM objects GROUP BY image_id")
            return {r["image_id"]: int(r["n"]) for r in rows}

    def annotations_hashes(self) -> dict[str, str]:
        """``content_hash`` of every stored annotations row, by image id (for the list endpoint)."""
        with self.connect() as conn:
            rows = conn.execute("SELECT image_id, style_json, labels_json FROM annotations")
            return {r["image_id"]: content_hash(r["style_json"], r["labels_json"]) for r in rows}

    def annotations_hash(self, image_id: str) -> str | None:
        """One row's ``content_hash`` without decoding its document (``image_out`` needs no more)."""
        with self.connect() as conn:
            row = conn.execute(
                "SELECT style_json, labels_json FROM annotations WHERE image_id = ?", (image_id,)
            ).fetchone()
        return content_hash(row["style_json"], row["labels_json"]) if row else None

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
        return Annotations(
            image_id=row["image_id"],
            style=_load_style(row["style_json"], image_id),
            labels=_load_labels(row["labels_json"], image_id),
            version=row["version"],
            updated_at=row["updated_at"],
            content_hash=content_hash(row["style_json"], row["labels_json"]),
        )
