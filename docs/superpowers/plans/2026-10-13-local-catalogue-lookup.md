# Local Catalogue Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A solved image gets objects nova never annotates (Sharpless, Barnard, LDN, LBN, PGC galaxies ≥ 1′) by projecting a bundled catalogue through the WCS the solve already stored, at solve time and once at startup for existing images.

**Architecture:** A build script turns five VizieR tables into `backend/app/catalog/objects.json`. A pure-Python TAN+SIP projection (`app/wcs.py`) maps catalogue positions into solve-copy pixels. `app/objects.py` merges the hits into nova's objects by name, then narrowly by position. The worker runs the lookup after every solve; `app/catalog_backfill.py` runs it at startup over images whose `objects_catalog` stamp is behind the shipped catalogue version, feeding the result through the existing re-solve rematch so existing labels are untouched.

**Tech Stack:** Python 3.13+ stdlib only (no astropy, no numpy), FastAPI, sqlite3, pytest. VizieR TSV endpoint for the build (network, build time only). Playwright for the e2e counts.

**Spec:** `docs/superpowers/specs/2026-10-13-local-catalogue-lookup-design.md`

## Global Constraints

- No new runtime dependency. The projection and the catalogue loader are stdlib only. (CLAUDE.md: ask before adding a dependency; the image must stay under 400 MB.)
- Never call nova during tests; the recorded fixtures under `backend/tests/fixtures/nova/` (Orion, 3.9°) and `backend/tests/fixtures/nova-narrow/` (Pelican, 1°) are the only solver data.
- API responses never carry server paths or raw exception text; `WcsError(public, detail)` follows `ConfigError`'s shape: `public` is for the log line's sentence, `detail` for the log only.
- Annotation geometry is stored in original image pixels. The WCS describes the solve copy; multiply by `solve_scale` at the edge, as `objects_from_nova` does.
- Existing object ids never change: nova's objects keep ids 1..n exactly as today; catalogue objects are appended after.
- `MAX_LABELS = 5000` (models.py) bounds a document; the merge must respect it.
- Backend commands run from `backend/` with `.venv/bin/python` / `.venv/bin/pytest`; `make lint test` before every commit; `ruff format` on every touched Python file.
- Commits: conventional messages, end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage by path, never `git add -A`.
- Secrets never in the repo; subagents never touch `data/`.
- Name formats: `Sh2-279`, `B 33`, `LDN 1622`, `LBN 974`, `PGC 68029` (the ranking regexes in models.py already classify these).

## Review Focus

1. A header whose `CTYPE` is plain `RA---TAN` (no SIP terms): projection must work with identity distortion. Pinned in Task 5.
2. A catalogue object on the far side of the sky (gnomonic denominator ≤ 0): `sky_to_pixel` must return None, never a finite but absurd pixel. Pinned in Task 5.
3. An image with `solve_scale ≠ 1`: hit positions and radii must be multiplied, exactly like nova's. Pinned in Task 6.
4. A solved image with no annotations row (a solve that never built a layout): the backfill must skip it without raising and without stamping. Pinned in Task 10.
5. A corrupt or missing `objects.json` in a build: the loader must raise one clear error at startup rather than serve an empty catalogue silently. Pinned in Task 1.

---

## File map

| File | Responsibility |
|---|---|
| `backend/app/catalog/__init__.py` (modify) | Add `Source`, `KIND_BY_SOURCE`, `CatalogObject`, `ObjectsCatalog`, `load_objects_catalog`, `objects_catalog()` |
| `backend/app/catalog/objects.json` (create, generated) | The shipped catalogue |
| `backend/app/catalog/CDS-ATTRIBUTION.md` (create) | Attribution for the five tables |
| `backend/scripts/build_objects_catalog.py` (create) | VizieR → `objects.json` |
| `backend/tests/test_build_objects_catalog.py` (create) | Builder tests, shipped-file test |
| `backend/app/wcs.py` (create) | FITS card parsing, TAN+SIP both ways |
| `backend/tests/test_wcs.py` (create) | Oracle, round trip, no-SIP, malformed |
| `backend/app/objects.py` (modify) | `objects_from_catalog`, `merge_objects` |
| `backend/tests/test_objects.py` (modify) | Merge tests |
| `backend/app/api/images.py` (modify) | `_object_out` kind map |
| `backend/app/db.py` (modify) | Migration 6, `images_for_catalog_backfill` |
| `backend/app/models.py` (modify) | `ImageRecord.objects_catalog` |
| `backend/tests/test_db.py` (modify) | Migration test |
| `backend/app/worker.py` (modify) | Lookup after `objects_from_nova`, stamp |
| `backend/tests/test_worker.py` (modify) | Solve-time test |
| `backend/app/catalog_backfill.py` (create) | Startup backfill |
| `backend/tests/test_catalog_backfill.py` (create) | Backfill tests |
| `backend/app/main.py` (modify) | Call the backfill in the lifespan |
| `Makefile`, `CLAUDE.md`, `docs/SPEC.md`, `docs/INSTALL.md`, `docs/ARCHITECTURE.md` (modify) | Target and docs |
| `frontend/e2e/panel.spec.ts` (modify) | Counts follow the real result |

PR 1 = Tasks 1–3. PR 2 = Tasks 4–5. PR 3 = Tasks 6–11.

---

## PR 1: data and builder

### Task 1: Catalogue loader in `app/catalog`

**Files:**
- Modify: `backend/app/catalog/__init__.py`
- Test: `backend/tests/test_build_objects_catalog.py` (new; the builder's tests join it in Task 2)

**Interfaces:**
- Produces:
  - `Source = Literal["sharpless", "lbn", "barnard", "ldn", "pgc"]`
  - `KIND_BY_SOURCE: dict[str, Kind]` — `sharpless/lbn/barnard/ldn → "nebula"`, `pgc → "galaxy"`
  - `@dataclass(frozen=True) class CatalogObject: names: tuple[str, ...]; ra: float; dec: float; radius_arcmin: float; type: str; unit: tuple[float, float, float]` (unit vector of the position, precomputed at load)
  - `@dataclass(frozen=True) class ObjectsCatalog: version: str; objects: tuple[CatalogObject, ...]`
  - `load_objects_catalog(path: Path) -> ObjectsCatalog` (raises `ValueError` naming the problem)
  - `objects_catalog() -> ObjectsCatalog` (cached, reads `OBJECTS_FILE`)
  - `OBJECTS_FILE = Path(__file__).with_name("objects.json")`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_build_objects_catalog.py
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from app.catalog import KIND_BY_SOURCE, CatalogObject, load_objects_catalog


def write_catalog(path: Path, objects: list[dict[str, object]], version: str = "2026-10-13") -> Path:
    path.write_text(json.dumps({"version": version, "objects": objects}), encoding="utf-8")
    return path


def test_load_objects_catalog_reads_rows_and_precomputes_unit_vectors(tmp_path: Path) -> None:
    path = write_catalog(
        tmp_path / "objects.json",
        [{"names": ["Sh2-279"], "ra": 83.85, "dec": -4.85, "radius_arcmin": 10.0, "type": "sharpless"}],
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
        ({"names": ["B 1"], "ra": 1.0, "dec": 1.0, "radius_arcmin": 0.0, "type": "barnard"}, "radius"),
        ({"names": ["B 1"], "ra": 400.0, "dec": 1.0, "radius_arcmin": 1.0, "type": "barnard"}, "ra"),
        ({"names": ["B 1"], "ra": 1.0, "dec": 1.0, "radius_arcmin": 1.0, "type": "comet"}, "type"),
    ],
)
def test_load_objects_catalog_refuses_a_bad_row(tmp_path: Path, row: dict[str, object], problem: str) -> None:
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_objects_catalog.py`
Expected: FAIL with `ImportError: cannot import name 'KIND_BY_SOURCE'`.

- [ ] **Step 3: Add the loader to `app/catalog/__init__.py`**

Append after `enrich_names` (keep the existing imports; add `math`, `dataclass`, `get_args` is already imported):

```python
# --- the positional catalogue (objects.json), SPEC § 5.2 "Local catalogue" ---------------

Source = Literal["sharpless", "lbn", "barnard", "ldn", "pgc"]

# The kind an object of each source reports (ObjectOut.kind). Dark nebulae are nebulae: the
# Objects tab has no fourth bucket.
KIND_BY_SOURCE: dict[str, Kind] = {
    "sharpless": "nebula",
    "lbn": "nebula",
    "barnard": "nebula",
    "ldn": "nebula",
    "pgc": "galaxy",
}

OBJECTS_FILE = Path(__file__).with_name("objects.json")


@dataclass(frozen=True)
class CatalogObject:
    """One row of objects.json. ``unit`` is the J2000 direction as a unit vector, precomputed
    so a field lookup is one dot product per row."""

    names: tuple[str, ...]
    ra: float
    dec: float
    radius_arcmin: float
    type: str
    unit: tuple[float, float, float]


@dataclass(frozen=True)
class ObjectsCatalog:
    version: str
    objects: tuple[CatalogObject, ...]


def unit_vector(ra_deg: float, dec_deg: float) -> tuple[float, float, float]:
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    return (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec))


def load_objects_catalog(path: Path) -> ObjectsCatalog:
    """Read and validate a catalogue file. Every problem is a ``ValueError`` naming the file:
    the file is bundled at build time, so a bad row is a defect in the generator, never
    something to skip quietly."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{path.name}: cannot be read ({exc})") from exc
    if not isinstance(data, dict) or not isinstance(data.get("version"), str):
        raise ValueError(f"{path.name}: no version string")
    rows = data.get("objects")
    if not isinstance(rows, list):
        raise ValueError(f"{path.name}: no objects list")
    objects: list[CatalogObject] = []
    for i, row in enumerate(rows):
        try:
            names = tuple(str(n) for n in row["names"])
            ra, dec = float(row["ra"]), float(row["dec"])
            radius = float(row["radius_arcmin"])
            type_ = str(row["type"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{path.name}: row {i} is malformed ({exc})") from exc
        if not names or not all(names):
            raise ValueError(f"{path.name}: row {i} has no names")
        if not (0.0 <= ra < 360.0) or not (-90.0 <= dec <= 90.0):
            raise ValueError(f"{path.name}: row {i} ({names[0]}) has ra/dec out of range")
        if not (radius > 0.0) or not math.isfinite(radius):
            raise ValueError(f"{path.name}: row {i} ({names[0]}) has no positive radius")
        if type_ not in KIND_BY_SOURCE:
            raise ValueError(f"{path.name}: row {i} ({names[0]}) has unknown type {type_!r}")
        objects.append(CatalogObject(names, ra, dec, radius, type_, unit_vector(ra, dec)))
    return ObjectsCatalog(version=data["version"], objects=tuple(objects))


@lru_cache(maxsize=1)
def objects_catalog() -> ObjectsCatalog:
    """The shipped catalogue, read once."""
    return load_objects_catalog(OBJECTS_FILE)
```

Add `import math` and `from dataclasses import dataclass` to the module's imports. Extend the module docstring's first paragraph with one sentence: "``objects.json`` (CDS tables, see ``CDS-ATTRIBUTION.md``) adds objects nova does not annotate, looked up by position through the stored WCS."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_objects_catalog.py`
Expected: 7 passed.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/catalog/__init__.py tests/test_build_objects_catalog.py && cd .. && make lint
git add backend/app/catalog/__init__.py backend/tests/test_build_objects_catalog.py
git commit -m "feat: loader and kinds for the positional objects catalogue (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The builder script

**Files:**
- Create: `backend/scripts/build_objects_catalog.py`
- Test: `backend/tests/test_build_objects_catalog.py` (append)

**Interfaces:**
- Consumes: `KIND_BY_SOURCE` keys as the `type` values.
- Produces:
  - `parse_tsv(text: str) -> list[dict[str, str]]` — VizieR TSV: `#` comment lines, a header line, a units line, a dashes line, then rows; values stripped.
  - `rows_from_sharpless(rows) / rows_from_barnard / rows_from_ldn / rows_from_lbn / rows_from_pgc -> list[dict[str, object]]` each returning catalogue rows `{"names": [...], "ra": float, "dec": float, "radius_arcmin": float, "type": str}`.
  - `build(tables: dict[str, str]) -> list[dict[str, object]]` where keys are the five source names and values the TSV text; applies the per-source parsers, the LBN→Sharpless fold and the same-name dedupe.
  - `QUERIES: dict[str, str]` — the VizieR URL per source.
  - `main(argv) -> int` with `--from DIR` (reads `DIR/<source>.tsv`) and `--version` (defaults to today's date).
- Formatting helper `designation(prefix: str, number: str) -> str` → `"NGC 7814"`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_build_objects_catalog.py`:

```python
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


def test_parse_tsv_skips_comments_units_and_dashes() -> None:
    rows = parse_tsv(SHARPLESS_TSV)
    assert rows == [
        {"_RAJ2000": "239.713380", "_DEJ2000": "-26.120461", "Sh2": "1", "Diam": "150"},
        {"_RAJ2000": "083.850000", "_DEJ2000": "-04.850000", "Sh2": "279", "Diam": "20"},
    ]


def test_sharpless_rows() -> None:
    rows = rows_from_sharpless(parse_tsv(SHARPLESS_TSV))
    assert rows[1] == {"names": ["Sh2-279"], "ra": 83.85, "dec": -4.85, "radius_arcmin": 10.0, "type": "sharpless"}


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
        {"sharpless": SHARPLESS_TSV, "barnard": BARNARD_TSV, "ldn": LDN_TSV, "lbn": LBN_TSV, "pgc": PGC_TSV}
    )
    by_first = {r["names"][0]: r for r in rows}
    # LBN 974 names S 279: it joins Sh2-279 (names merged, larger radius kept) and is not its own row.
    assert "LBN 974" not in by_first
    assert by_first["Sh2-279"]["names"] == ["Sh2-279", "LBN 974"]
    assert by_first["Sh2-279"]["radius_arcmin"] == 30.0
    # Two Barnard rows called B 33: one row, the larger radius.
    assert sum(1 for r in rows if r["names"][0] == "B 33") == 1
    assert by_first["B 33"]["radius_arcmin"] == 3.0
    # Every row is loadable by the app's validator.
    assert {r["type"] for r in rows} == {"sharpless", "barnard", "ldn", "lbn", "pgc"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_objects_catalog.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.build_objects_catalog'`.

- [ ] **Step 3: Write the builder**

```python
# backend/scripts/build_objects_catalog.py
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
from collections.abc import Iterable
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


def _position(row: dict[str, str]) -> tuple[float, float]:
    return float(row["_RAJ2000"]), float(row["_DEJ2000"])


def _radius_from_diameter(text: str) -> float:
    try:
        d = float(text)
    except ValueError:
        return DEFAULT_RADIUS_ARCMIN
    return d / 2 if d > 0 else DEFAULT_RADIUS_ARCMIN


def _row(names: list[str], ra: float, dec: float, radius: float, type_: str) -> dict[str, object]:
    return {"names": names, "ra": ra, "dec": dec, "radius_arcmin": radius, "type": type_}


def rows_from_sharpless(rows: Iterable[dict[str, str]]) -> list[dict[str, object]]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        out.append(_row([f"Sh2-{int(r['Sh2'])}"], ra, dec, _radius_from_diameter(r["Diam"]), "sharpless"))
    return out


def rows_from_barnard(rows: Iterable[dict[str, str]]) -> list[dict[str, object]]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        out.append(_row([f"B {r['Barn'].strip()}"], ra, dec, _radius_from_diameter(r["Diam"]), "barnard"))
    return out


def rows_from_ldn(rows: Iterable[dict[str, str]]) -> list[dict[str, object]]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        try:
            area = float(r["Area"])
        except ValueError:
            area = 0.0
        radius = math.sqrt(area / math.pi) * 60 if area > 0 else DEFAULT_RADIUS_ARCMIN
        out.append(_row([f"LDN {int(r['LDN'])}"], ra, dec, radius, "ldn"))
    return out


def rows_from_lbn(rows: Iterable[dict[str, str]]) -> list[dict[str, object]]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        diameters = [float(d) for d in (r["Diam1"], r["Diam2"]) if d]
        radius = max(diameters) / 2 if diameters and max(diameters) > 0 else DEFAULT_RADIUS_ARCMIN
        names = [f"LBN {int(r['Seq'])}"]
        m = _LBN_SHARPLESS.match(r.get("Name", ""))
        if m:
            names.append(f"Sh2-{int(m.group(1))}")
        out.append(_row(names, ra, dec, radius, "lbn"))
    return out


def rows_from_pgc(rows: Iterable[dict[str, str]]) -> list[dict[str, object]]:
    out = []
    for r in rows:
        ra, dec = _position(r)
        radius = 10 ** float(r["logD25"]) * 0.1 / 2
        names = [f"PGC {int(r['PGC'])}"]
        for token in r.get("ANames", "").split():
            m = _CROSS.match(token)
            if m and m.group(1).upper() in KEEP_CROSS:
                name = designation(m.group(1), m.group(2))
                if name not in names:
                    names.append(name)
        out.append(_row(names, ra, dec, radius, "pgc"))
    return out


PARSERS = {
    "sharpless": rows_from_sharpless,
    "barnard": rows_from_barnard,
    "ldn": rows_from_ldn,
    "lbn": rows_from_lbn,
    "pgc": rows_from_pgc,
}


def build(tables: dict[str, str]) -> list[dict[str, object]]:
    """Every source's rows, then: an LBN row naming a Sharpless number joins that Sharpless row
    (names merged, larger radius kept); rows whose first name repeats keep the larger radius."""
    rows: list[dict[str, object]] = []
    for source, parser in PARSERS.items():
        rows.extend(parser(parse_tsv(tables[source])))
    by_name: dict[str, dict[str, object]] = {}
    for r in rows:
        names = r["names"]
        assert isinstance(names, list)
        existing = next((by_name[n] for n in names if n in by_name), None)
        if existing is None:
            for n in names:
                by_name[n] = r
            continue
        # Fold: keep the existing row, take the union of names and the larger radius.
        merged_names = list(existing["names"])  # type: ignore[arg-type]
        for n in names:
            if n not in merged_names:
                merged_names.append(n)
                by_name[n] = existing
        existing["names"] = merged_names
        existing["radius_arcmin"] = max(float(existing["radius_arcmin"]), float(r["radius_arcmin"]))  # type: ignore[arg-type]
    unique: list[dict[str, object]] = []
    seen: set[int] = set()
    for r in by_name.values():
        if id(r) not in seen:
            seen.add(id(r))
            unique.append(r)
    return unique


def fetch(source: str) -> str:
    with urllib.request.urlopen(QUERIES[source], timeout=300) as resp:
        return resp.read().decode("utf-8")


def main(argv: list[str]) -> int:
    source_dir = Path(argv[argv.index("--from") + 1]) if "--from" in argv else None
    version = argv[argv.index("--version") + 1] if "--version" in argv else dt.date.today().isoformat()
    tables: dict[str, str] = {}
    for source in PARSERS:
        tables[source] = (source_dir / f"{source}.tsv").read_text(encoding="utf-8") if source_dir else fetch(source)
    rows = build(tables)
    OUT.write_text(json.dumps({"version": version, "objects": rows}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    counts = {source: sum(1 for r in rows if r["type"] == source) for source in PARSERS}
    print(f"wrote {OUT.name} (version {version}): {len(rows)} objects, {OUT.stat().st_size // 1024} KB; {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

Note on the fold order in `build`: the LBN row for S 279 carries the names `["LBN 974", "Sh2-279"]`; the Sharpless row `["Sh2-279"]` was registered first, so the LBN row folds into it and the result's first name stays `Sh2-279` with `LBN 974` appended, as the test expects.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_objects_catalog.py`
Expected: 14 passed.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format scripts/build_objects_catalog.py tests/test_build_objects_catalog.py && cd .. && make lint
git add backend/scripts/build_objects_catalog.py backend/tests/test_build_objects_catalog.py
git commit -m "feat: builder for the positional objects catalogue from five VizieR tables (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Ship the catalogue, the attribution, the make target and the shipped-file test

**Files:**
- Create: `backend/app/catalog/objects.json` (generated), `backend/app/catalog/CDS-ATTRIBUTION.md`
- Modify: `Makefile` (target + `.PHONY`), `CLAUDE.md` (commands block)
- Test: `backend/tests/test_build_objects_catalog.py` (append)

- [ ] **Step 1: Add the Makefile target** after `names-catalog`:

```make
objects-catalog: $(VENV)/.installed ## Rebuild backend/app/catalog/objects.json from five CDS VizieR tables (network)
	cd backend && .venv/bin/python scripts/build_objects_catalog.py
```

Add `objects-catalog` to the `.PHONY` line. In `CLAUDE.md`'s commands block, after the `make names-catalog` line:

```
make objects-catalog     # rebuild backend/app/catalog/objects.json (Sharpless/Barnard/LDN/LBN/PGC) from VizieR (network)
```

- [ ] **Step 2: Write the attribution file** `backend/app/catalog/CDS-ATTRIBUTION.md`:

```markdown
# objects.json — derived from CDS VizieR tables

`objects.json` is generated by `scripts/build_objects_catalog.py` from these catalogues, obtained
through the VizieR service of the Centre de Données astronomiques de Strasbourg (CDS,
<https://vizier.cds.unistra.fr>). Each row keeps a designation, a J2000 position and a size.

| VizieR | Catalogue | Reference |
|---|---|---|
| VII/20 | Catalogue of HII Regions (Sharpless 1959) | Sharpless S., ApJS 4, 257 (1959) |
| VII/220A | Barnard's Catalogue of 349 Dark Objects (Barnard 1927) | Barnard E.E., Carnegie Inst. Washington Publ. 247 (1927); Dobek G.A. ed., 2011 |
| VII/7A | Lynds' Catalogue of Dark Nebulae (Lynds 1962) | Lynds B.T., ApJS 7, 1 (1962) |
| VII/9 | Lynds' Catalogue of Bright Nebulae (Lynds 1965) | Lynds B.T., ApJS 12, 163 (1965) |
| VII/237 | HYPERLEDA I. Catalog of galaxies (PGC 2003) | Paturel G. et al., A&A 412, 45 (2003) |

This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France
(DOI: 10.26093/cds/vizier). The original description of VizieR is Ochsenbein F. et al.,
A&AS 143, 23 (2000). The PGC galaxies are limited to D25 ≥ 1′ (`logD25 ≥ 1.0`).

The rest of AstroCaption is MIT licensed; the derived table is distributed with this attribution.
Regenerate with `make objects-catalog`.
```

- [ ] **Step 3: Build the catalogue (network)**

Run: `make objects-catalog`
Expected: a line like `wrote objects.json (version 2026-10-13): ~25000 objects, ~1500 KB; {'sharpless': 313, 'barnard': ~340, 'ldn': ~1800, 'lbn': ~1100, 'pgc': 22800}`. Record the exact numbers in the commit message. If VizieR is unreachable, stop and say so; do not hand-write the file.

- [ ] **Step 4: Write the shipped-file test** (append to `backend/tests/test_build_objects_catalog.py`):

```python
from app.catalog import objects_catalog


def test_the_shipped_catalogue_loads_and_carries_the_landmarks() -> None:
    cat = objects_catalog()
    assert cat.version
    assert len(cat.objects) > 20_000
    names = {n for o in cat.objects for n in o.names}
    for landmark in ("Sh2-279", "B 33", "LDN 1622", "LBN 974", "PGC 68029", "NGC 7209"):
        assert landmark in names, landmark
    # Sh2-8 is the Cat's Paw (NGC 6334): the LBN fold carried the cross-id into one row.
    sh2_8 = next(o for o in cat.objects if "Sh2-8" in o.names)
    assert sh2_8.type == "sharpless"
    assert all(o.radius_arcmin > 0 for o in cat.objects)
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_build_objects_catalog.py`
Expected: 15 passed. If a landmark is missing, inspect the TSV (`--from` a saved dir) before changing the test: the landmark list is the spec's.

- [ ] **Step 6: Lint, full tests, commit, PR**

```bash
make lint test
git add Makefile CLAUDE.md backend/app/catalog/objects.json backend/app/catalog/CDS-ATTRIBUTION.md backend/tests/test_build_objects_catalog.py
git commit -m "feat: ship objects.json (Sharpless, Barnard, LDN, LBN, PGC ≥ 1′) with CDS attribution (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/local-catalogue-lookup
```

Open PR 1 (`gh pr create`) titled `feat: positional objects catalogue: data, builder, loader (#17, 1/3)`; body: what the file is, the row counts, "Part 1 of 3 for #17; no behaviour change yet", the 🤖 footer. No `Closes` line (PR 3 closes #17). `gh pr checks --watch`; wait for "merge".

---

## PR 2: the projection

Branch from `main` after PR 1 merges: `git checkout -b feat/wcs-projection`.

### Task 4: FITS card parsing and `WcsError`

**Files:**
- Create: `backend/app/wcs.py`
- Test: `backend/tests/test_wcs.py`

**Interfaces:**
- Produces:
  - `class WcsError(Exception): public: str; detail: str` (same shape as `ConfigError`).
  - `parse_cards(text: str) -> dict[str, float | str]` — every `KEY = value` card; numbers as float, quoted strings stripped.
  - `@dataclass(frozen=True) class Wcs: crval: tuple[float, float]; crpix: tuple[float, float]; cd: tuple[float, float, float, float]; width: int; height: int; a: dict[tuple[int, int], float]; b: ...; ap: ...; bp: ...` with `@classmethod from_text(text) -> Wcs`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_wcs.py
from __future__ import annotations

import math

import pytest

from app.wcs import Wcs, WcsError, parse_cards
from tests.conftest import NOVA_FIXTURES, NOVA_NARROW_FIXTURES

ORION = (NOVA_FIXTURES / "wcs.fits").read_text(encoding="ascii")
PELICAN = (NOVA_NARROW_FIXTURES / "wcs.fits").read_text(encoding="ascii")


def test_parse_cards_reads_numbers_strings_and_ignores_comments() -> None:
    cards = parse_cards(ORION)
    assert cards["CTYPE1"] == "RA---TAN-SIP"
    assert cards["CRVAL1"] == pytest.approx(84.4663663446)
    assert cards["IMAGEW"] == 3000
    assert cards["A_ORDER"] == 2
    assert "SIMPLE" in cards and cards["SIMPLE"] == "T"


def test_wcs_from_text_reads_the_orion_header() -> None:
    wcs = Wcs.from_text(ORION)
    assert wcs.width == 3000 and wcs.height == 2250
    assert wcs.crpix == pytest.approx((599.724601746, 964.673423767))
    assert wcs.a[(2, 0)] == pytest.approx(7.07500197684e-07)
    assert wcs.bp[(0, 0)] == pytest.approx(-1.60105921188e-05)


def card(key: str, value: str) -> str:
    return f"{key:<8}= {value:<70}"[:80]


MINIMAL_TAN = "".join(
    card(k, v)
    for k, v in [
        ("CTYPE1", "'RA---TAN'"),
        ("CTYPE2", "'DEC--TAN'"),
        ("CRVAL1", "84.0"),
        ("CRVAL2", "-4.0"),
        ("CRPIX1", "1500.0"),
        ("CRPIX2", "1125.0"),
        ("CD1_1", "-0.001"),
        ("CD1_2", "0.0"),
        ("CD2_1", "0.0"),
        ("CD2_2", "0.001"),
        ("IMAGEW", "3000"),
        ("IMAGEH", "2250"),
    ]
)


def test_wcs_from_text_accepts_a_tan_header_without_sip() -> None:
    wcs = Wcs.from_text(MINIMAL_TAN)
    assert wcs.a == {} and wcs.ap == {}
    assert wcs.crval == (84.0, -4.0)


@pytest.mark.parametrize(
    ("text", "public"),
    [
        ("", "no WCS"),
        (MINIMAL_TAN.replace("CRPIX2", "CRPIXX"), "CRPIX2"),
        (MINIMAL_TAN.replace("'RA---TAN'", "'RA---SIN'"), "projection"),
        ("garbage that is not a header at all", "no WCS"),
    ],
)
def test_wcs_from_text_refuses_a_bad_header_with_a_named_reason(text: str, public: str) -> None:
    with pytest.raises(WcsError) as caught:
        Wcs.from_text(text)
    assert public in caught.value.public
    assert caught.value.detail  # for the log
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_wcs.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.wcs'`.

- [ ] **Step 3: Write the parser**

```python
# backend/app/wcs.py
"""The stored WCS header (nova's ``wcs.fits`` text), parsed and projected both ways.

TAN (gnomonic) projection with SIP distortion, pure stdlib: astropy would cost more than a
quarter of the image budget. ``sky_to_pixel`` is what the local catalogue lookup uses
(SPEC § 5.2); ``pixel_to_sky`` gives the field's centre and radius. Pixels follow the FITS
convention nova writes its own annotations in (one-based, no half-pixel shift needed: the
oracle test in tests/test_wcs.py pins this against nova's positions to a hundredth of a pixel).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

CARD = 80
_SIP_KEY = re.compile(r"^(A|B|AP|BP)_(\d+)_(\d+)$")
_REQUIRED = ("CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CD1_1", "CD1_2", "CD2_1", "CD2_2", "IMAGEW", "IMAGEH")


class WcsError(Exception):
    """A header the lookup cannot use. ``public`` names the problem in a sentence; ``detail``
    is for the server log."""

    def __init__(self, public: str, detail: str | None = None) -> None:
        super().__init__(public)
        self.public = public
        self.detail = detail or public


def parse_cards(text: str) -> dict[str, float | str]:
    """Every ``KEY = value`` card of an 80-column FITS header. Numbers become floats, quoted
    strings lose their quotes and padding, comments after ``/`` are dropped."""
    cards: dict[str, float | str] = {}
    for i in range(0, len(text), CARD):
        chunk = text[i : i + CARD]
        if len(chunk) < 10 or chunk[8:10] != "= ":
            continue
        key = chunk[:8].strip()
        rest = chunk[10:]
        if rest.lstrip().startswith("'"):
            value: float | str = rest.split("'")[1].strip()
        else:
            raw = rest.split("/", 1)[0].strip()
            try:
                value = float(raw)
            except ValueError:
                value = raw
        if key:
            cards[key] = value
    return cards


@dataclass(frozen=True)
class Wcs:
    crval: tuple[float, float]
    crpix: tuple[float, float]
    cd: tuple[float, float, float, float]  # CD1_1, CD1_2, CD2_1, CD2_2
    width: int
    height: int
    a: dict[tuple[int, int], float]
    b: dict[tuple[int, int], float]
    ap: dict[tuple[int, int], float]
    bp: dict[tuple[int, int], float]

    @classmethod
    def from_text(cls, text: str) -> Wcs:
        cards = parse_cards(text)
        if not cards or "CTYPE1" not in cards:
            raise WcsError("the stored solve holds no WCS header", f"{len(cards)} cards, no CTYPE1")
        ctype1, ctype2 = str(cards.get("CTYPE1")), str(cards.get("CTYPE2"))
        if not ctype1.startswith("RA---TAN") or not ctype2.startswith("DEC--TAN"):
            raise WcsError(
                "the stored WCS uses a projection this build cannot read",
                f"CTYPE1={ctype1!r} CTYPE2={ctype2!r}",
            )
        missing = [k for k in _REQUIRED if not isinstance(cards.get(k), float)]
        if missing:
            raise WcsError(f"the stored WCS header lacks {', '.join(missing)}", f"missing {missing}")
        polys: dict[str, dict[tuple[int, int], float]] = {"A": {}, "B": {}, "AP": {}, "BP": {}}
        for key, value in cards.items():
            m = _SIP_KEY.match(key)
            if m and isinstance(value, float):
                polys[m.group(1)][(int(m.group(2)), int(m.group(3)))] = value
        f = lambda k: float(cards[k])  # noqa: E731 - a local shorthand, mypy knows the floats
        return cls(
            crval=(f("CRVAL1"), f("CRVAL2")),
            crpix=(f("CRPIX1"), f("CRPIX2")),
            cd=(f("CD1_1"), f("CD1_2"), f("CD2_1"), f("CD2_2")),
            width=int(f("IMAGEW")),
            height=int(f("IMAGEH")),
            a=polys["A"],
            b=polys["B"],
            ap=polys["AP"],
            bp=polys["BP"],
        )
```

(`math` is used in Task 5; leave the import.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest -q tests/test_wcs.py`
Expected: 7 passed.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/wcs.py tests/test_wcs.py && cd .. && make lint
git add backend/app/wcs.py backend/tests/test_wcs.py
git commit -m "feat: parse the stored WCS header into a Wcs record (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Projection both ways, with the oracle

**Files:**
- Modify: `backend/app/wcs.py`
- Test: `backend/tests/test_wcs.py` (append)

**Interfaces:**
- Produces on `Wcs`:
  - `sky_to_pixel(self, ra: float, dec: float) -> tuple[float, float] | None` — solve-copy pixels; None when the point is not in front of the tangent plane.
  - `pixel_to_sky(self, x: float, y: float) -> tuple[float, float]` — degrees, RA in [0, 360).
  - `plate_scale_deg(self) -> float` — degrees per pixel, `sqrt(|det CD|)`.
  - `field(self) -> tuple[tuple[float, float, float], float]` — unit vector of the frame centre and the angular radius in degrees covering the four corners.
- Module function `unit_vector(ra, dec)` is imported from `app.catalog` (Task 1); do not duplicate it.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_wcs.py`)

```python
# J2000 positions from OpenNGC (NGC.csv, sexagesimal → degrees), for the objects nova annotated
# in the two recorded fields. nova's pixelx/pixely for the same objects come from the fixtures.
OPENNGC_DEG = {
    "IC 420": (83.03958, -4.50475),
    "IC 427": (84.07508, -6.61644),
    "IC 428": (84.10088, -6.45156),
    "NGC 1924": (81.47750, -5.30808),  # 05:25:54.6 -05:18:29 (OpenNGC)
    "NGC 1973": (83.76992, -4.73178),
    "NGC 1975": (83.82450, -4.68522),
    "NGC 1976": (83.81867, -5.38967),
    "NGC 1977": (83.81583, -4.84433),
    "NGC 1980": (83.85829, -5.90989),
    "NGC 1981": (83.78996, -4.42506),
    "NGC 1982": (83.88075, -5.26747),
    "NGC 1999": (84.10563, -6.71586),
    "IC 5070": (312.75300, 44.40150),
}


def _nova_pixels(fixtures_dir):  # type: ignore[no-untyped-def]
    import json

    entries = json.loads((fixtures_dir / "annotations.json").read_text())["annotations"]
    return {e["names"][0]: (e["pixelx"], e["pixely"]) for e in entries if e["type"] in ("ngc", "ic")}


@pytest.mark.parametrize(("text", "fixtures_dir"), [(ORION, NOVA_FIXTURES), (PELICAN, NOVA_NARROW_FIXTURES)])
def test_sky_to_pixel_lands_on_novas_own_pixels(text, fixtures_dir) -> None:  # type: ignore[no-untyped-def]
    """The oracle: OpenNGC's J2000 positions, through the stored header, must hit the pixel nova
    reported for the same object. 0.5 px is generous: the real figure is a few hundredths."""
    wcs = Wcs.from_text(text)
    checked = 0
    for name, (px, py) in _nova_pixels(fixtures_dir).items():
        if name not in OPENNGC_DEG:
            continue
        got = wcs.sky_to_pixel(*OPENNGC_DEG[name])
        assert got is not None, name
        assert got[0] == pytest.approx(px, abs=0.5), name
        assert got[1] == pytest.approx(py, abs=0.5), name
        checked += 1
    assert checked >= 1
    if fixtures_dir is NOVA_FIXTURES:
        assert checked == 12  # every NGC/IC entry of the Orion fixture has a position above


@pytest.mark.parametrize("text", [ORION, PELICAN])
def test_pixel_to_sky_round_trips_across_the_frame(text: str) -> None:
    wcs = Wcs.from_text(text)
    for x, y in [(1.0, 1.0), (wcs.width, 1.0), (1.0, wcs.height), (wcs.width, wcs.height), (wcs.width / 2, wcs.height / 2), (137.5, 2001.25)]:
        ra, dec = wcs.pixel_to_sky(x, y)
        assert 0.0 <= ra < 360.0 and -90.0 <= dec <= 90.0
        back = wcs.sky_to_pixel(ra, dec)
        assert back is not None
        assert back[0] == pytest.approx(x, abs=0.01) and back[1] == pytest.approx(y, abs=0.01)


def test_plate_scale_matches_the_cd_matrix() -> None:
    assert Wcs.from_text(ORION).plate_scale_deg() * 3600 == pytest.approx(4.6716, abs=0.001)
    assert Wcs.from_text(PELICAN).plate_scale_deg() * 3600 == pytest.approx(1.9929, abs=0.001)


def test_field_covers_the_corners() -> None:
    wcs = Wcs.from_text(ORION)
    centre, radius_deg = wcs.field()
    assert 2.0 < radius_deg < 3.0  # a 3000x2250 frame at 4.67"/px: half-diagonal ≈ 2.43°
    from app.catalog import unit_vector

    for x, y in [(1.0, 1.0), (wcs.width, wcs.height)]:
        corner = unit_vector(*wcs.pixel_to_sky(x, y))
        dot = sum(a * b for a, b in zip(centre, corner, strict=True))
        assert math.degrees(math.acos(min(1.0, dot))) <= radius_deg + 1e-6


def test_a_point_behind_the_tangent_plane_is_none() -> None:
    wcs = Wcs.from_text(ORION)
    assert wcs.sky_to_pixel(wcs.crval[0] + 180.0, -wcs.crval[1]) is None


def test_a_header_without_sip_projects_as_a_plain_tan() -> None:
    wcs = Wcs.from_text(MINIMAL_TAN)
    assert wcs.sky_to_pixel(84.0, -4.0) == pytest.approx((1500.0, 1125.0))
    # One pixel east: CD1_1 = -0.001 deg/px, so RA grows westwards on the pixel axis.
    ra, _ = wcs.pixel_to_sky(1499.0, 1125.0)
    assert ra > 84.0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_wcs.py`
Expected: FAIL with `AttributeError: 'Wcs' object has no attribute 'sky_to_pixel'`.

- [ ] **Step 3: Implement the projection** (add to the `Wcs` class in `backend/app/wcs.py`, and `from .catalog import unit_vector` at the top)

```python
    # -- projection ---------------------------------------------------------------

    def plate_scale_deg(self) -> float:
        a, b, c, d = self.cd
        return math.sqrt(abs(a * d - b * c))

    def _sip(self, poly: dict[tuple[int, int], float], u: float, v: float) -> float:
        return sum(coef * u**p * v**q for (p, q), coef in poly.items())

    def sky_to_pixel(self, ra: float, dec: float) -> tuple[float, float] | None:
        """Solve-copy pixel of a J2000 position, or None when the point is not in front of the
        tangent plane (the far hemisphere, or on the horizon of the projection)."""
        ra0, dec0 = (math.radians(v) for v in self.crval)
        r, d = math.radians(ra), math.radians(dec)
        cos_c = math.sin(dec0) * math.sin(d) + math.cos(dec0) * math.cos(d) * math.cos(r - ra0)
        if cos_c <= 1e-9:
            return None
        xi = math.degrees(math.cos(d) * math.sin(r - ra0) / cos_c)
        eta = math.degrees(
            (math.cos(dec0) * math.sin(d) - math.sin(dec0) * math.cos(d) * math.cos(r - ra0)) / cos_c
        )
        a, b, c, dd = self.cd
        det = a * dd - b * c
        u = (dd * xi - b * eta) / det
        v = (-c * xi + a * eta) / det
        # The inverse SIP polynomials are evaluated once, on the undistorted offsets.
        du, dv = self._sip(self.ap, u, v), self._sip(self.bp, u, v)
        return self.crpix[0] + u + du, self.crpix[1] + v + dv

    def pixel_to_sky(self, x: float, y: float) -> tuple[float, float]:
        """J2000 degrees of a solve-copy pixel; RA in [0, 360)."""
        u, v = x - self.crpix[0], y - self.crpix[1]
        fu, fv = u + self._sip(self.a, u, v), v + self._sip(self.b, u, v)
        a, b, c, d = self.cd
        xi, eta = math.radians(a * fu + b * fv), math.radians(c * fu + d * fv)
        ra0, dec0 = (math.radians(w) for w in self.crval)
        denom = math.cos(dec0) - eta * math.sin(dec0)
        ra = ra0 + math.atan2(xi, denom)
        dec = math.atan2(
            (math.sin(dec0) + eta * math.cos(dec0)) * math.cos(ra - ra0), denom
        )
        return math.degrees(ra) % 360.0, math.degrees(dec)

    def field(self) -> tuple[tuple[float, float, float], float]:
        """Unit vector of the frame centre and the angular radius (degrees) that covers the four
        corners: the pre-filter for a catalogue lookup."""
        centre = unit_vector(*self.pixel_to_sky((self.width + 1) / 2, (self.height + 1) / 2))
        radius = 0.0
        for x, y in ((1.0, 1.0), (float(self.width), 1.0), (1.0, float(self.height)), (float(self.width), float(self.height))):
            corner = unit_vector(*self.pixel_to_sky(x, y))
            dot = max(-1.0, min(1.0, sum(p * q for p, q in zip(centre, corner, strict=True))))
            radius = max(radius, math.degrees(math.acos(dot)))
        return centre, radius
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest -q tests/test_wcs.py`
Expected: 15 passed. If the oracle fails by a constant offset of 1.0 or 0.5 px in both axes, the pixel convention is wrong: the throwaway projection during planning matched nova to 0.03 px with exactly `crpix + u + du`, so look for a sign error in `du/dv` or `det` first.

- [ ] **Step 5: Lint, full tests, commit, PR**

```bash
cd backend && .venv/bin/ruff format app/wcs.py tests/test_wcs.py && cd .. && make lint test
git add backend/app/wcs.py backend/tests/test_wcs.py
git commit -m "feat: TAN+SIP projection both ways, pinned against nova's own pixels (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/wcs-projection
```

PR 2: `feat: pure-Python TAN+SIP projection of the stored WCS (#17, 2/3)`. Body: the oracle result (max deviation seen), "no behaviour change yet: nothing calls it", footer. `/code-review low` is not needed (no API). Wait for "merge".

---

## PR 3: merge, worker, backfill, docs

Branch from `main` after PR 2 merges: `git checkout -b feat/catalogue-lookup`.

### Task 6: `objects_from_catalog` and `merge_objects`

**Files:**
- Modify: `backend/app/objects.py`
- Test: `backend/tests/test_objects.py` (append)

**Interfaces:**
- Consumes: `Wcs` (Task 5), `ObjectsCatalog`, `CatalogObject`, `KIND_BY_SOURCE`, `kind_for`, `enrich_names`, `normalise` (Task 1 / existing).
- Produces:
  - `objects_from_catalog(wcs: Wcs, solve_scale: float, catalog: ObjectsCatalog) -> list[SolveObject]` — hits in original pixels, ids all 0 (assigned by `merge_objects`), `type` = the row's source.
  - `merge_objects(existing: list[SolveObject], hits: list[SolveObject], *, next_id: int) -> list[SolveObject]` — existing unchanged in order and ids (names may grow), then appended hits with ids from `next_id`, by descending radius then primary name; capped at `MAX_LABELS`.
  - `kind_of(obj: SolveObject) -> ObjectKind` — the one type→kind rule (used by `merge_objects` and, in Task 7, by the API).

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_objects.py`)

```python
from app.catalog import CatalogObject, ObjectsCatalog, unit_vector
from app.models import MAX_LABELS
from app.objects import kind_of, merge_objects, objects_from_catalog
from app.wcs import Wcs
from tests.conftest import NOVA_FIXTURES


def cat_obj(names: tuple[str, ...], ra: float, dec: float, radius_arcmin: float, type_: str) -> CatalogObject:
    return CatalogObject(names, ra, dec, radius_arcmin, type_, unit_vector(ra, dec))


def test_objects_from_catalog_projects_scales_and_skips_what_is_outside() -> None:
    wcs = Wcs.from_text((NOVA_FIXTURES / "wcs.fits").read_text(encoding="ascii"))
    catalog = ObjectsCatalog(
        "t",
        (
            cat_obj(("Sh2-279",), 83.85, -4.85, 10.0, "sharpless"),  # in the Orion field
            cat_obj(("PGC 1",), 10.0, 10.0, 1.0, "pgc"),  # far away
            cat_obj(("B 33",), 85.2458, -2.4583, 3.0, "barnard"),  # Horsehead: just outside this 3.9° frame
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


def nova_obj(id_: int, names: list[str], type_: str, x: float, y: float, radius: float) -> SolveObject:
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
    assert merged[0].id == 1 and (merged[0].x, merged[0].y, merged[0].radius) == (100.0, 100.0, 50.0)
    assert merged[0].catalog_names == ["NGC 6334", "Cat's Paw Nebula", "Sh2-8", "LBN 7"]
    assert merged[0].type == "ngc"


def test_merge_by_position_only_within_half_the_smaller_radius_and_same_kind() -> None:
    nebula = nova_obj(1, ["NGC 1977"], "ngc", 1000.0, 1000.0, 60.0)
    star = nova_obj(2, ["ι Ori"], "bright", 2000.0, 2000.0, 0.0)
    close = nova_obj(0, ["Sh2-279"], "sharpless", 1010.0, 1005.0, 40.0)  # 11 px < 20 (half of 40)
    far = nova_obj(0, ["LBN 974"], "lbn", 1030.0, 1000.0, 40.0)  # 30 px > 20
    on_the_star = nova_obj(0, ["LDN 9"], "ldn", 2000.0, 2000.0, 30.0)  # same spot, different kind
    merged = merge_objects([nebula, star], [close, far, on_the_star], next_id=3)
    by_first = {o.catalog_names[0]: o for o in merged}
    assert by_first["NGC 1977"].catalog_names == ["NGC 1977", "Sh2-279"]
    assert "LBN 974" in by_first and "LDN 9" in by_first
    assert by_first["ι Ori"].catalog_names == ["ι Ori"]


def test_merge_appends_hits_after_existing_ids_by_radius_then_name() -> None:
    existing = [nova_obj(1, ["NGC 1"], "ngc", 0.0, 0.0, 10.0), nova_obj(2, ["NGC 2"], "ngc", 500.0, 500.0, 5.0)]
    hits = [
        nova_obj(0, ["PGC 3"], "pgc", 900.0, 900.0, 2.0),
        nova_obj(0, ["B 10"], "barnard", 800.0, 800.0, 9.0),
        nova_obj(0, ["B 2"], "barnard", 700.0, 700.0, 9.0),
    ]
    merged = merge_objects(existing, hits, next_id=7)
    assert [(o.id, o.catalog_names[0]) for o in merged] == [(1, "NGC 1"), (2, "NGC 2"), (7, "B 10"), (8, "B 2"), (9, "PGC 3")]


def test_merge_caps_the_document_dropping_the_smallest_hits() -> None:
    existing = [nova_obj(i, [f"NGC {i}"], "ngc", float(i), 0.0, 1.0) for i in range(1, MAX_LABELS - 1)]
    hits = [nova_obj(0, [f"PGC {i}"], "pgc", 10_000.0 + i, 0.0, float(i)) for i in range(1, 6)]
    merged = merge_objects(existing, hits, next_id=MAX_LABELS)
    assert len(merged) == MAX_LABELS
    assert [o.catalog_names[0] for o in merged[-2:]] == ["PGC 5", "PGC 4"]


def test_a_hit_matching_two_existing_objects_by_name_joins_the_first() -> None:
    existing = [nova_obj(1, ["NGC 10"], "ngc", 0.0, 0.0, 1.0), nova_obj(2, ["IC 10"], "ic", 50.0, 50.0, 1.0)]
    hits = [nova_obj(0, ["PGC 1", "NGC 10", "IC 10"], "pgc", 1.0, 1.0, 1.0)]
    merged = merge_objects(existing, hits, next_id=3)
    assert [o.catalog_names for o in merged] == [["NGC 10", "PGC 1", "IC 10"], ["IC 10"]]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_objects.py -k "catalog or merge or kind_of"`
Expected: FAIL with `ImportError: cannot import name 'kind_of'`.

- [ ] **Step 3: Implement** (add to `backend/app/objects.py`)

```python
from .catalog import KIND_BY_SOURCE, ObjectsCatalog, enrich_names, kind_for, normalise
from .models import MAX_LABELS, ObjectKind, SolveObject, primary_name
from .wcs import Wcs

STAR_TYPES = frozenset({"bright", "hd"})


def kind_of(obj: SolveObject) -> ObjectKind:
    """The Objects tab bucket: stars by nova's type, catalogue objects by their source, the rest
    by what the names table knows (SPEC § 6.3)."""
    if obj.type in STAR_TYPES:
        return "star"
    source_kind = KIND_BY_SOURCE.get(obj.type)
    if source_kind is not None:
        return source_kind
    return kind_for(obj.catalog_names) or "other"


def objects_from_catalog(wcs: Wcs, solve_scale: float, catalog: ObjectsCatalog) -> list[SolveObject]:
    """Every catalogue row whose centre lands inside the solve copy, in original pixels, with
    id 0 (``merge_objects`` assigns ids) and the row's source as ``type``."""
    centre, radius_deg = wcs.field()
    scale = wcs.plate_scale_deg()
    hits: list[SolveObject] = []
    for row in catalog.objects:
        # One dot product per row: skip anything farther from the frame centre than the frame's
        # own radius plus the object's, before the projection.
        dot = sum(p * q for p, q in zip(centre, row.unit, strict=True))
        limit = math.radians(radius_deg + row.radius_arcmin / 60)
        if dot < math.cos(min(limit, math.pi)):
            continue
        pixel = wcs.sky_to_pixel(row.ra, row.dec)
        if pixel is None:
            continue
        x, y = pixel
        if not (0.0 <= x <= wcs.width and 0.0 <= y <= wcs.height):
            continue
        hits.append(
            SolveObject(
                id=0,
                catalog_names=enrich_names(list(row.names)),
                type=row.type,
                x=x * solve_scale,
                y=y * solve_scale,
                radius=row.radius_arcmin / 60 / scale * solve_scale,
            )
        )
    return hits


def _joins_by_position(obj: SolveObject, hit: SolveObject) -> bool:
    if obj.radius <= 0 or hit.radius <= 0 or kind_of(obj) != kind_of(hit):
        return False
    return math.hypot(obj.x - hit.x, obj.y - hit.y) <= min(obj.radius, hit.radius) / 2


def merge_objects(existing: list[SolveObject], hits: list[SolveObject], *, next_id: int) -> list[SolveObject]:
    """Fold ``hits`` into ``existing``: by any shared (normalised) name first, then by position
    for the same kind within half the smaller radius; a joined hit adds its names and nothing
    else. The rest are appended with ids from ``next_id`` by descending radius then primary
    name, dropping the smallest beyond ``MAX_LABELS``. ``existing`` keeps its order and ids."""
    merged = [o.model_copy() for o in existing]
    by_name: dict[str, SolveObject] = {}
    for o in merged:
        for n in o.catalog_names:
            by_name.setdefault(normalise(n), o)
    fresh: list[SolveObject] = []
    for hit in hits:
        target = next((by_name[normalise(n)] for n in hit.catalog_names if normalise(n) in by_name), None)
        if target is None:
            target = next((o for o in merged if _joins_by_position(o, hit)), None)
        if target is None:
            fresh.append(hit)
            continue
        for n in hit.catalog_names:
            if normalise(n) not in by_name:
                target.catalog_names.append(n)
                by_name[normalise(n)] = target
    fresh.sort(key=lambda o: (-o.radius, primary_name(o.catalog_names)))
    room = max(0, MAX_LABELS - len(merged))
    for i, hit in enumerate(fresh[:room]):
        merged.append(hit.model_copy(update={"id": next_id + i}))
    return merged
```

Note: `SolveObject.catalog_names` is a plain list on a Pydantic model; `model_copy()` is shallow, so copy the list too: use `o.model_copy(update={"catalog_names": list(o.catalog_names)})` in the first line of `merge_objects` so the caller's objects are never mutated.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest -q tests/test_objects.py`
Expected: all pass (the 7 new ones plus the existing).

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/objects.py tests/test_objects.py && cd .. && make lint
git add backend/app/objects.py backend/tests/test_objects.py
git commit -m "feat: catalogue hits through the WCS, merged into nova's objects by name then position (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The API reports the new kinds

**Files:**
- Modify: `backend/app/api/images.py` (`_object_out`)
- Test: `backend/tests/test_api.py` (append near the existing kind assertions around line 346)

- [ ] **Step 1: Write the failing test**

```python
def test_object_kind_follows_the_catalogue_source(client: TestClient, settings: Settings) -> None:
    from app.api.images import _object_out
    from app.models import SolveObject

    assert _object_out(SolveObject(id=1, catalog_names=["PGC 5"], type="pgc", x=0, y=0, radius=1), "popular").kind == "galaxy"
    assert _object_out(SolveObject(id=1, catalog_names=["B 33"], type="barnard", x=0, y=0, radius=1), "popular").kind == "nebula"
    assert _object_out(SolveObject(id=1, catalog_names=["ι Ori"], type="bright", x=0, y=0, radius=0), "popular").kind == "star"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/pytest -q tests/test_api.py -k catalogue_source`
Expected: FAIL (`kind == "other"` for `pgc`).

- [ ] **Step 3: Use `kind_of`** in `_object_out`:

```python
from ..objects import kind_of

def _object_out(o: SolveObject, preference: NamePreference) -> ObjectOut:
    return ObjectOut(
        id=o.id,
        catalog_names=o.catalog_names,
        primary_name=o.primary_name_for(preference),
        type=o.type,
        kind=kind_of(o),
        x=o.x,
        y=o.y,
        radius=o.radius,
    )
```

Remove the now-unused `kind_for` and `ObjectKind` imports from `api/images.py` if nothing else uses them (ruff will say).

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_api.py`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/api/images.py tests/test_api.py && cd .. && make lint
git add backend/app/api/images.py backend/tests/test_api.py
git commit -m "feat: ObjectOut.kind follows the catalogue source for looked-up objects (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The `objects_catalog` stamp

**Files:**
- Modify: `backend/app/db.py` (SCHEMA, MIGRATIONS, SCHEMA_VERSION, new query), `backend/app/models.py` (`ImageRecord`)
- Test: `backend/tests/test_db.py` (append)

**Interfaces:**
- Produces: `ImageRecord.objects_catalog: str | None = None`; `Database.images_for_catalog_backfill(version: str) -> list[ImageRecord]` — solved images with a `wcs_text` whose stamp is NULL or differs from `version`, oldest first.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_db.py`)

```python
def test_migration_from_v5_adds_the_objects_catalog_stamp(tmp_path: Path) -> None:
    """Images solved before the local catalogue existed read NULL: the startup backfill looks
    them up once (#17)."""
    db = Database(tmp_path / "x.sqlite")
    db.init()
    with db.connect() as conn:  # rewind to the version-5 shape
        conn.execute("ALTER TABLE images DROP COLUMN objects_catalog")
        conn.execute("PRAGMA user_version = 5")
    db.init()
    with db.connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(images)")}
        assert "objects_catalog" in columns
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    db.init()  # idempotent


def test_images_for_catalog_backfill_picks_solved_rows_with_a_wcs_and_a_stale_stamp(tmp_path: Path) -> None:
    from app.models import SolveStatus
    from tests.conftest import make_settings, seed_image

    settings = make_settings(tmp_path)
    db = Database(settings.db_path)
    stale = seed_image(settings, db, "stale")
    fresh = seed_image(settings, db, "fresh")
    no_wcs = seed_image(settings, db, "no-wcs")
    unsolved = seed_image(settings, db, "unsolved")
    db.update_image(stale.id, {"solve_status": SolveStatus.SOLVED, "wcs_text": "SIMPLE", "objects_catalog": "2025-01-01"})
    db.update_image(fresh.id, {"solve_status": SolveStatus.SOLVED, "wcs_text": "SIMPLE", "objects_catalog": "2026-10-13"})
    db.update_image(no_wcs.id, {"solve_status": SolveStatus.SOLVED})
    assert unsolved.solve_status == SolveStatus.PENDING
    due = [r.id for r in db.images_for_catalog_backfill("2026-10-13")]
    assert due == ["stale"]
    db.update_image(stale.id, {"objects_catalog": None})
    assert [r.id for r in db.images_for_catalog_backfill("2026-10-13")] == ["stale"]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_db.py -k "v5 or backfill"`
Expected: FAIL (`no such column: objects_catalog` / `AttributeError`).

- [ ] **Step 3: Implement**

In `models.py`, `ImageRecord`: after `exported_hash: str | None = None` add

```python
    #: Version of objects.json the stored objects were looked up against; NULL before the local
    #: catalogue existed. The startup backfill brings stale rows up to the shipped version (#17).
    objects_catalog: str | None = None
```

In `db.py`: `SCHEMA_VERSION = 6`; in `MIGRATIONS` add `6: ("ALTER TABLE images ADD COLUMN objects_catalog TEXT",),`; in `SCHEMA`'s images table add `objects_catalog    TEXT` after `exported_hash      TEXT` (comma on the previous line). Add the query after `list_published_images`:

```python
    def images_for_catalog_backfill(self, version: str) -> list[ImageRecord]:
        """Solved images with a stored WCS whose objects were last looked up against another
        catalogue version (or never), oldest first."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE solve_status = ? AND wcs_text IS NOT NULL"
                " AND (objects_catalog IS NULL OR objects_catalog != ?)"
                " ORDER BY created_at, rowid",
                (SolveStatus.SOLVED.value, version),
            ).fetchall()
        return [_row_to_image(r) for r in rows]
```

(`SolveStatus` is already imported in db.py; check, and import from `.models` if not.)

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_db.py tests/test_api.py`
Expected: all pass. The API tests cover `ImageOut` serialisation; `objects_catalog` must not appear in `ImageOut` (it is a server detail): grep `backend/app/models.py` for how `ImageOut` is built from `ImageRecord` and confirm the new field is not copied (it is a separate model with explicit fields; nothing to do unless `ImageOut` uses `model_fields` of `ImageRecord`).

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/db.py app/models.py tests/test_db.py && cd .. && make lint
git add backend/app/db.py backend/app/models.py backend/tests/test_db.py
git commit -m "feat: images.objects_catalog stamp and the backfill query (schema 6, #17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The worker looks the catalogue up after every solve

**Files:**
- Modify: `backend/app/worker.py` (`_store_result`)
- Test: `backend/tests/test_worker.py` (append)

**Interfaces:**
- Consumes: `objects_catalog()`, `Wcs.from_text`, `WcsError`, `objects_from_catalog`, `merge_objects`.
- Produces: `worker.lookup_catalog(image_id: str, wcs_text: str, solve_scale: float, existing: list[SolveObject]) -> list[SolveObject]` (module-level function in `worker.py`, so the backfill in Task 10 reuses it) — the merged list; on `WcsError` logs `"image %s: catalogue lookup skipped: %s"` with `exc.detail` and returns `existing`.

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_worker.py`)

```python
def test_a_solve_adds_catalogue_objects_and_stamps_the_row(settings: Settings) -> None:
    from app.catalog import objects_catalog

    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    asyncio.run(make_worker(settings, db, FakeSolver()).process(rec.id))
    objects = db.get_objects(rec.id)
    nova_ids = [o.id for o in objects if o.type in ("ngc", "ic", "bright")]
    assert nova_ids == list(range(1, 21))  # nova's twenty keep ids 1..20 exactly as before
    looked_up = [o for o in objects if o.type in ("sharpless", "lbn", "barnard", "ldn", "pgc")]
    assert looked_up, "the Orion field should gain catalogue objects"
    assert all(o.id > 20 for o in looked_up)
    names = {n for o in objects for n in o.catalog_names}
    assert "Sh2-279" in names  # the Running Man's Sharpless number, nova never returns it
    got = db.get_image(rec.id)
    assert got is not None and got.objects_catalog == objects_catalog().version
    ann = db.get_annotations(rec.id)
    assert ann is not None and len(ann.labels) == len(objects)


def test_an_unreadable_wcs_leaves_novas_objects_alone(settings: Settings, caplog: pytest.LogCaptureFixture) -> None:
    db = Database(settings.db_path)
    rec = seed_image(settings, db)
    base = nova_result()
    with caplog.at_level(logging.WARNING, logger="app.worker"):
        asyncio.run(make_worker(settings, db, FakeSolver(SolveResult(base.annotations, "not a header", base.calibration))).process(rec.id))
    objects = db.get_objects(rec.id)
    assert len(objects) == 20 and {o.type for o in objects} <= {"ngc", "ic", "bright"}
    assert "catalogue lookup skipped" in caplog.text and rec.id in caplog.text
    got = db.get_image(rec.id)
    assert got is not None and got.solve_status == SolveStatus.SOLVED
```

(`logging`, `pytest`, `nova_result`, `SolveResult` are already imported in `test_worker.py`; add any that are not.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_worker.py -k "catalogue or unreadable_wcs"`
Expected: FAIL (`looked_up` empty; `objects_catalog` None).

- [ ] **Step 3: Implement**

In `worker.py` imports: `from .catalog import objects_catalog`, `from .objects import merge_objects, objects_from_catalog, objects_from_nova`, `from .wcs import Wcs, WcsError`, and `SolveObject` from `.models`. Add the module-level function before the class:

```python
def lookup_catalog(
    image_id: str, wcs_text: str, solve_scale: float, existing: list[SolveObject]
) -> list[SolveObject]:
    """``existing`` plus the bundled catalogue's objects in this field (SPEC § 5.2 step 4),
    merged by name then position. A header the projection cannot read is logged and the
    objects stay as they were: the image is still solved."""
    try:
        wcs = Wcs.from_text(wcs_text)
    except WcsError as exc:
        log.warning("image %s: catalogue lookup skipped: %s", image_id, exc.detail)
        return existing
    hits = objects_from_catalog(wcs, solve_scale, objects_catalog())
    next_id = max((o.id for o in existing), default=0) + 1
    return merge_objects(existing, hits, next_id=next_id)
```

In `_store_result`, replace `new_objects = objects_from_nova(raw, scale)` with:

```python
        new_objects = objects_from_nova(raw, scale)
        if wcs_text:
            new_objects = lookup_catalog(rec.id, wcs_text, scale, new_objects)
```

and add `"objects_catalog": objects_catalog().version if wcs_text else None,` to the `fields` dict passed to `store_solve_result`.

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_worker.py tests/test_api.py tests/test_objects.py`
Expected: all pass. Existing tests that count objects (`test_recorded_fixture_is_scaled_enriched_and_ordered` counts `objects_from_nova`, unaffected; API tests asserting exactly 20 objects after a solve will now fail: change those assertions to "the first twenty are nova's, ids 1..20" rather than an exact total. List each changed assertion in the commit message.)

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/worker.py tests/test_worker.py && cd .. && make lint test
git add backend/app/worker.py backend/tests/test_worker.py backend/tests/test_api.py
git commit -m "feat: every solve looks the local catalogue up through the stored WCS (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The startup backfill

**Files:**
- Create: `backend/app/catalog_backfill.py`
- Modify: `backend/app/main.py` (lifespan)
- Test: `backend/tests/test_catalog_backfill.py`

**Interfaces:**
- Consumes: `Database.images_for_catalog_backfill`, `lookup_catalog` (Task 9), `rematch_annotations`, `objects_catalog`.
- Produces: `run(db: Database, settings: Settings) -> BackfillReport` with `@dataclass class BackfillReport: visited: int; changed: int; added: int`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_catalog_backfill.py
from __future__ import annotations

import asyncio
import logging

import pytest

from app.catalog import objects_catalog
from app.catalog_backfill import run
from app.config import Settings
from app.db import Database
from tests.conftest import FakeSolver, make_worker, seed_image


def solved_without_catalogue(settings: Settings, db: Database, image_id: str = "img-1") -> None:
    """A solve as this build does it, then rewound: catalogue objects removed, stamp cleared,
    one label edited. What an image solved before #17 looks like."""
    rec = seed_image(settings, db, image_id)
    asyncio.run(make_worker(settings, db, FakeSolver()).process(rec.id))
    nova_only = [o for o in db.get_objects(rec.id) if o.type in ("ngc", "ic", "bright")]
    ann = db.get_annotations(rec.id)
    assert ann is not None
    kept = [lab for lab in ann.labels if lab.object_id <= 20]
    edited = [lab.model_copy(update={"x": 42.0, "y": 43.0, "text_override": "edited", "enabled": True}) if lab.object_id == 1 else lab for lab in kept]
    db.replace_objects(rec.id, nova_only)
    db.save_annotations(ann.model_copy(update={"labels": edited, "version": 3}))
    db.update_image(rec.id, {"objects_catalog": None})


def test_backfill_adds_objects_and_keeps_every_existing_label(settings: Settings, caplog: pytest.LogCaptureFixture) -> None:
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)
    with caplog.at_level(logging.INFO, logger="app.catalog_backfill"):
        report = run(db, settings)
    assert (report.visited, report.changed) == (1, 1) and report.added > 0
    objects = db.get_objects("img-1")
    assert [o.id for o in objects[:20]] == list(range(1, 21))
    assert {n for o in objects for n in o.catalog_names} >= {"Sh2-279"}
    ann = db.get_annotations("img-1")
    assert ann is not None and ann.version == 4  # the document moved: the export reads as stale
    by_obj = {lab.object_id: lab for lab in ann.labels}
    assert (by_obj[1].x, by_obj[1].y, by_obj[1].text_override, by_obj[1].enabled) == (42.0, 43.0, "edited", True)
    assert len(ann.labels) == len(objects)
    got = db.get_image("img-1")
    assert got is not None and got.objects_catalog == objects_catalog().version
    assert "catalogue backfill: 1 image visited, 1 changed, " in caplog.text


def test_backfill_is_idempotent_and_skips_what_is_not_due(settings: Settings) -> None:
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db, "a")
    unsolved = seed_image(settings, db, "b")
    run(db, settings)
    objects_after_first = db.get_objects("a")
    version_after_first = db.get_annotations("a").version  # type: ignore[union-attr]
    report = run(db, settings)
    assert (report.visited, report.changed, report.added) == (0, 0, 0)
    assert db.get_objects("a") == objects_after_first
    assert db.get_annotations("a").version == version_after_first  # type: ignore[union-attr]
    assert db.get_image(unsolved.id).objects_catalog is None  # type: ignore[union-attr]


def test_backfill_stamps_an_image_that_gains_nothing_without_touching_its_document(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A field with nothing in the catalogue: the stamp is written, the version does not move."""
    from app import catalog_backfill

    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)
    monkeypatch.setattr(catalog_backfill, "lookup_catalog", lambda image_id, wcs_text, scale, existing: existing)
    report = run(db, settings)
    assert (report.visited, report.changed, report.added) == (1, 0, 0)
    assert db.get_annotations("img-1").version == 3  # type: ignore[union-attr]
    assert db.get_image("img-1").objects_catalog == objects_catalog().version  # type: ignore[union-attr]


def test_backfill_skips_a_solved_image_without_a_layout(settings: Settings, caplog: pytest.LogCaptureFixture) -> None:
    db = Database(settings.db_path)
    solved_without_catalogue(settings, db)
    with db.connect() as conn:
        conn.execute("DELETE FROM annotations WHERE image_id = 'img-1'")
    with caplog.at_level(logging.WARNING, logger="app.catalog_backfill"):
        report = run(db, settings)
    assert (report.visited, report.changed) == (1, 0)
    assert db.get_image("img-1").objects_catalog is None  # type: ignore[union-attr]
    assert "img-1" in caplog.text and "no layout" in caplog.text
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest -q tests/test_catalog_backfill.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.catalog_backfill'`.

- [ ] **Step 3: Implement**

```python
# backend/app/catalog_backfill.py
"""One-time lookup of the local catalogue for images solved before it shipped (SPEC § 5.2).

Runs in the lifespan before the server accepts requests, so no editor is mid-edit while its
document is rewritten. Per image: project the catalogue through the stored WCS, merge the hits
into the stored objects (ids continue after the highest), and when anything was added run the
re-solve rematch, which carries every existing label untouched and places only the new ones.
Never contacts nova.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .catalog import objects_catalog
from .config import Settings
from .db import Database
from .layout import rematch_annotations
from .worker import lookup_catalog

log = logging.getLogger(__name__)


@dataclass
class BackfillReport:
    visited: int = 0
    changed: int = 0
    added: int = 0


def run(db: Database, settings: Settings) -> BackfillReport:
    version = objects_catalog().version
    report = BackfillReport()
    for rec in db.images_for_catalog_backfill(version):
        report.visited += 1
        assert rec.wcs_text  # the query guarantees it
        previous = db.get_annotations(rec.id)
        if previous is None:
            log.warning("image %s: catalogue backfill skipped: no layout stored", rec.id)
            continue
        old_objects = db.get_objects(rec.id)
        merged = lookup_catalog(rec.id, rec.wcs_text, rec.solve_scale, old_objects)
        added = len(merged) - len(old_objects)
        if added == 0 and all(a.catalog_names == b.catalog_names for a, b in zip(old_objects, merged, strict=True)):
            db.update_image(rec.id, {"objects_catalog": version})
            continue
        ann = rematch_annotations(previous, old_objects, merged, rec.width, rec.height, settings.fonts_dir)
        if not db.store_solve_result(rec.id, merged, ann, {"objects_catalog": version}):
            continue  # deleted meanwhile
        report.changed += 1
        report.added += added
    log.info(
        "catalogue backfill: %d image%s visited, %d changed, %d objects added (catalogue %s)",
        report.visited,
        "" if report.visited == 1 else "s",
        report.changed,
        report.added,
        version,
    )
    return report
```

`store_solve_result` updates the row with `fields` plus `updated_at` and replaces objects and the layout in one transaction; it is exactly the write the backfill needs. The `fields` dict passes only the stamp, so `solve_status` and the nova ids are untouched.

In `main.py`'s lifespan, after `db.init()`:

```python
        report = await asyncio.to_thread(catalog_backfill.run, db, cfg)
        if report.changed:
            log.info("catalogue backfill changed %d image(s); their exports now read as out of date", report.changed)
```

with `from . import catalog_backfill` among the imports. (`cfg` is the `Settings` the lifespan already holds; use the same name the surrounding code uses.)

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/pytest -q tests/test_catalog_backfill.py tests/test_auth_api.py tests/test_api.py`
Expected: all pass (`test_auth_api` boots the app through the lifespan with an empty database: the backfill visits nothing).

- [ ] **Step 5: Lint and commit**

```bash
cd backend && .venv/bin/ruff format app/catalog_backfill.py app/main.py tests/test_catalog_backfill.py && cd .. && make lint test
git add backend/app/catalog_backfill.py backend/app/main.py backend/tests/test_catalog_backfill.py
git commit -m "feat: startup backfill looks the local catalogue up for images solved before it shipped (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: e2e counts, docs, smoke test, PR

**Files:**
- Modify: `frontend/e2e/panel.spec.ts`, `docs/SPEC.md`, `docs/INSTALL.md`, `docs/ARCHITECTURE.md`; possibly `docs/screenshots/*.png`.

- [ ] **Step 1: Run the e2e suite and read the new counts**

Run: `make e2e 2>&1 | tail -40`
Expected: `panel.spec.ts` fails on `'20 of 20 objects'`. Read the real total `N` from the failure (the text the page shows). Then edit `frontend/e2e/panel.spec.ts`:

```ts
    // Kind chips: the Orion fixture has 8 bright stars, 9 NGC and 3 IC rows from nova, plus the
    // local catalogue's objects in this field (Sharpless, LBN, LDN, PGC; #17). The total is read
    // from the server so the spec follows the shipped catalogue rather than hard-coding it.
    const rows = page.locator('.object-list .object-row')
    const objects = await fetchObjects(page, imageId)
    const total = objects.length
    expect(total).toBeGreaterThan(20)
    await expect(page.getByText(`${total} of ${total} objects`)).toBeVisible()
    const enabledIds = new Set((await fetchAnnotations(page, imageId)).labels.filter((l) => l.enabled).map((l) => l.object_id))
    const drawnStars = objects.filter((o) => o.kind === 'star' && enabledIds.has(o.id)).length
    const stars = objects.filter((o) => o.kind === 'star').length
    await page.getByRole('button', { name: 'Stars', exact: true }).click()
    await expect(page.getByText(`${total - stars + drawnStars} of ${total} objects`)).toBeVisible()
```

and replace the two later `of 20 objects` strings with `of ${total} objects`. Keep every other assertion.

- [ ] **Step 2: Run the e2e suite again**

Run: `make e2e 2>&1 | tail -5`
Expected: 15 passed, 1 skipped. If the parity spec fails, stop and report: it means a renderer changed, which this feature must not do.

- [ ] **Step 3: Screenshots**

Run: `make screenshots && git status --short docs/screenshots`
If any PNG changed, look at it (`Read` the file) and confirm the change is a newly drawn catalogue label, then include it. If unchanged, nothing to do.

- [ ] **Step 4: SPEC edits**

In `docs/SPEC.md` § 5.2 step 4, after the sentence ending "they are different objects.", insert:

```
   Then the **local catalogue** is looked up (#17): `backend/app/catalog/objects.json` (Sharpless, Barnard,
   LDN, LBN, and PGC galaxies with D25 ≥ 1′, built from CDS VizieR tables by `make objects-catalog`, see
   `CDS-ATTRIBUTION.md`) is projected through the stored WCS (`app/wcs.py`, TAN + SIP in plain Python; the
   recorded fixtures pin it to nova's own pixels within 0.5 px). Every row whose centre lands in the solve copy
   is a hit. A hit sharing a name with a nova object joins it (names appended; nova's position and radius
   stay), as does a hit of the same kind within half the smaller radius of a nova object's centre; the rest
   are appended after nova's ids, by descending radius then name, capped at 5 000 labels. A header the
   projection cannot read is logged and the image keeps nova's objects alone. The row records the catalogue
   version it was looked up against (`objects_catalog`); at startup, before requests are served, images whose
   stamp is behind the shipped version are looked up once more, additively: existing labels keep their
   position, state and overrides (the re-solve rematch), only new objects are placed, and their export then
   reads as out of date. Never contacts nova.
```

In step 5, after "`hd`-type stars have radius 0 and are therefore hidden by default (see § 14).", add: "Catalogue objects always carry a radius, so a small galaxy arrives listed but off and a large dark nebula arrives drawn."

In § 7 images table, after `exported_at   text?` add `objects_catalog text? (objects.json version the objects were looked up against; NULL before #17)`. In the objects table, change the `type` line to: `type          text  (nova's \`type\`: ngc|ic|bright|hd|…, or the local catalogue's source: sharpless|lbn|barnard|ldn|pgc)`.

In § 8, the `GET /images/{id}/objects` line: replace "computed from nova's type and OpenNGC at read time" with "stars from nova's type, catalogue objects from their source, the rest from OpenNGC at read time".

In § 13 "Later" line, drop nothing (custom object entries stay); in § 14 or wherever #17 is listed as open, remove it.

- [ ] **Step 5: INSTALL and ARCHITECTURE**

`docs/INSTALL.md`, "Releases, tags and upgrades", after the "Back up `./data` first" paragraph:

```
The first start after upgrading to a release that ships a newer bundled object catalogue looks up
every solved image once more (a few seconds per hundred images, before the server answers) and adds
the new objects beside the existing labels; those images then show their export as out of date.
```

`docs/ARCHITECTURE.md`: in the diagram line `objects.objects_from_nova …` add a line below it `│ objects.objects_from_catalog + merge_objects  (wcs.Wcs: TAN+SIP, catalog/objects.json)`; in the table add rows:

```
| `app/wcs.py` | The stored WCS header parsed; TAN+SIP projection both ways, stdlib only. |
| `app/catalog_backfill.py` | Startup: looks the local catalogue up for images stamped with an older catalogue version; additive. |
```

and extend the `app/catalog/` row with "`objects.json` (CDS tables, `CDS-ATTRIBUTION.md`): Sharpless, Barnard, LDN, LBN, PGC ≥ 1′ with positions and sizes, looked up through the WCS."

- [ ] **Step 6: Full verification, smoke test, commit**

```bash
make lint test && make e2e
sudo systemctl restart astrocaption-dev
```

Then stop and ask the owner to smoke-test on the dev service: (1) open an existing solved image: the Objects tab lists new rows (Sharpless/LDN/PGC) after nova's, and the card says the export is out of date; (2) re-export and open the gallery: new drawn labels appear; (3) upload and solve a new image (fake or real key): the same. Wait for the verdict, then:

```bash
git add frontend/e2e/panel.spec.ts docs/SPEC.md docs/INSTALL.md docs/ARCHITECTURE.md   # plus docs/screenshots/*.png if changed
git commit -m "docs: local catalogue lookup in SPEC, INSTALL and ARCHITECTURE; e2e counts follow the catalogue (#17)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u origin feat/catalogue-lookup
```

PR 3: `feat: objects nova does not annotate, looked up through the stored WCS (#17, 3/3)` with `Closes #17` in the body, what the owner will see after the upgrade (the backfill, the stale exports), the merge rules in two sentences, the footer. `gh pr checks --watch`, then `/code-review low` (the API changed), answer the issues question, wait for "merge".

---

## Self-review (done while writing)

- **Spec coverage.** Data file, sources, build, attribution → Tasks 1–3. Parser, both projections, plate scale, membership, scale, oracle, round trip, no-SIP, malformed → Tasks 4–5. Hits, merge by name/position, ids, cap, kind map, enablement unchanged → Tasks 6–7. Solve time, stamp, migration, backfill, cost, what the owner sees, rebuild later → Tasks 8–10. e2e counts, screenshots, SPEC/INSTALL/ARCHITECTURE, Makefile/CLAUDE.md → Tasks 3 and 11. Three PRs as the spec lists.
- **Review Focus.** 1 → Task 5 (`test_a_header_without_sip_projects_as_a_plain_tan`); 2 → Task 5 (`test_a_point_behind_the_tangent_plane_is_none`); 3 → Task 6 (`objects_from_catalog` with `solve_scale=2.0`); 4 → Task 10 (`test_backfill_skips_a_solved_image_without_a_layout`); 5 → Task 1 (`test_load_objects_catalog_refuses_a_file_that_is_not_the_catalogue`).
- **Type consistency.** `CatalogObject.names` is a tuple in the loader and `list(row.names)` where a list is needed; `merge_objects(existing, hits, *, next_id)` is called with the keyword in Tasks 9 and 10; `lookup_catalog(image_id, wcs_text, solve_scale, existing)` has the same positional order in Task 9 and in Task 10's monkeypatched lambda; `KIND_BY_SOURCE` (not the spec's draft name `KIND_BY_TYPE`, which already exists in the names builder with another meaning) is used in Tasks 1 and 6; `Wcs.field()` returns `(unit vector, degrees)` in Tasks 5 and 6.
- **Known approximation in Task 3's expected counts** (Barnard, LDN, LBN marked `~`): the exact numbers come from the build and go into the commit message; the shipped-file test asserts landmarks and `> 20 000`, not exact totals.
