"""(Re)generate tests/fixtures/names/vectors.json: the name ranking and alias line the
TypeScript port must reproduce.

For every distinct catalogue-name list in both nova fixtures (OpenNGC-enriched, as the objects
table stores them) and a hand-written edge set, the file records each name's category and, under
both preferences, the primary line and the alias line at every cap 0..MAX_ALIASES.
``tests/test_names_vectors.py`` (models.py must still produce it) and
``frontend/src/editor/names.test.ts`` (the port) replay it. Run from backend/:
python scripts/make_names_vectors.py   (``make names-vectors``)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import REPO_ROOT
from app.models import MAX_ALIASES, NamePreference, alias_names, name_category, primary_name
from app.objects import objects_from_nova

OUT = REPO_ROOT / "tests" / "fixtures" / "names" / "vectors.json"
FIXTURES = (
    REPO_ROOT / "backend" / "tests" / "fixtures" / "nova",
    REPO_ROOT / "backend" / "tests" / "fixtures" / "nova-narrow",
)
PREFERENCES: tuple[NamePreference, ...] = ("popular", "ngc_ic")

# Shapes the fixtures do not contain: Greek and Latin Bayer letters with and without a
# component, Flamsteed numbers, HD/HIP twins with and without a proper name, unknown prefixes,
# nested and case-variant common names, stray whitespace, a lone star id, every cap edge.
EDGE_CASES: tuple[list[str], ...] = (
    ["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"],
    ["Mel 22", "M 45", "Pleiades"],
    [
        "NGC 6618",
        "M 17",
        "LBN 60",
        "Checkmark Nebula",
        "Lobster Nebula",
        "Swan Nebula",
        "omega Nebula",
    ],
    ["ζ Ori", "Alnitak", "HD 37742", "HIP 26727"],
    ["HD 37742", "HIP 26727"],
    ["HD 198639"],
    ["XYZ 12", "ABC 3"],
    ["θ1 Ori C", "41 Ori C", "HD 37022"],
    # pre-split shape (ingest splits on ' / '): pins the tie rule — both `common`, nova order wins
    ["ι Ori / 44 Ori", "Hatysa"],
    ["c Ori", "42 Ori", "Mizan Batil I"],
    ["NGC 1", "the Witch Head Nebula", "WITCH HEAD NEBULA"],
    ["NGC 1", "Eyes", "Eyes Galaxy"],
    ["NGC 1", "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"],
    [" NGC 2024 ", "Flame Nebula", "Sh2-277"],
    ["IC 434", "Sh2-277", "Horsehead region"],
    ["B 33", "Horsehead Nebula", "LDN 1630"],
    ["C 14", "NGC 869", "h Persei Cluster", "Cr 24"],
    ["Messier 31", "NGC 224", "Andromeda Galaxy", "UGC 454", "PGC 2557"],
    ["Mintaka"],
)


def name_lists() -> list[list[str]]:
    seen: set[tuple[str, ...]] = set()
    out: list[list[str]] = []
    for names in list(EDGE_CASES) + [
        obj.catalog_names
        for fixtures_dir in FIXTURES
        for obj in objects_from_nova(
            json.loads((fixtures_dir / "annotations.json").read_text(encoding="utf-8"))[
                "annotations"
            ],
            1.0,
        )
    ]:
        key = tuple(names)
        if key in seen:
            continue
        seen.add(key)
        out.append(list(names))
    return out


def case(names: list[str]) -> dict[str, Any]:
    doc: dict[str, Any] = {"names": names, "categories": [name_category(n) for n in names]}
    for preference in PREFERENCES:
        doc[preference] = {
            "primary": primary_name(names, preference),
            "aliases": {
                str(cap): alias_names(names, preference, cap) for cap in range(MAX_ALIASES + 1)
            },
        }
    return doc


def build_vectors() -> dict[str, Any]:
    return {"max_aliases": MAX_ALIASES, "cases": [case(names) for names in name_lists()]}


def dump(doc: dict[str, Any]) -> str:
    """One case per line, so a diff shows which object changed."""
    lines = ["{", f' "max_aliases": {doc["max_aliases"]},', ' "cases": [']
    cases = doc["cases"]
    for i, item in enumerate(cases):
        sep = "," if i < len(cases) - 1 else ""
        lines.append(f"  {json.dumps(item, ensure_ascii=False, separators=(',', ':'))}{sep}")
    lines += [" ]", "}"]
    return "\n".join(lines) + "\n"


def main() -> None:
    doc = build_vectors()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(dump(doc), encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}: {len(doc['cases'])} cases")


if __name__ == "__main__":
    main()
