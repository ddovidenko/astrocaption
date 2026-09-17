"""Build app/catalog/names.json from OpenNGC (CC BY-SA 4.0).

Usage (from backend/):  python scripts/build_names_catalog.py [--from DIR]

Downloads NGC.csv and addendum.csv from the OpenNGC repository (or reads them from DIR)
and writes ``{"aliases": [...], "kinds": {...}}``: name groups such as
``["NGC 1976", "M 42", ...]`` for every object with an alias worth showing, and the kind
(galaxy / nebula / cluster) of every object whose OpenNGC type has one.
"""

from __future__ import annotations

import csv
import json
import re
import sys
import urllib.request
from pathlib import Path

RAW = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/"
FILES = ("NGC.csv", "addendum.csv")
OUT = Path(__file__).resolve().parent.parent / "app" / "catalog" / "names.json"

# Identifier prefixes worth showing on a label (star ids, survey ids and galaxy catalogues
# such as PGC/UGC/MCG/2MASX/IRAS/LEDA/MWSC are deliberately left out).
KEEP_PREFIXES = {
    "C",
    "Cr",
    "Mel",
    "Tr",
    "Sh2",
    "Sh",
    "LBN",
    "LDN",
    "B",
    "vdB",
    "Ced",
    "RCW",
    "Gum",
    "Abell",
    "Arp",
    "Stock",
    "King",
    "Berkeley",
    "Be",
    "Ru",
    "Pismis",
    "Westerlund",
    "Basel",
    "Haffner",
    "Bochum",
    "Czernik",
    "Dolidze",
    "Roslund",
    "Harvard",
    "Hickson",
    "HCG",
    "Pal",
    "Terzan",
    "Jones",
    "Minkowski",
    "PK",
    "PNG",
    "Mrk",
    "SNR",
    "CTB",
    "DWB",
    "VV",
    "AM",
    "Hodge",
}
NAME_RE = re.compile(r"^([A-Za-z]+)0*(\d+)(.*)$")

# OpenNGC's Type column folded into the editor's four buckets (spec § C "Objects tab"). Types not
# listed (stars, associations, novae, non-existent and duplicate entries) get no entry: the API
# reports them as "other".
KIND_BY_TYPE: dict[str, str] = {
    "G": "galaxy",
    "GPair": "galaxy",
    "GTrpl": "galaxy",
    "GGroup": "galaxy",
    "Neb": "nebula",
    "EmN": "nebula",
    "RfN": "nebula",
    "HII": "nebula",
    "PN": "nebula",
    "SNR": "nebula",
    "DrkN": "nebula",
    # Cluster + nebulosity (M 42, the Cocoon, the Running Man, War and Peace): astrophotographers
    # look for these under "nebula", not "cluster".
    "Cl+N": "nebula",
    "OCl": "cluster",
    "GCl": "cluster",
}


def pretty(designation: str) -> str:
    """``NGC1976`` → ``NGC 1976``, ``C 031`` → ``C 31``, ``Mel022`` → ``Mel 22``."""
    d = " ".join(designation.split())
    m = NAME_RE.match(d.replace(" ", "", 1) if re.match(r"^[A-Za-z]+ \d", d) else d)
    if not m:
        return d
    prefix, number, rest = m.groups()
    return f"{prefix} {number}{rest}"


def load_rows(source: Path | None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for name in FILES:
        if source is not None:
            text = (source / name).read_text(encoding="utf-8")
        else:
            with urllib.request.urlopen(RAW + name, timeout=120) as resp:
                text = resp.read().decode("utf-8")
        rows.extend(csv.DictReader(text.splitlines(), delimiter=";"))
    return rows


def build(rows: list[dict[str, str]]) -> tuple[list[list[str]], dict[str, str]]:
    by_name: dict[str, dict[str, str]] = {r["Name"]: r for r in rows}
    groups: list[list[str]] = []
    kinds: dict[str, str] = {}
    for row in rows:
        canonical = row
        extra: list[str] = []
        if row["Type"] == "Dup":
            target = (
                f"NGC{row['NGC']}" if row.get("NGC") else f"IC{row['IC']}" if row.get("IC") else ""
            )
            if target in by_name:
                canonical = by_name[target]
                extra.append(pretty(target))
        kind = KIND_BY_TYPE.get(canonical["Type"])
        if kind is not None:
            kinds[pretty(row["Name"])] = kind
        names: list[str] = [pretty(row["Name"])] + extra
        if canonical.get("M"):
            names.append(f"M {int(canonical['M'])}")
        for ident in canonical.get("Identifiers", "").split(","):
            ident = ident.strip()
            m = re.match(r"^([A-Za-z]+)", ident)
            if not m or m.group(1) not in KEEP_PREFIXES:
                continue
            names.append(pretty(ident))
        for common in canonical.get("Common names", "").split(","):
            common = common.strip()
            if common:
                names.append(common)
        deduped: list[str] = []
        for n in names:
            if n not in deduped:
                deduped.append(n)
        if len(deduped) > 1:
            groups.append(deduped)
    return groups, kinds


def main(argv: list[str]) -> int:
    source = Path(argv[argv.index("--from") + 1]) if "--from" in argv else None
    groups, kinds = build(load_rows(source))
    payload = {"aliases": groups, "kinds": kinds}
    OUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(
        f"wrote {OUT.name}: {len(groups)} groups, {len(kinds)} kinds, {OUT.stat().st_size // 1024} KB"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
