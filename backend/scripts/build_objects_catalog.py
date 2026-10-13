"""Build app/catalog/objects.json from five CDS VizieR tables (see CDS-ATTRIBUTION.md).

Usage (from backend/):  python scripts/build_objects_catalog.py [--from DIR] [--version YYYY-MM-DD]

Downloads Sharpless (VII/20), Barnard (VII/220A), LDN (VII/7A), LBN (VII/9) and PGC (VII/237,
D25 ≥ 1′) as TSV, or reads ``DIR/<source>.tsv``, and writes ``{"version": ..., "objects":
[{"names", "ra", "dec", "radius_arcmin", "type"}, ...]}``: the objects nova does not annotate,
looked up by position through each image's stored WCS (SPEC § 5.2, #17).
"""

from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "catalog" / "objects.json"
VIZIER = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"

# J2000 degrees come from VizieR's computed columns (_RAJ2000/_DEJ2000), so the 1900 and 1950
# epochs of the older lists never reach this code.
QUERIES: dict[str, str] = {
    "sharpless": f"{VIZIER}?-source=VII/20&-out.max=unlimited&-out=Sh2,Diam&-out.add=_RAJ2000,_DEJ2000",
    "barnard": f"{VIZIER}?-source=VII/220A&-out.max=unlimited&-out=Barn,Diam&-out.add=_RAJ2000,_DEJ2000",
    "ldn": f"{VIZIER}?-source=VII/7A&-out.max=unlimited&-out=LDN,Area&-out.add=_RAJ2000,_DEJ2000",
    "lbn": f"{VIZIER}?-source=VII/9&-out.max=unlimited&-out=Seq,Diam1,Diam2,Name&-out.add=_RAJ2000,_DEJ2000",
    # logD25 is log10 of D25 in 0.1 arcmin: 1.0 is a one-arcminute galaxy. The cut is server-side.
    "pgc": f"{VIZIER}?-source=VII/237&-out.max=unlimited&-out=PGC,logD25,ANames&-out.add=_RAJ2000,_DEJ2000&logD25=>=1.0",
}

# A Barnard or LBN row without a size still marks a real object; a modest default keeps it
# listed (and, at 5′, below the default-enabled threshold on most fields).
DEFAULT_RADIUS_ARCMIN = 5.0

# PGC cross-names worth carrying (they are what the merge with nova's objects matches on).
KEEP_CROSS = {"NGC", "IC", "UGC", "ARP"}
_CROSS = re.compile(r"^\(?([A-Za-z]+)0*(\d+[A-Za-z]?)\)?$")
_LBN_SHARPLESS = re.compile(r"^S\s*(\d+)$")

Row = dict[str, object]


def designation(prefix: str, number: str) -> str:
    """``NGC`` + ``7814`` → ``NGC 7814``; ``ARP`` → ``Arp``."""
    prefix = "Arp" if prefix.upper() == "ARP" else prefix.upper()
    return f"{prefix} {number}"


def parse_tsv(text: str) -> list[dict[str, str]]:
    """VizieR's asu-tsv: comments, a blank line, the header, a units line, a dashes line, rows."""
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    if len(lines) < 3:
        return []
    header = [h.strip() for h in lines[0].split("\t")]
    rows: list[dict[str, str]] = []
    for line in lines[3:]:
        cells = [c.strip() for c in line.split("\t")]
        if len(cells) != len(header):
            continue
        rows.append(dict(zip(header, cells, strict=True)))
    return rows


def _number(row: dict[str, str], column: str) -> int | None:
    """The row's catalogue number, or None for the few unnumbered entries (nothing to call
    them, so no object)."""
    text = row.get(column, "").strip()
    return int(text) if text.isdigit() else None


def _position(row: dict[str, str]) -> tuple[float, float]:
    return float(row["_RAJ2000"]), float(row["_DEJ2000"])


def _radius_from_diameter(text: str) -> float:
    try:
        d = float(text)
    except ValueError:
        return DEFAULT_RADIUS_ARCMIN
    return d / 2 if d > 0 else DEFAULT_RADIUS_ARCMIN


def _row(names: list[str], ra: float, dec: float, radius: float, type_: str) -> Row:
    return {"names": names, "ra": ra, "dec": dec, "radius_arcmin": radius, "type": type_}


def rows_from_sharpless(rows: Iterable[dict[str, str]]) -> list[Row]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        n = _number(r, "Sh2")
        if n is None:
            continue
        radius = _radius_from_diameter(r["Diam"])
        out.append(_row([f"Sh2-{n}"], ra, dec, radius, "sharpless"))
    return out


def rows_from_barnard(rows: Iterable[dict[str, str]]) -> list[Row]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        if not r["Barn"].strip():
            continue
        radius = _radius_from_diameter(r["Diam"])
        out.append(_row([f"B {r['Barn'].strip()}"], ra, dec, radius, "barnard"))
    return out


def rows_from_ldn(rows: Iterable[dict[str, str]]) -> list[Row]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        try:
            area = float(r["Area"])
        except ValueError:
            area = 0.0
        radius = math.sqrt(area / math.pi) * 60 if area > 0 else DEFAULT_RADIUS_ARCMIN
        n = _number(r, "LDN")
        if n is None:
            continue
        out.append(_row([f"LDN {n}"], ra, dec, radius, "ldn"))
    return out


def rows_from_lbn(rows: Iterable[dict[str, str]]) -> list[Row]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        diameters = [float(d) for d in (r["Diam1"], r["Diam2"]) if d]
        largest = max(diameters) if diameters else 0.0
        radius = largest / 2 if largest > 0 else DEFAULT_RADIUS_ARCMIN
        n = _number(r, "Seq")
        if n is None:
            continue
        names = [f"LBN {n}"]
        m = _LBN_SHARPLESS.match(r.get("Name", ""))
        if m:
            names.append(f"Sh2-{int(m.group(1))}")
        out.append(_row(names, ra, dec, radius, "lbn"))
    return out


def rows_from_pgc(rows: Iterable[dict[str, str]]) -> list[Row]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        radius = 10 ** float(r["logD25"]) * 0.1 / 2
        n = _number(r, "PGC")
        if n is None:
            continue
        names = [f"PGC {n}"]
        for token in r.get("ANames", "").split():
            m = _CROSS.match(token)
            if m and m.group(1).upper() in KEEP_CROSS:
                name = designation(m.group(1), m.group(2))
                if name not in names:
                    names.append(name)
        out.append(_row(names, ra, dec, radius, "pgc"))
    return out


PARSERS: dict[str, Callable[[Iterable[dict[str, str]]], list[Row]]] = {
    "sharpless": rows_from_sharpless,
    "barnard": rows_from_barnard,
    "ldn": rows_from_ldn,
    "lbn": rows_from_lbn,
    "pgc": rows_from_pgc,
}


def _names(row: Row) -> list[str]:
    names = row["names"]
    assert isinstance(names, list)
    return names


def build(tables: dict[str, str]) -> list[Row]:
    """Every source's rows, then: an LBN row naming a Sharpless number joins that Sharpless row
    (names merged, larger radius kept); rows whose first name repeats keep the larger radius."""
    rows: list[Row] = []
    for source, parser in PARSERS.items():
        rows.extend(parser(parse_tsv(tables[source])))
    by_name: dict[str, Row] = {}
    unique: list[Row] = []
    for r in rows:
        names = _names(r)
        existing = next((by_name[n] for n in names if n in by_name), None)
        if existing is None:
            for n in names:
                by_name[n] = r
            unique.append(r)
            continue
        # Fold: keep the existing row, take the union of names and the larger radius.
        merged = _names(existing)
        for n in names:
            if n not in merged:
                merged.append(n)
                by_name[n] = existing
        existing["radius_arcmin"] = max(
            float(existing["radius_arcmin"]),  # type: ignore[arg-type]
            float(r["radius_arcmin"]),  # type: ignore[arg-type]
        )
    return unique


def fetch(source: str) -> str:
    with urllib.request.urlopen(QUERIES[source], timeout=300) as resp:
        return str(resp.read().decode("utf-8"))


def main(argv: list[str]) -> int:
    source_dir = Path(argv[argv.index("--from") + 1]) if "--from" in argv else None
    version = (
        argv[argv.index("--version") + 1]
        if "--version" in argv
        else dt.datetime.now(dt.UTC).date().isoformat()
    )
    tables: dict[str, str] = {}
    for source in PARSERS:
        if source_dir is not None:
            tables[source] = (source_dir / f"{source}.tsv").read_text(encoding="utf-8")
        else:
            tables[source] = fetch(source)
    rows = build(tables)
    payload = {"version": version, "objects": rows}
    OUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    counts = {source: sum(1 for r in rows if r["type"] == source) for source in PARSERS}
    print(
        f"wrote {OUT.name} (version {version}): {len(rows)} objects,"
        f" {OUT.stat().st_size // 1024} KB; {counts}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
