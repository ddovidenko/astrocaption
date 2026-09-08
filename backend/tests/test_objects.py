from __future__ import annotations

import pytest

from app.catalog import enrich_names, normalise
from app.models import name_category, primary_name
from app.objects import objects_from_nova, split_names
from tests.conftest import load_fixture


def test_primary_name_prefers_messier() -> None:
    assert primary_name(["NGC 1976", "M 42", "Orion Nebula"]) == "M 42"
    assert primary_name(["NGC 2024", "Flame Nebula"]) == "NGC 2024"
    assert primary_name(["Mintaka"]) == "Mintaka"


@pytest.mark.parametrize(
    ("name", "category"),
    [
        ("M 42", "messier"),
        ("M42", "messier"),
        ("Messier 31", "messier"),
        ("C 14", "caldwell"),
        ("Caldwell 14", "caldwell"),
        ("Sh2-279", "sharpless"),
        ("Sh 2-279", "sharpless"),
        ("Sharpless 279", "sharpless"),
        ("B 33", "barnard"),
        ("Barnard 33", "barnard"),
        ("NGC 1976", "ngc"),
        ("NGC 2024A", "ngc"),
        ("IC 434", "ic"),
        ("Cr 70", "catalogue"),
        ("Mel 20", "catalogue"),
        ("Abell 21", "catalogue"),
        ("LDN 1622", "catalogue"),
        ("LBN 974", "catalogue"),
        ("HD 37742", "star"),
        ("HIP 26727", "star"),
        ("SAO 132444", "star"),
        ("BD -02 1338", "star"),
        ("ι Ori", "bayer"),
        ("θ1 Ori C", "bayer"),
        ("c Ori", "bayer"),
        ("44 Ori", "flamsteed"),
        ("41 Ori A", "flamsteed"),
        ("XYZ 12", "designation"),
        ("Orion Nebula", "common"),
        ("Hatysa", "common"),
        ("h Persei Cluster", "common"),
        ("Horsehead Nebula", "common"),
    ],
)
def test_name_category(name: str, category: str) -> None:
    assert name_category(name) == category


def test_preference_orders() -> None:
    orion = ["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"]
    assert primary_name(orion, "popular") == "M 42"
    assert primary_name(orion, "ngc_ic") == "NGC 1976"
    assert primary_name(["NGC 1980", "LBN 977", "Lower Sword"], "popular") == "NGC 1980"
    assert primary_name(["IC 434", "Sh2-277", "Horsehead region"], "popular") == "Sh2-277"
    assert primary_name(["IC 434", "Sh2-277"], "ngc_ic") == "IC 434"
    assert primary_name(["NGC 869", "h Persei Cluster", "Cr 24"], "popular") == "NGC 869"
    assert primary_name(["Mel 22", "M 45", "Pleiades"], "popular") == "M 45"
    assert primary_name(["Mel 22", "M 45", "Pleiades"], "ngc_ic") == "M 45"
    assert (
        primary_name(["NGC 7000", "C 20", "LBN 373", "North America Nebula"], "popular") == "C 20"
    )
    assert primary_name(["ι Ori", "44 Ori", "Hatysa"], "popular") == "Hatysa"
    assert primary_name(["ι Ori", "44 Ori", "Hatysa"], "ngc_ic") == "Hatysa"
    assert primary_name(["θ1 Ori C", "41 Ori C"], "popular") == "θ1 Ori C"
    assert primary_name(["45 Ori"], "popular") == "45 Ori"
    assert primary_name(["Alnitak", "HD 37742", "HIP 26727"], "popular") == "Alnitak"


def test_split_names() -> None:
    assert split_names(["ι Ori / 44 Ori", "Hatysa"]) == ["ι Ori", "44 Ori", "Hatysa"]
    assert split_names(["NGC 1976"]) == ["NGC 1976"]
    assert split_names(["OK 1", " ", "OK 1"]) == ["OK 1"]
    assert split_names("not a list") == []


def test_catalog_enrichment_and_normalisation() -> None:
    assert normalise("NGC1976") == normalise("ngc 01976") == "ngc 1976"
    assert enrich_names(["NGC 1976"]) == orion_names()
    assert enrich_names(["M 42"])[:2] == ["M 42", "NGC 1976"]
    assert enrich_names(["NGC 7000"]) == ["NGC 7000", "C 20", "LBN 373", "North America Nebula"]
    assert enrich_names(["NGC 2244"])[:3] == ["NGC 2244", "NGC 2239", "C 50"]  # OpenNGC 'Dup'
    assert enrich_names(["Hatysa"]) == ["Hatysa"]
    assert enrich_names(["NGC 1976", "ngc1976", "Orion Nebula"]) == [
        "NGC 1976",
        "Orion Nebula",
        "M 42",
        "LBN 974",
        "Great Orion Nebula",
    ]


def orion_names() -> list[str]:
    return ["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"]


def test_recorded_fixture_is_scaled_enriched_and_ordered() -> None:
    raw = load_fixture("annotations.json")["annotations"]
    objects = objects_from_nova(raw, 2.0)
    assert len(objects) == len(raw) == 20  # nothing is merged
    assert [o.id for o in objects] == list(range(1, 21))
    biggest = objects[0]
    assert biggest.catalog_names == orion_names()
    assert biggest.primary_name == "M 42"
    assert biggest.aliases == ["NGC 1976", "LBN 974", "Great Orion Nebula", "Orion Nebula"]
    src = next(a for a in raw if a["names"] == ["NGC 1976"])
    assert (biggest.x, biggest.y, biggest.radius) == (
        src["pixelx"] * 2,
        src["pixely"] * 2,
        src["radius"] * 2,
    )
    by_primary = {o.primary_name: o for o in objects}
    assert by_primary["Hatysa"].catalog_names == ["ι Ori", "44 Ori", "Hatysa"]
    assert by_primary["Hatysa"].type == "bright"
    assert by_primary["M 43"].catalog_names == ["NGC 1982", "M 43", "Mairan's Nebula"]
    assert by_primary["Trapezium"].aliases == ["θ1 Ori A", "41 Ori A"]
    # NGC 1980 and ι Ori share a position but stay separate objects
    assert abs(by_primary["NGC 1980"].x - by_primary["Hatysa"].x) < 1
    radii = [o.radius for o in objects]
    assert radii == sorted(radii, reverse=True)


def test_invalid_entries_are_skipped() -> None:
    raw = [
        {"names": [], "type": "ngc", "pixelx": 1, "pixely": 1, "radius": 1},
        {"names": ["X"], "type": "ngc", "pixelx": "nope", "pixely": 1},
        {"type": "ngc", "pixelx": 1, "pixely": 1},
        {"names": ["OK 1", " ", "OK 1"], "type": "ngc", "pixelx": 10, "pixely": 20},
    ]
    objects = objects_from_nova(raw, 1.0)
    assert len(objects) == 1
    assert objects[0].catalog_names == ["OK 1"]
    assert objects[0].radius == 0.0
