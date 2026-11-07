"""The render contract (CLAUDE.md hard rule): render.py must still produce
tests/fixtures/render/vectors.json.

The TypeScript port (frontend/src/editor/metrics.ts) is pinned to the same file by
frontend/src/editor/metrics.test.ts, and the browser's canvas measurement is checked against
the ``texts`` entries by frontend/e2e/parity.spec.ts, which arrives with the editor canvas
(milestone-3 PR 4). A failure here means render.py, the font bundle or Pillow changed: read the
diff, then ``make render-vectors`` and commit the file with the change that caused it.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.fonts import layout_engine_available
from scripts.make_render_vectors import (
    GLYPH_STRINGS,
    OUT,
    PROBE_OUT,
    PROBE_SIZES,
    build_vectors,
    fixture_objects,
    label_strings,
    probe_strings,
)
from tests.conftest import FONTS_DIR

PROVENANCE_KEYS = frozenset({"pillow", "freetype", "layout_engine"})


@pytest.fixture(scope="module")
def built() -> dict[str, Any]:
    return build_vectors(FONTS_DIR)


def assert_contract_current(stored: dict[str, Any], built: dict[str, Any]) -> None:
    assert set(built) == set(stored)
    assert built["texts"] and built["labels"] and built["leaders"] and built["anchors"]
    assert built["ring_crossings"] and built["box_crossings"] and built["box_segments"]
    assert len(built["fonts"]) == len(list(FONTS_DIR.glob("*.ttf")))
    provenance = {k: (stored[k], built[k]) for k in PROVENANCE_KEYS}
    for key in sorted(set(built) - PROVENANCE_KEYS):
        assert built[key] == stored[key], (
            f"vectors.json '{key}' is stale: run make render-vectors "
            f"(stored vs current pillow/freetype/engine: {provenance})"
        )


def test_render_vectors_are_current(built: dict[str, Any]) -> None:
    stored = json.loads(OUT.read_text(encoding="utf-8"))
    assert_contract_current(stored, built)


def test_provenance_stamps_are_context_not_contract(built: dict[str, Any]) -> None:
    """A Pillow/FreeType version bump alone must not fail the contract check."""
    stored = dict(built)
    stored["pillow"] = "0.0.0"
    assert_contract_current(stored, built)


def test_probe_strings_are_current(built: dict[str, Any]) -> None:
    """The editor's load-time measurement check (#72) reads frontend/src/editor/probe-strings.json,
    written by ``make render-vectors`` from the same texts as the contract."""
    stored = json.loads(PROBE_OUT.read_text(encoding="utf-8"))
    assert stored == probe_strings(built["texts"]), (
        "probe-strings.json is stale: make render-vectors"
    )


def test_probe_strings_pick_the_longest_string_per_font_and_size(built: dict[str, Any]) -> None:
    texts = built["texts"]
    probe = probe_strings(texts)
    files = {font["file"] for font in built["fonts"]}
    assert {(p["file"], p["size"]) for p in probe} == {(f, s) for f in files for s in PROBE_SIZES}
    assert len(probe) == len(files) * len(PROBE_SIZES)
    for p in probe:
        same = [t for t in texts if t[0] == p["file"] and t[1] == p["size"]]
        assert [p["file"], p["size"], p["text"], p["width"]] in same
        assert p["width"] == max(t[3] for t in same)
    # Ordered by file then size, so a diff of the file reads as a table.
    assert [(p["file"], p["size"]) for p in probe] == sorted((p["file"], p["size"]) for p in probe)


def test_pillow_uses_the_raqm_engine() -> None:
    assert layout_engine_available(), (
        "install libfribidi (Docker: libfribidi0); the render contract assumes Pillow's raqm layout"
    )


def test_glyph_strings_are_real_fixture_labels() -> None:
    """The every-font grid uses a subset of the fixture strings, not made-up text."""
    assert set(GLYPH_STRINGS) <= set(label_strings(fixture_objects()))


def test_vectors_cover_the_rounding_trap(built: dict[str, Any]) -> None:
    """Sizes 15 and 35 put ``size × 0.7`` on .5, where Python and JavaScript round differently."""
    sizes = {case["box"]["primary_size"] for case in built["labels"]}
    assert {15, 35} <= sizes
