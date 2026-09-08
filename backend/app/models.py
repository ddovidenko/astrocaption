"""Pydantic models shared by the API, the solver pipeline and the renderer.

Geometry is always in original-image pixels (see CLAUDE.md).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


def utcnow_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


class SolveStatus(StrEnum):
    PENDING = "pending"
    SOLVING = "solving"
    SOLVED = "solved"
    FAILED = "failed"


# ---------------------------------------------------------------------------
# Catalogue objects (immutable after a solve)
# ---------------------------------------------------------------------------


class SolveObject(BaseModel):
    """One catalogued object nova found in the field, in original pixels."""

    id: int
    catalog_names: list[str] = Field(min_length=1)
    type: str
    x: float
    y: float
    radius: float = 0.0

    def primary_name_for(self, preference: NamePreference = "popular") -> str:
        return primary_name(self.catalog_names, preference)

    def aliases_for(self, preference: NamePreference = "popular") -> list[str]:
        p = self.primary_name_for(preference)
        return [n for n in self.catalog_names if n != p]

    @property
    def primary_name(self) -> str:
        return self.primary_name_for()

    @property
    def aliases(self) -> list[str]:
        return self.aliases_for()


NamePreference = Literal["popular", "ngc_ic"]
"""Which catalogue designation becomes the label's primary line.

``popular``: Messier, Caldwell, Sharpless and Barnard first, then NGC, then IC, then other
deep-sky catalogues (Collinder, Melotte, LBN, ...), then common names. ``ngc_ic``: NGC and IC
first, then the rest in the same order. For stars the proper name wins, then the Bayer
letter, then the Flamsteed number; star catalogues (HD, HIP, SAO, ...) always come last.
"""

_STAR_CATALOGUES = frozenset(
    {
        "HD",
        "HIP",
        "SAO",
        "TYC",
        "HR",
        "BD",
        "CD",
        "CPD",
        "GSC",
        "GAIA",
        "UCAC",
        "TIC",
        "PPM",
        "GJ",
        "GL",
        "WDS",
        "ADS",
        "HIC",
    }
)
_DSO_CATALOGUES = frozenset(
    {
        "CR",
        "COLLINDER",
        "MEL",
        "MELOTTE",
        "TR",
        "TRUMPLER",
        "STOCK",
        "KING",
        "BERKELEY",
        "BE",
        "RU",
        "RUPRECHT",
        "LDN",
        "LBN",
        "VDB",
        "CED",
        "CEDERBLAD",
        "RCW",
        "GUM",
        "ARP",
        "HCG",
        "HICKSON",
        "MRK",
        "PK",
        "PNG",
        "MINKOWSKI",
        "JONES",
        "KOHOUTEK",
        "UGC",
        "PGC",
        "ESO",
        "MCG",
        "DDO",
        "HOLMBERG",
        "SNR",
        "CTB",
        "DWB",
        "VV",
        "AM",
        "PAL",
        "PALOMAR",
        "TERZAN",
        "PISMIS",
        "WESTERLUND",
        "BASEL",
        "HAFFNER",
        "BOCHUM",
        "CZERNIK",
        "DOLIDZE",
        "ROSLUND",
        "HARVARD",
        "ABELL",
    }
)
_NAME_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("messier", re.compile(r"(?:M|Messier)\s?\d+[a-z]?", re.IGNORECASE)),
    ("caldwell", re.compile(r"(?:C|Caldwell)\s?\d+", re.IGNORECASE)),
    ("sharpless", re.compile(r"(?:Sh\s?2|Sharpless)\s?-?\s?\d+[a-z]?", re.IGNORECASE)),
    ("barnard", re.compile(r"(?:B|Barnard)\s?\d+[a-z]?", re.IGNORECASE)),
    ("ngc", re.compile(r"NGC\s?\d+[a-z]?", re.IGNORECASE)),
    ("ic", re.compile(r"IC\s?\d+[a-z]?", re.IGNORECASE)),
)
_DESIGNATION = re.compile(r"([A-Za-z]+)\s?-?\s?[+-]?\d")
# "ι Ori", "θ1 Ori C", "c Ori": one Greek or Latin letter, optional index, constellation, component
_BAYER = re.compile(r"[A-Za-z\u0370-\u03ff]\d?\s[A-Z][A-Za-z]{2}(?:\s[A-Z])?")
# "44 Ori", "41 Ori A"
_FLAMSTEED = re.compile(r"\d{1,3}\s[A-Z][A-Za-z]{2}(?:\s[A-Z])?")
_RANKING: dict[str, tuple[str, ...]] = {
    "popular": (
        "messier",
        "caldwell",
        "sharpless",
        "barnard",
        "ngc",
        "ic",
        "catalogue",
        "designation",
        "common",
        "bayer",
        "flamsteed",
        "star",
    ),
    "ngc_ic": (
        "ngc",
        "ic",
        "messier",
        "caldwell",
        "sharpless",
        "barnard",
        "catalogue",
        "designation",
        "common",
        "bayer",
        "flamsteed",
        "star",
    ),
}


def name_category(name: str) -> str:
    """Classify a catalogue name.

    messier | caldwell | sharpless | barnard | ngc | ic | catalogue (other deep-sky) |
    bayer | flamsteed | star (HD/HIP/SAO ...) | designation (unknown abbr.) | common
    """
    n = name.strip()
    for category, pattern in _NAME_PATTERNS:
        if pattern.fullmatch(n):
            return category
    if _FLAMSTEED.fullmatch(n):
        return "flamsteed"
    if _BAYER.fullmatch(n):
        return "bayer"
    m = _DESIGNATION.match(n)
    if m:
        prefix = m.group(1).upper()
        if prefix in _STAR_CATALOGUES:
            return "star"
        if prefix in _DSO_CATALOGUES:
            return "catalogue"
        return "designation"
    return "common"


def primary_name(names: list[str], preference: NamePreference = "popular") -> str:
    """Pick the label's primary line; ties keep nova's original order."""
    order = _RANKING[preference]
    ranked = sorted(enumerate(names), key=lambda kv: (order.index(name_category(kv[1])), kv[0]))
    return ranked[0][1]


# ---------------------------------------------------------------------------
# Annotation layout (editable)
# ---------------------------------------------------------------------------

LeaderMode = Literal["auto", "on", "off"]


class StyleConfig(BaseModel):
    """Global style for one image. All lengths are original-image pixels."""

    font_file: str = "Inter-Regular.ttf"
    font_size: int = Field(default=24, ge=6, le=200)
    text_color: str = "#FFFFFF"
    marker_color: str = "#FFD54A"
    leader_color: str = "#FFD54A"
    halo: bool = True
    halo_color: str = "#000000"
    halo_width: int = Field(default=2, ge=0, le=40)
    marker_width: int = Field(default=2, ge=1, le=40)
    marker_min_radius: int = Field(default=6, ge=1, le=400)
    show_aliases: bool = True
    name_preference: NamePreference = "popular"


class Label(BaseModel):
    """Layout of one object's call-out. ``x, y`` is the top-left of the text box."""

    object_id: int
    enabled: bool = True
    x: float = 0.0
    y: float = 0.0
    font_size: int | None = Field(default=None, ge=6, le=200)
    text_override: str | None = None
    color: str | None = None
    show_aliases: bool | None = None
    leader: LeaderMode = "auto"
    collided: bool = False


class Annotations(BaseModel):
    image_id: str
    style: StyleConfig
    labels: list[Label]
    version: int = 1
    updated_at: str = Field(default_factory=utcnow_iso)


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


class Calibration(BaseModel):
    """Nova's calibration summary for a solved job (degrees, arcsec/px)."""

    ra: float
    dec: float
    radius: float
    pixscale: float
    orientation: float
    parity: float


class ImageRecord(BaseModel):
    """Row of the ``images`` table."""

    id: str
    created_at: str
    updated_at: str
    title: str
    original_name: str
    original_path: str
    preview_path: str
    thumb_path: str
    width: int
    height: int
    solve_status: SolveStatus = SolveStatus.PENDING
    solve_error: str | None = None
    solve_scale: float = 1.0
    nova_submission_id: int | None = None
    nova_job_id: int | None = None
    wcs_text: str | None = None
    calibration: Calibration | None = None
    published: bool = False
    exported_at: str | None = None


# ---------------------------------------------------------------------------
# API payloads
# ---------------------------------------------------------------------------


class SolveHints(BaseModel):
    """Optional hints passed to the solver when re-solving after a failure."""

    focal_length_mm: float | None = Field(default=None, gt=0)
    pixel_size_um: float | None = Field(default=None, gt=0)
    scale_tolerance_pct: float = Field(default=20.0, gt=0, le=100)

    @property
    def arcsec_per_pixel(self) -> float | None:
        if self.focal_length_mm is None or self.pixel_size_um is None:
            return None
        return 206.265 * self.pixel_size_um / self.focal_length_mm


class ImageOut(BaseModel):
    id: str
    title: str
    original_name: str
    created_at: str
    updated_at: str
    width: int
    height: int
    solve_status: SolveStatus
    solve_error: str | None
    nova_submission_id: int | None
    nova_job_id: int | None
    nova_status_url: str | None
    nova_job_log_url: str | None
    calibration: Calibration | None
    published: bool
    object_count: int
    exported_at: str | None
    original_format: str
    preview_url: str
    thumb_url: str
    original_url: str
    annotated_preview_url: str | None
    export_url: str | None


class ObjectOut(BaseModel):
    id: int
    catalog_names: list[str]
    primary_name: str
    type: str
    x: float
    y: float
    radius: float


class ExportRequest(BaseModel):
    """``quality`` ``None`` (the default) reuses the uploaded JPEG's own quantisation tables and
    chroma subsampling, which keeps size and fidelity close to the original; a number forces
    libjpeg quality with 4:4:4 chroma. PNG/TIFF sources fall back to quality 95."""

    quality: int | None = Field(default=None, ge=50, le=100)
    scale: float = Field(default=1.0, gt=0.0, le=1.0)


class ExportOut(BaseModel):
    export_url: str
    annotated_preview_url: str
    width: int
    height: int
    bytes: int
    exported_at: str
    encoding: str


class FontOut(BaseModel):
    file: str
    family: str
    weight: str
    sample: str = "NGC 1976"


class HealthOut(BaseModel):
    status: Literal["ok"] = "ok"
    version: str
    site_title: str
    nova_api_key_set: bool
