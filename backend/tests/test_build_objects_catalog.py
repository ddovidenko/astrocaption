"""The positional objects catalogue (SPEC § 5.2 "Local catalogue", #17): its loader, its
builder, and the shipped file."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from app.catalog import KIND_BY_SOURCE, CatalogObject, load_objects_catalog


def write_catalog(
    path: Path, objects: list[dict[str, object]], version: str = "2026-10-13"
) -> Path:
    path.write_text(json.dumps({"version": version, "objects": objects}), encoding="utf-8")
    return path


def test_load_objects_catalog_reads_rows_and_precomputes_unit_vectors(tmp_path: Path) -> None:
    path = write_catalog(
        tmp_path / "objects.json",
        [
            {
                "names": ["Sh2-279"],
                "ra": 83.85,
                "dec": -4.85,
                "radius_arcmin": 10.0,
                "type": "sharpless",
            }
        ],
    )
    cat = load_objects_catalog(path)
    assert cat.version == "2026-10-13"
    assert len(cat.objects) == 1
    obj = cat.objects[0]
    assert isinstance(obj, CatalogObject)
    assert obj.names == ("Sh2-279",) and obj.type == "sharpless"
    x, y, z = obj.unit
    assert math.isclose(math.hypot(x, y, z), 1.0)
    assert math.isclose(z, math.sin(math.radians(-4.85)))


@pytest.mark.parametrize(
    ("row", "problem"),
    [
        ({"names": [], "ra": 1.0, "dec": 1.0, "radius_arcmin": 1.0, "type": "pgc"}, "names"),
        (
            {"names": ["B 1"], "ra": 1.0, "dec": 1.0, "radius_arcmin": 0.0, "type": "barnard"},
            "radius",
        ),
        (
            {"names": ["B 1"], "ra": 400.0, "dec": 1.0, "radius_arcmin": 1.0, "type": "barnard"},
            "ra",
        ),
        ({"names": ["B 1"], "ra": 1.0, "dec": 1.0, "radius_arcmin": 1.0, "type": "comet"}, "type"),
    ],
)
def test_load_objects_catalog_refuses_a_bad_row(
    tmp_path: Path, row: dict[str, object], problem: str
) -> None:
    path = write_catalog(tmp_path / "objects.json", [row])
    with pytest.raises(ValueError) as caught:
        load_objects_catalog(path)
    assert problem in str(caught.value) and "objects.json" in str(caught.value)


def test_load_objects_catalog_refuses_a_file_that_is_not_the_catalogue(tmp_path: Path) -> None:
    path = tmp_path / "objects.json"
    path.write_text("{nope", encoding="utf-8")
    with pytest.raises(ValueError):
        load_objects_catalog(path)
    path.write_text(json.dumps({"objects": []}), encoding="utf-8")  # no version
    with pytest.raises(ValueError) as caught:
        load_objects_catalog(path)
    assert "version" in str(caught.value)


def test_kind_by_source_covers_every_source() -> None:
    assert KIND_BY_SOURCE == {
        "sharpless": "nebula",
        "lbn": "nebula",
        "barnard": "nebula",
        "ldn": "nebula",
        "pgc": "galaxy",
    }
