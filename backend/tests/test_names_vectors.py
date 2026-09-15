"""tests/fixtures/names/vectors.json must be what models.py produces today.

A failure means the ranking or the alias policy changed: check the diff, then
``make names-vectors`` and commit the file with the change that caused it — and change
``frontend/src/editor/names.ts`` to match (``names.test.ts`` replays the same file)."""

from __future__ import annotations

import json

from scripts.make_names_vectors import EDGE_CASES, OUT, build_vectors


def test_names_vectors_are_current() -> None:
    assert OUT.exists(), "run make names-vectors"
    assert json.loads(OUT.read_text(encoding="utf-8")) == build_vectors(), (
        "vectors.json is stale: run make names-vectors and commit it with the change"
    )


def test_edge_cases_cover_the_policy_rules() -> None:
    """Every rule has at least one case that exercises it: a nested common name, a star twin, a
    lone star id, an unknown prefix, more common names than the cap."""
    flat = [tuple(c) for c in EDGE_CASES]
    assert ("NGC 1976", "M 42", "LBN 974", "Great Orion Nebula", "Orion Nebula") in flat
    assert ("HD 37742", "HIP 26727") in flat
    assert ("XYZ 12", "ABC 3") in flat
    assert any(len(c) > 6 for c in flat)
