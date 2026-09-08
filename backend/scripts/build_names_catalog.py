"""Build app/catalog/names.json from OpenNGC (CC BY-SA 4.0).

Usage (from backend/):  python scripts/build_names_catalog.py [--from DIR]

Downloads NGC.csv and addendum.csv from the OpenNGC repository (or reads them from DIR)
and writes name groups: every deep-sky object that has at least one alias worth showing
becomes ``["NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula"]``.
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


def build(rows: list[dict[str, str]]) -> list[list[str]]:
    by_name: dict[str, dict[str, str]] = {r["Name"]: r for r in rows}
    groups: list[list[str]] = []
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
    return groups


def main(argv: list[str]) -> int:
    source = Path(argv[argv.index("--from") + 1]) if "--from" in argv else None
    groups = build(load_rows(source))
    OUT.write_text(
        json.dumps(groups, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(f"wrote {OUT.name}: {len(groups)} groups, {OUT.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
