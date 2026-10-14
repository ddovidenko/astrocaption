from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app import catalog
from app.catalog import (
    CatalogObject,
    ObjectsCatalog,
    enrich_names,
    kind_for,
    normalise,
    unit_vector,
)
from app.models import (
    MAX_LABELS,
    SolveObject,
    StyleConfig,
    StyleOverrides,
    alias_names,
    name_category,
    primary_name,
)
from app.objects import kind_of, merge_objects, objects_from_catalog, objects_from_nova, split_names
from app.wcs import Wcs
from tests.conftest import NOVA_FIXTURES, NOVA_NARROW_FIXTURES, load_fixture


def test_primary_name_prefers_messier() -> None:
    assert primary_name(["NGC 1976", "M 42", "Orion Nebula"]) == "M 42"
    assert primary_name(["NGC 2024", "Flame Nebula"]) == "NGC 2024"
    assert primary_name(["Mintaka"]) == "Mintaka"


def test_primary_name_rejects_an_empty_list() -> None:
    with pytest.raises(ValueError):
        primary_name([])


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
    assert biggest.aliases == ["Great Orion Nebula", "NGC 1976"]
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


def test_narrow_field_keeps_hd_stars_separate_from_their_bright_twins() -> None:
    """nova lists 56 Cyg and 57 Cyg twice on the 1° Pelican field: as ``bright`` entries
    and again as ``hd`` entries at the same pixel. They stay separate objects."""
    raw = load_fixture("annotations.json", NOVA_NARROW_FIXTURES)["annotations"]
    objects = objects_from_nova(raw, 1.0)
    assert [o.type for o in objects].count("hd") == 5
    assert all(o.radius == 0 for o in objects if o.type == "hd")
    assert all(primary_name(o.catalog_names).startswith("HD ") for o in objects if o.type == "hd")

    pelican = objects[0]
    assert pelican.id == 1 and pelican.type == "ic"
    assert pelican.catalog_names == ["IC 5070", "LBN 350", "Pelican Nebula"]

    by_name = {primary_name(o.catalog_names): o for o in objects}
    for bright, hd in (("56 Cyg", "HD 198639"), ("57 Cyg", "HD 199081")):
        assert abs(by_name[bright].x - by_name[hd].x) <= 1
        assert abs(by_name[bright].y - by_name[hd].y) <= 1
        assert by_name[bright].type == "bright" and by_name[hd].type == "hd"


ORION = orion_names()


def test_alias_line_common_first_nested_dropped_then_ranking_order_capped() -> None:
    assert alias_names(ORION, "popular", 2) == ["Great Orion Nebula", "NGC 1976"]
    assert alias_names(ORION, "popular", 5) == ["Great Orion Nebula", "NGC 1976", "LBN 974"]
    assert alias_names(ORION, "ngc_ic", 2) == ["Great Orion Nebula", "M 42"]
    assert alias_names(["Mel 22", "M 45", "Pleiades"], "popular", 2) == ["Pleiades", "Mel 22"]
    assert alias_names(ORION, "popular", 0) == []


def test_alias_line_drops_star_ids_and_unknown_abbreviations_only_when_something_better_exists() -> (
    None
):
    assert alias_names(["ζ Ori", "Alnitak", "HD 37742", "HIP 26727"], "popular", 5) == ["ζ Ori"]
    assert alias_names(["HD 37742", "HIP 26727"], "popular", 5) == ["HIP 26727"]
    assert alias_names(["XYZ 12", "ABC 3"], "popular", 5) == ["ABC 3"]


def test_alias_line_nesting_is_case_insensitive_and_whole_string() -> None:
    assert alias_names(["NGC 1", "the Witch Head Nebula", "WITCH HEAD NEBULA"], "popular", 5) == [
        "the Witch Head Nebula"
    ]
    assert alias_names(["NGC 1", "Eyes", "Eyes Galaxy"], "popular", 5) == ["Eyes Galaxy"]
    assert alias_names(["NGC 1", "Alpha", "Beta", "Gamma"], "popular", 5) == [
        "Alpha",
        "Beta",
        "Gamma",
    ]


def test_solve_object_alias_line_uses_the_policy() -> None:
    obj = SolveObject(id=1, catalog_names=ORION, type="ngc", x=0, y=0, radius=1)
    assert obj.aliases_for("popular", 2) == ["Great Orion Nebula", "NGC 1976"]
    assert obj.aliases == ["Great Orion Nebula", "NGC 1976"]


def test_max_aliases_bounds() -> None:
    assert StyleConfig().max_aliases == 2
    assert StyleConfig(max_aliases=0).max_aliases == 0
    with pytest.raises(ValidationError):
        StyleConfig(max_aliases=6)
    with pytest.raises(ValidationError):
        StyleOverrides(max_aliases=-1)


def test_kind_for_reads_openngc_types() -> None:
    assert kind_for(["NGC 1976", "M 42"]) == "nebula"
    assert kind_for(["NGC 7000"]) == "nebula"  # North America Nebula, type "HII"
    assert kind_for(["ngc0224"]) == "galaxy"  # normalised like every other lookup
    assert kind_for(["NGC 1912"]) == "cluster"
    # NGC 2239 (the Rosette's cluster+nebulosity) is OpenNGC type "Cl+N", so it's a nebula, not a
    # cluster; NGC 2244 is its OpenNGC 'Dup' and inherits the same kind.
    assert kind_for(["NGC 2239"]) == "nebula"
    assert kind_for(["NGC 2244"]) == "nebula"
    assert kind_for(["Hatysa"]) is None
    assert kind_for([]) is None


def test_kind_for_rejects_an_unknown_kind_in_the_bundled_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """names.json is built at image-build time, so a kind outside the three is a deployment
    defect: the catalogue must say so instead of quietly dropping the row."""
    bad = tmp_path / "names.json"
    bad.write_text(json.dumps({"aliases": [], "kinds": {"NGC 1": "comet"}}), encoding="utf-8")
    monkeypatch.setattr(catalog, "NAMES_FILE", bad)
    try:
        catalog._data.cache_clear()
        catalog._kinds.cache_clear()
        catalog._index.cache_clear()
        with pytest.raises(ValueError, match="comet"):
            kind_for(["NGC 1"])
    finally:
        catalog._data.cache_clear()
        catalog._kinds.cache_clear()
        catalog._index.cache_clear()


# --- the local catalogue: hits through the WCS, merged into nova's objects (#17) -------------


def cat_obj(
    names: tuple[str, ...], ra: float, dec: float, radius_arcmin: float, type_: str
) -> CatalogObject:
    return CatalogObject(names, ra, dec, radius_arcmin, type_, unit_vector(ra, dec))


def test_objects_from_catalog_projects_scales_and_skips_what_is_outside() -> None:
    wcs = Wcs.from_text((NOVA_FIXTURES / "wcs.fits").read_text(encoding="ascii"))
    catalog = ObjectsCatalog(
        "t",
        (
            cat_obj(("Sh2-279",), 83.85, -4.85, 10.0, "sharpless"),  # in the Orion field
            cat_obj(("PGC 1",), 10.0, 10.0, 1.0, "pgc"),  # far away
            cat_obj(("B 33",), 85.2458, -2.4583, 3.0, "barnard"),  # Horsehead: outside this frame
        ),
    )
    hits = objects_from_catalog(wcs, 2.0, catalog)
    assert [h.catalog_names[0] for h in hits] == ["Sh2-279"]
    hit = hits[0]
    assert hit.type == "sharpless" and hit.id == 0
    unscaled = wcs.sky_to_pixel(83.85, -4.85)
    assert unscaled is not None
    assert (hit.x, hit.y) == pytest.approx((unscaled[0] * 2.0, unscaled[1] * 2.0))
    assert hit.radius == pytest.approx(10.0 / 60 / wcs.plate_scale_deg() * 2.0)


def nova_obj(
    id_: int, names: list[str], type_: str, x: float, y: float, radius: float
) -> SolveObject:
    return SolveObject(id=id_, catalog_names=names, type=type_, x=x, y=y, radius=radius)


def test_kind_of_uses_the_source_for_catalogue_objects_and_names_for_novas() -> None:
    assert kind_of(nova_obj(1, ["PGC 5"], "pgc", 0, 0, 1)) == "galaxy"
    assert kind_of(nova_obj(1, ["LDN 1"], "ldn", 0, 0, 1)) == "nebula"
    assert kind_of(nova_obj(1, ["ι Ori"], "bright", 0, 0, 0)) == "star"
    assert kind_of(nova_obj(1, ["NGC 1976", "M 42"], "ngc", 0, 0, 1)) == "nebula"
    assert kind_of(nova_obj(1, ["XYZ 1"], "ngc", 0, 0, 1)) == "other"


def test_merge_by_name_appends_names_and_keeps_novas_position() -> None:
    existing = [nova_obj(1, ["NGC 6334", "Cat's Paw Nebula"], "ngc", 100.0, 100.0, 50.0)]
    hits = [nova_obj(0, ["Sh2-8", "NGC 6334", "LBN 7"], "sharpless", 103.0, 99.0, 80.0)]
    merged = merge_objects(existing, hits, next_id=2)
    assert len(merged) == 1
    assert merged[0].id == 1
    assert (merged[0].x, merged[0].y, merged[0].radius) == (100.0, 100.0, 50.0)
    assert merged[0].catalog_names == ["NGC 6334", "Cat's Paw Nebula", "Sh2-8", "LBN 7"]
    assert merged[0].type == "ngc"
    assert existing[0].catalog_names == ["NGC 6334", "Cat's Paw Nebula"]  # the input is untouched


def test_merge_by_position_only_within_half_the_smaller_radius_and_same_kind() -> None:
    nebula = nova_obj(1, ["NGC 1977"], "ngc", 1000.0, 1000.0, 60.0)
    star = nova_obj(2, ["ι Ori"], "bright", 2000.0, 2000.0, 0.0)
    close = nova_obj(0, ["Sh2-279"], "sharpless", 1010.0, 1005.0, 40.0)  # 11 px < 20 (half of 40)
    far = nova_obj(0, ["LBN 974"], "lbn", 1030.0, 1000.0, 40.0)  # 30 px > 20
    on_the_star = nova_obj(0, ["LDN 9"], "ldn", 2000.0, 2000.0, 30.0)  # same spot, other kind
    merged = merge_objects([nebula, star], [close, far, on_the_star], next_id=3)
    by_first = {o.catalog_names[0]: o for o in merged}
    assert by_first["NGC 1977"].catalog_names == ["NGC 1977", "Sh2-279"]
    assert "LBN 974" in by_first and "LDN 9" in by_first
    assert by_first["ι Ori"].catalog_names == ["ι Ori"]


def test_merge_appends_hits_after_existing_ids_by_radius_then_name() -> None:
    existing = [
        nova_obj(1, ["NGC 1"], "ngc", 0.0, 0.0, 10.0),
        nova_obj(2, ["NGC 2"], "ngc", 500.0, 500.0, 5.0),
    ]
    hits = [
        nova_obj(0, ["PGC 3"], "pgc", 900.0, 900.0, 2.0),
        nova_obj(0, ["B 10"], "barnard", 800.0, 800.0, 9.0),
        nova_obj(0, ["B 2"], "barnard", 700.0, 700.0, 9.0),
    ]
    merged = merge_objects(existing, hits, next_id=7)
    assert [(o.id, o.catalog_names[0]) for o in merged] == [
        (1, "NGC 1"),
        (2, "NGC 2"),
        (7, "B 10"),
        (8, "B 2"),
        (9, "PGC 3"),
    ]


def test_merge_caps_the_document_dropping_the_smallest_hits() -> None:
    existing = [
        nova_obj(i, [f"NGC {i}"], "ngc", float(i), 0.0, 1.0) for i in range(1, MAX_LABELS - 1)
    ]
    hits = [nova_obj(0, [f"PGC {i}"], "pgc", 10_000.0 + i, 0.0, float(i)) for i in range(1, 6)]
    merged = merge_objects(existing, hits, next_id=MAX_LABELS)
    assert len(merged) == MAX_LABELS
    assert [o.catalog_names[0] for o in merged[-2:]] == ["PGC 5", "PGC 4"]


def test_a_hit_matching_two_existing_objects_by_name_joins_the_first() -> None:
    existing = [
        nova_obj(1, ["NGC 10"], "ngc", 0.0, 0.0, 1.0),
        nova_obj(2, ["IC 10"], "ic", 50.0, 50.0, 1.0),
    ]
    hits = [nova_obj(0, ["PGC 1", "NGC 10", "IC 10"], "pgc", 1.0, 1.0, 1.0)]
    merged = merge_objects(existing, hits, next_id=3)
    assert [o.catalog_names for o in merged] == [["NGC 10", "PGC 1"], ["IC 10"]]


def test_merge_never_joins_through_a_group_designation() -> None:
    """Arp 270 is the pair NGC 3395/3396: the second galaxy must not fold into the first through
    the group number the first hit appended."""
    existing = [nova_obj(1, ["NGC 3395"], "ngc", 100.0, 100.0, 30.0)]
    hits = [
        nova_obj(0, ["PGC 32424", "NGC 3395", "Arp 270"], "pgc", 101.0, 100.0, 25.0),
        nova_obj(0, ["PGC 32434", "NGC 3396", "Arp 270"], "pgc", 400.0, 400.0, 20.0),
    ]
    merged = merge_objects(existing, hits, next_id=2)
    assert [o.catalog_names[0] for o in merged] == ["NGC 3395", "PGC 32434"]
    assert merged[0].catalog_names == ["NGC 3395", "PGC 32424", "Arp 270"]
    assert merged[1].catalog_names == ["PGC 32434", "NGC 3396", "Arp 270"]


def test_a_dark_nebula_is_never_folded_into_a_bright_one_by_position() -> None:
    """B 168 sits inside the Cocoon's radius and is labelled on its own by every atlas."""
    cocoon = nova_obj(1, ["IC 5146"], "ic", 1000.0, 1000.0, 120.0)
    b168 = nova_obj(0, ["B 168"], "barnard", 1010.0, 1000.0, 100.0)  # 10 px, well inside 50
    ldn = nova_obj(0, ["LDN 1055"], "ldn", 1005.0, 1000.0, 90.0)
    merged = merge_objects([cocoon], [b168, ldn], next_id=2)
    assert [o.catalog_names[0] for o in merged] == ["IC 5146", "B 168", "LDN 1055"]
    assert merged[0].catalog_names == ["IC 5146"]
