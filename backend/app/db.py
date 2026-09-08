"""SQLite persistence via the standard-library ``sqlite3`` module.

One short-lived connection per operation (WAL mode), which keeps the solver task and
request handlers independent without a shared-connection lock.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .models import (
    Annotations,
    Calibration,
    ImageRecord,
    Label,
    SolveObject,
    SolveStatus,
    StyleConfig,
    utcnow_iso,
)

SCHEMA_VERSION = 1

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
    solve_scale        REAL NOT NULL DEFAULT 1.0,
    nova_submission_id INTEGER,
    nova_job_id        INTEGER,
    wcs_text           TEXT,
    calibration_json   TEXT,
    published          INTEGER NOT NULL DEFAULT 0,
    exported_at        TEXT
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

IMAGE_COLUMNS = (
    "id",
    "created_at",
    "updated_at",
    "title",
    "original_name",
    "original_path",
    "preview_path",
    "thumb_path",
    "width",
    "height",
    "solve_status",
    "solve_error",
    "solve_scale",
    "nova_submission_id",
    "nova_job_id",
    "wcs_text",
    "calibration_json",
    "published",
    "exported_at",
)


def _row_to_image(row: sqlite3.Row) -> ImageRecord:
    calibration = None
    if row["calibration_json"]:
        calibration = Calibration.model_validate_json(row["calibration_json"])
    return ImageRecord(
        id=row["id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        title=row["title"],
        original_name=row["original_name"],
        original_path=row["original_path"],
        preview_path=row["preview_path"],
        thumb_path=row["thumb_path"],
        width=row["width"],
        height=row["height"],
        solve_status=SolveStatus(row["solve_status"]),
        solve_error=row["solve_error"],
        solve_scale=row["solve_scale"],
        nova_submission_id=row["nova_submission_id"],
        nova_job_id=row["nova_job_id"],
        wcs_text=row["wcs_text"],
        calibration=calibration,
        published=bool(row["published"]),
        exported_at=row["exported_at"],
    )


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
            if version < 1:
                conn.executescript(SCHEMA)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    # -- images -----------------------------------------------------------------

    def insert_image(self, rec: ImageRecord) -> None:
        values = {
            **rec.model_dump(exclude={"calibration"}),
            "solve_status": rec.solve_status.value,
            "published": int(rec.published),
            "calibration_json": rec.calibration.model_dump_json() if rec.calibration else None,
        }
        cols = ", ".join(IMAGE_COLUMNS)
        params = ", ".join(f":{c}" for c in IMAGE_COLUMNS)
        with self.connect() as conn:
            conn.execute(f"INSERT INTO images ({cols}) VALUES ({params})", values)

    def get_image(self, image_id: str) -> ImageRecord | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        return _row_to_image(row) if row else None

    def list_images(self) -> list[ImageRecord]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM images ORDER BY created_at DESC, id").fetchall()
        return [_row_to_image(r) for r in rows]

    def images_needing_solve(self) -> list[ImageRecord]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE solve_status IN (?, ?) ORDER BY created_at",
                (SolveStatus.PENDING.value, SolveStatus.SOLVING.value),
            ).fetchall()
        return [_row_to_image(r) for r in rows]

    def update_image(self, image_id: str, fields: dict[str, object]) -> None:
        """Update the given columns; ``updated_at`` is always refreshed."""
        values: dict[str, object] = {}
        for key, value in fields.items():
            if key == "calibration":
                values["calibration_json"] = (
                    value.model_dump_json() if isinstance(value, Calibration) else None
                )
            elif key == "solve_status" and isinstance(value, SolveStatus):
                values[key] = value.value
            elif key == "published":
                values[key] = int(bool(value))
            else:
                values[key] = value
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

    # -- annotations --------------------------------------------------------------

    def save_annotations(self, ann: Annotations) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO annotations (image_id, style_json, labels_json, version, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT (image_id) DO UPDATE SET style_json = excluded.style_json,"
                " labels_json = excluded.labels_json, version = excluded.version,"
                " updated_at = excluded.updated_at",
                (
                    ann.image_id,
                    ann.style.model_dump_json(),
                    json.dumps([lab.model_dump() for lab in ann.labels]),
                    ann.version,
                    ann.updated_at,
                ),
            )

    def get_annotations(self, image_id: str) -> Annotations | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM annotations WHERE image_id = ?", (image_id,)
            ).fetchone()
        if row is None:
            return None
        return Annotations(
            image_id=row["image_id"],
            style=StyleConfig.model_validate_json(row["style_json"]),
            labels=[Label.model_validate(lab) for lab in json.loads(row["labels_json"])],
            version=row["version"],
            updated_at=row["updated_at"],
        )
