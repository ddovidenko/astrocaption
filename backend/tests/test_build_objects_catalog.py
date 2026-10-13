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


# --- the builder ---------------------------------------------------------------------------

from scripts.build_objects_catalog import (
    DEFAULT_RADIUS_ARCMIN,
    build,
    parse_tsv,
    rows_from_barnard,
    rows_from_lbn,
    rows_from_ldn,
    rows_from_pgc,
    rows_from_sharpless,
)

SHARPLESS_TSV = """\
#Title: Sharpless

_RAJ2000\t_DEJ2000\tSh2\tDiam
deg\tdeg\t \tarcmin
----------\t----------\t----\t----
239.713380\t-26.120461\t   1\t 150
083.850000\t-04.850000\t 279\t  20
"""

BARNARD_TSV = """\
_RAJ2000\t_DEJ2000\tBarn\tDiam
deg\tdeg\t \tarcmin
--------\t--------\t----\t-----
053.2392\t+31.1592\t  1 \t 30.0
056.0100\t+31.7988\t  4 \t
085.2458\t-02.4583\t 33 \t  6.0
085.2458\t-02.4583\t 33 \t  4.0
"""

LDN_TSV = """\
_RAJ2000\t_DEJ2000\tLDN\tArea
deg\tdeg\t \tdeg2
--------\t--------\t----\t-------
247.2144\t-16.1094\t   1\t  0.054
088.2000\t+01.8000\t1622\t  0.785
"""

LBN_TSV = """\
_RAJ2000\t_DEJ2000\tSeq\tDiam1\tDiam2\tName
deg\tdeg\t \tarcmin\tarcmin\t
--------\t--------\t----\t----\t---\t--------
266.2937\t-28.8533\t   1\t   4\t  4\tS 17
083.8600\t-04.8400\t 974\t  60\t 30\tS 279
084.0000\t-05.0000\t 975\t\t\t
"""

PGC_TSV = """\
_RAJ2000\t_DEJ2000\tPGC\tlogD25\tANames
deg\tdeg\t \t[0.1arcmin]\t
----------\t----------\t-------\t-----\t--------
000.812083\t+16.145556\t    218\t 1.70\tNGC7814               UGC8                  MCG3-01-020
333.500000\t+46.500000\t  68029\t 1.02\t
000.000000\t+00.000000\t  99999\t 1.00\t(ARP112)              IC1613
"""


def first_name(row: dict[str, object]) -> str:
    names = row["names"]
    assert isinstance(names, list)
    return str(names[0])


def test_parse_tsv_skips_comments_units_and_dashes() -> None:
    rows = parse_tsv(SHARPLESS_TSV)
    assert rows == [
        {"_RAJ2000": "239.713380", "_DEJ2000": "-26.120461", "Sh2": "1", "Diam": "150"},
        {"_RAJ2000": "083.850000", "_DEJ2000": "-04.850000", "Sh2": "279", "Diam": "20"},
    ]


def test_sharpless_rows() -> None:
    rows = rows_from_sharpless(parse_tsv(SHARPLESS_TSV))
    assert rows[1] == {
        "names": ["Sh2-279"],
        "ra": 83.85,
        "dec": -4.85,
        "radius_arcmin": 10.0,
        "type": "sharpless",
    }


def test_barnard_rows_default_a_missing_diameter() -> None:
    rows = rows_from_barnard(parse_tsv(BARNARD_TSV))
    assert rows[0]["names"] == ["B 1"] and rows[0]["radius_arcmin"] == 15.0
    assert rows[1]["names"] == ["B 4"] and rows[1]["radius_arcmin"] == DEFAULT_RADIUS_ARCMIN


def test_ldn_area_becomes_the_radius_of_a_disc_of_that_area() -> None:
    rows = rows_from_ldn(parse_tsv(LDN_TSV))
    ldn1622 = rows[1]
    assert ldn1622["names"] == ["LDN 1622"] and ldn1622["type"] == "ldn"
    assert ldn1622["radius_arcmin"] == pytest.approx(math.sqrt(0.785 / math.pi) * 60, rel=1e-6)


def test_lbn_rows_keep_the_larger_diameter_and_carry_the_sharpless_cross_id() -> None:
    rows = rows_from_lbn(parse_tsv(LBN_TSV))
    assert rows[1]["names"] == ["LBN 974", "Sh2-279"] and rows[1]["radius_arcmin"] == 30.0
    assert rows[2]["names"] == ["LBN 975"] and rows[2]["radius_arcmin"] == DEFAULT_RADIUS_ARCMIN


def test_pgc_rows_format_the_kept_cross_names_and_convert_logd25() -> None:
    rows = rows_from_pgc(parse_tsv(PGC_TSV))
    assert rows[0]["names"] == ["PGC 218", "NGC 7814", "UGC 8"]
    assert rows[0]["radius_arcmin"] == pytest.approx(10**1.70 * 0.1 / 2)
    assert rows[1]["names"] == ["PGC 68029"]
    assert rows[2]["names"] == ["PGC 99999", "Arp 112", "IC 1613"]


def test_build_folds_an_lbn_row_into_its_sharpless_row_and_dedupes_same_names() -> None:
    rows = build(
        {
            "sharpless": SHARPLESS_TSV,
            "barnard": BARNARD_TSV,
            "ldn": LDN_TSV,
            "lbn": LBN_TSV,
            "pgc": PGC_TSV,
        }
    )
    by_first = {first_name(r): r for r in rows}
    # LBN 974 names S 279: it joins Sh2-279 (names merged, larger radius kept), not its own row.
    assert "LBN 974" not in by_first
    assert by_first["Sh2-279"]["names"] == ["Sh2-279", "LBN 974"]
    assert by_first["Sh2-279"]["radius_arcmin"] == 30.0
    # Two Barnard rows called B 33: one row, the larger radius.
    assert [first_name(r) for r in rows].count("B 33") == 1
    assert by_first["B 33"]["radius_arcmin"] == 3.0
    assert {r["type"] for r in rows} == {"sharpless", "barnard", "ldn", "lbn", "pgc"}
