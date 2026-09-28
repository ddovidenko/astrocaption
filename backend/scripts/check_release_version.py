"""Refuse a release tag that disagrees with the three version files.

The release workflow (.github/workflows/release.yml) runs this before building anything, so the
image tag and the version reported by /api/health cannot drift apart. Versions are bumped by hand
in a `chore: release vX.Y.Z` PR; this script is what makes that discipline enforceable.

Run from backend/:  python scripts/check_release_version.py v0.1.0   (or `make check-version TAG=v0.1.0`)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# v + strict semver: MAJOR.MINOR.PATCH without leading zeros, plus an optional pre-release of
# non-empty dot-separated identifiers (-rc1, -beta.2). Strict on purpose: docker/metadata-action
# parses loosely, so v01.1.0 would ship as image tag 1.1.0 while /api/health said 01.1.0.
_NUM = r"(?:0|[1-9]\d*)"
_IDENT = r"[0-9A-Za-z-]+"
TAG_RE = re.compile(rf"v({_NUM}\.{_NUM}\.{_NUM}(?:-{_IDENT}(?:\.{_IDENT})*)?)")
INIT_RE = re.compile(r'^__version__\s*=\s*"([^"]+)"\s*$', re.MULTILINE)

PYPROJECT = "backend/pyproject.toml"
INIT = "backend/app/__init__.py"
PACKAGE_JSON = "frontend/package.json"


def _read_pyproject(path: Path) -> str | None:
    with path.open("rb") as fh:
        data = tomllib.load(fh)
    project = data.get("project")
    if not isinstance(project, dict):
        return None
    version = project.get("version")
    return version if isinstance(version, str) else None


def _read_init(path: Path) -> str | None:
    match = INIT_RE.search(path.read_text())
    return match.group(1) if match else None


def _read_package_json(path: Path) -> str | None:
    version = json.loads(path.read_text()).get("version")
    return version if isinstance(version, str) else None


def versions(root: Path = REPO_ROOT) -> dict[str, str]:
    """Version string per file; a file whose version field is missing is left out."""
    readers = {PYPROJECT: _read_pyproject, INIT: _read_init, PACKAGE_JSON: _read_package_json}
    found: dict[str, str] = {}
    for rel, reader in readers.items():
        version = reader(root / rel)
        if version is not None:
            found[rel] = version
    return found


def check(tag: str, root: Path = REPO_ROOT) -> list[str]:
    """Problems that make `tag` unreleasable; an empty list means go ahead."""
    match = TAG_RE.fullmatch(tag)
    if match is None:
        return [f"tag {tag!r} is not v<major>.<minor>.<patch>[-<prerelease>]"]
    wanted = match.group(1)
    found = versions(root)
    problems = [
        f"{rel}: no version field found"
        for rel in (PYPROJECT, INIT, PACKAGE_JSON)
        if rel not in found
    ]
    problems += [
        f"{rel}: version is {have} but the tag says {wanted}"
        for rel, have in found.items()
        if have != wanted
    ]
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("tag", help="the git tag, e.g. v0.1.0")
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="repo root (tests)")
    args = parser.parse_args(argv)
    problems = check(args.tag, args.root)
    for problem in problems:
        print(problem)
    if not problems:
        print(f"{args.tag}: versions agree")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
