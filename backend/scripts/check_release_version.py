"""Refuse a release tag that disagrees with the version files.

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
PACKAGE_LOCK = "frontend/package-lock.json"
# npm keeps the lockfile's two copies of the version in step with package.json
# (`npm version --no-git-tag-version`); a hand edit of package.json does not (#162).
LOCK_TOP = f"{PACKAGE_LOCK} (version)"
LOCK_ROOT = f'{PACKAGE_LOCK} (packages[""].version)'
LOCATIONS = (PYPROJECT, INIT, PACKAGE_JSON, LOCK_TOP, LOCK_ROOT)


class VersionFileError(Exception):
    """A version file that is missing or does not parse; the message names the file."""


def _text(root: Path, rel: str) -> str:
    try:
        return (root / rel).read_text()
    except OSError as exc:
        raise VersionFileError(f"{rel}: cannot be read ({exc.strerror or exc})") from exc
    except UnicodeDecodeError as exc:
        raise VersionFileError(f"{rel}: cannot be read (not UTF-8 text)") from exc


def _read_pyproject(root: Path) -> dict[str, str | None]:
    try:
        data = tomllib.loads(_text(root, PYPROJECT))
    except tomllib.TOMLDecodeError as exc:
        raise VersionFileError(f"{PYPROJECT}: not valid TOML ({exc})") from exc
    project = data.get("project")
    version = project.get("version") if isinstance(project, dict) else None
    return {PYPROJECT: version if isinstance(version, str) else None}


def _read_init(root: Path) -> dict[str, str | None]:
    match = INIT_RE.search(_text(root, INIT))
    return {INIT: match.group(1) if match else None}


def _json(root: Path, rel: str) -> dict[str, object]:
    try:
        data = json.loads(_text(root, rel))
    except json.JSONDecodeError as exc:
        raise VersionFileError(f"{rel}: not valid JSON ({exc})") from exc
    return data if isinstance(data, dict) else {}


def _read_package_json(root: Path) -> dict[str, str | None]:
    version = _json(root, PACKAGE_JSON).get("version")
    return {PACKAGE_JSON: version if isinstance(version, str) else None}


def _read_package_lock(root: Path) -> dict[str, str | None]:
    data = _json(root, PACKAGE_LOCK)
    packages = data.get("packages")
    own = packages.get("") if isinstance(packages, dict) else None
    top = data.get("version")
    nested = own.get("version") if isinstance(own, dict) else None
    return {
        LOCK_TOP: top if isinstance(top, str) else None,
        LOCK_ROOT: nested if isinstance(nested, str) else None,
    }


READERS = (_read_pyproject, _read_init, _read_package_json, _read_package_lock)


def _collect(root: Path) -> tuple[dict[str, str], list[str]]:
    """Version per location, plus one problem per file that could not be read or parsed."""
    found: dict[str, str] = {}
    problems: list[str] = []
    for reader in READERS:
        try:
            versions_in_file = reader(root)
        except VersionFileError as exc:
            problems.append(str(exc))
            continue
        for label, version in versions_in_file.items():
            if version is not None:
                found[label] = version
    return found, problems


def versions(root: Path = REPO_ROOT) -> dict[str, str]:
    """Version string per location; a location whose field is missing is left out, and a
    file that cannot be read raises ``VersionFileError`` (``check`` turns that into a problem)."""
    found, problems = _collect(root)
    if problems:
        raise VersionFileError("; ".join(problems))
    return found


def check(tag: str, root: Path = REPO_ROOT) -> list[str]:
    """Problems that make `tag` unreleasable; an empty list means go ahead."""
    match = TAG_RE.fullmatch(tag)
    if match is None:
        return [f"tag {tag!r} is not v<major>.<minor>.<patch>[-<prerelease>]"]
    wanted = match.group(1)
    found, problems = _collect(root)
    unreadable = {problem.split(":", 1)[0] for problem in problems}
    problems += [
        f"{label}: no version field found"
        for label in LOCATIONS
        if label not in found and label.split(" (", 1)[0] not in unreadable
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
        print(problem, file=sys.stderr)
    if not problems:
        print(f"{args.tag}: versions agree")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
