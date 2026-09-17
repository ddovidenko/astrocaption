from __future__ import annotations

from scripts.build_names_catalog import KIND_BY_TYPE, build


def row(name: str, type_: str, **extra: str) -> dict[str, str]:
    base = {
        "Name": name,
        "Type": type_,
        "M": "",
        "NGC": "",
        "IC": "",
        "Identifiers": "",
        "Common names": "",
    }
    base.update(extra)
    return base


def test_build_maps_openngc_types_to_kinds_and_keeps_aliases() -> None:
    rows = [
        row("NGC1976", "HII", M="042", **{"Common names": "Orion Nebula"}),
        row("NGC0224", "G", M="031"),
        row("NGC1912", "OCl", M="038"),
        row("NGC2239", "Dup", NGC="2244"),  # OpenNGC duplicate: takes its target's kind
        row("NGC2244", "OCl", Identifiers="C 050"),
        row("NGC2017", "*Ass"),  # a star association: no kind entry, so the API says "other"
        row("B033", "DrkN", **{"Common names": "Horsehead Nebula"}),
    ]
    groups, kinds = build(rows)
    assert ["NGC 1976", "M 42", "Orion Nebula"] in groups
    assert kinds == {
        "NGC 1976": "nebula",
        "NGC 224": "galaxy",
        "NGC 1912": "cluster",
        "NGC 2239": "cluster",
        "NGC 2244": "cluster",
        "B 33": "nebula",
    }


def test_kind_table_covers_the_spec_buckets() -> None:
    assert {t for t, k in KIND_BY_TYPE.items() if k == "galaxy"} == {
        "G",
        "GPair",
        "GTrpl",
        "GGroup",
    }
    assert {t for t, k in KIND_BY_TYPE.items() if k == "nebula"} == {
        "Neb",
        "EmN",
        "RfN",
        "HII",
        "PN",
        "SNR",
        "DrkN",
    }
    assert {t for t, k in KIND_BY_TYPE.items() if k == "cluster"} == {"OCl", "GCl", "Cl+N"}
    for other in ("*", "**", "*Ass", "Nova", "NonEx", "Dup", "Other"):
        assert other not in KIND_BY_TYPE
