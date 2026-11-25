"""Fail when a runtime the image is built on is close to its end of life.

Dependabot is told to ignore major bumps of the Node build image (.github/dependabot.yml: odd
majors never become LTS, even ones only after their LTS date), so nothing proposes the next Node
on its own. This check is the reminder: it reads the Node and Python image tags from
docker/Dockerfile, asks endoflife.date when each goes out of support, and fails once that date is
less than WARN_DAYS away. `make audit` runs it, and the weekly audit workflow with it.

A lookup that fails is a failure too: a check that passes when it could not look is no reminder.

Run from backend/:  python scripts/check_runtime_eol.py   (or `make runtime-eol`; network)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DOCKERFILE = "docker/Dockerfile"
API = "https://endoflife.date/api/{product}/{cycle}.json"
TIMEOUT = 20
# Node 26 goes out of support on 2029-04-30 and Node 28 becomes LTS in October 2028: half a
# year of warning starts the reminder just after the next LTS exists to move to.
WARN_DAYS = 180

# Docker image name -> (endoflife.date product, how many version components name a release line).
RUNTIMES = {"node": ("nodejs", 1), "python": ("python", 2)}
FROM_RE = re.compile(
    r"^FROM\s+(?:--platform=\S+\s+)?(node|python):(\d+(?:\.\d+)*)", re.MULTILINE | re.IGNORECASE
)

Lookup = Callable[[str, str], object]


class EolLookupError(Exception):
    """endoflife.date could not be asked, or did not answer with a release line."""


def pinned(root: Path = REPO_ROOT) -> tuple[dict[str, str], list[str]]:
    """Release line per runtime (``{"node": "26", "python": "3.15"}``) from the Dockerfile's
    FROM lines, plus one problem per runtime whose line cannot be told."""
    try:
        text = (root / DOCKERFILE).read_text()
    except (OSError, UnicodeDecodeError) as exc:
        return {}, [f"{DOCKERFILE}: cannot be read ({exc})"]
    found: dict[str, str] = {}
    problems: list[str] = []
    for image, version in FROM_RE.findall(text):
        name = image.lower()
        parts = version.split(".")
        wanted = RUNTIMES[name][1]
        if len(parts) < wanted:
            problems.append(f"{name}:{version} in {DOCKERFILE} does not name a release line")
        else:
            found[name] = ".".join(parts[:wanted])
    problems += [
        f"{DOCKERFILE}: no {name} image found, so its end of life is not being watched"
        for name in RUNTIMES
        if name not in found and not any(p.startswith(f"{name}:") for p in problems)
    ]
    return found, problems


def lookup(product: str, cycle: str) -> object:
    """The ``eol`` field endoflife.date holds for a release line: a date string, or a boolean."""
    url = API.format(product=product, cycle=cycle)
    request = urllib.request.Request(url, headers={"User-Agent": "runtime-eol-check"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            data = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise EolLookupError(f"endoflife.date answered {exc.code} for {product} {cycle}") from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise EolLookupError(f"endoflife.date could not be read for {product} {cycle}") from exc
    if not isinstance(data, dict) or "eol" not in data:
        raise EolLookupError(f"endoflife.date has no end-of-life field for {product} {cycle}")
    return data["eol"]


def check(
    today: date,
    root: Path = REPO_ROOT,
    fetch: Lookup = lookup,
    warn_days: int = WARN_DAYS,
) -> tuple[list[str], list[str]]:
    """(problems, notes): a problem per runtime that is past, or within ``warn_days`` of, its
    end of life or whose date could not be found; a note per runtime that is fine."""
    found, problems = pinned(root)
    notes: list[str] = []
    for name, cycle in found.items():
        label = f"{name} {cycle}"
        try:
            eol = fetch(RUNTIMES[name][0], cycle)
        except EolLookupError as exc:
            problems.append(f"{label}: {exc}")
            continue
        if eol is False:
            notes.append(f"{label}: no end of life announced")
            continue
        if eol is True:
            problems.append(f"{label}: past its end of life; move {DOCKERFILE} to a supported one")
            continue
        try:
            ends = date.fromisoformat(eol) if isinstance(eol, str) else None
        except ValueError:
            ends = None
        if ends is None:
            problems.append(f"{label}: endoflife.date gave an end of life that is not a date")
            continue
        left = (ends - today).days
        if left < 0:
            problems.append(f"{label}: past its end of life ({ends}); move to a supported one")
        elif left < warn_days:
            problems.append(f"{label}: end of life on {ends}, in {left} days; plan the move now")
        else:
            notes.append(f"{label}: supported until {ends} ({left} days)")
    return problems, notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="repo root (tests)")
    parser.add_argument("--warn-days", type=int, default=WARN_DAYS, help="fail this close to it")
    args = parser.parse_args(argv)
    problems, notes = check(date.today(), args.root, lookup, args.warn_days)
    for note in notes:
        print(note)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
