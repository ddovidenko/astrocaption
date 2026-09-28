# Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `vX.Y.Z` tag push builds a multi-arch image, pushes it to GHCR and creates a GitHub Release with `compose.yml` attached, with no manual step.

**Architecture:** One new workflow `.github/workflows/release.yml` (tag guard → amd64 smoke → multi-arch push → `gh release create`). The tag guard is a small Python script under `backend/scripts/` so it has a unit test and a `make` target; the workflow calls it. The Dockerfile's Node stage is pinned to the build platform so Vite is not run under QEMU.

**Tech Stack:** GitHub Actions (`docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action`, `docker/build-push-action`), `gh` CLI, Python 3.13+ stdlib (`tomllib`, `json`, `re`), pytest.

**Spec:** `docs/superpowers/specs/2026-09-27-release-workflow-design.md` (issue #156).

## Global Constraints

- Image name `ghcr.io/ddovidenko/astrocaption`; tags `X.Y.Z`, `X.Y`, `latest`; platforms `linux/amd64,linux/arm64` (SPEC § 11).
- Pre-release tags (anything with `-` after the version, e.g. `v0.1.0-rc1`) publish only `X.Y.Z-…`; no `X.Y`, no `latest`; Release marked pre-release.
- The three version files must agree with the tag: `backend/pyproject.toml`, `backend/app/__init__.py`, `frontend/package.json`.
- Image under 400 MB (CLAUDE.md); the release smoke step enforces it like CI does.
- No new third-party action beyond the three Docker ones the owner approved. Release creation uses `gh`.
- Python: type hints everywhere, ruff defaults (line length 100, isort), mypy strict (scripts are in `files`).
- Never push to `main`; commit on `feat/release-workflow`.
- Nothing here calls nova or touches `data/`.

## Review Focus

1. A tag like `v0.1.0` while `package.json` still says `0.0.9` must fail the guard naming the file, not push a mislabelled image. (Task 1 test `test_check_reports_each_mismatching_file`.)
2. A tag with a `-` suffix must not create `latest` or `X.Y`; a stable tag must create all three. (Task 3: `enable` expressions on the metadata tags; verified in the rc dry run since Actions expressions have no local test.)
3. A tag whose name is not `v` + semver (`v1`, `release-1`) must fail the guard before any build. (Task 1 test `test_check_rejects_non_semver_tag`.)
4. The amd64 smoke must fail the job if `/api/health` never answers; a hung container must not stall the job for six hours. (Task 3: 30 s bounded poll, then a hard `curl -f`.)
5. A re-run of the workflow for the same tag (e.g. after a transient GHCR error) must not fail on "release already exists". (Task 3: `gh release view` first, create only if absent.)

---

### Task 1: Tag guard script

**Files:**
- Create: `backend/scripts/check_release_version.py`
- Create: `backend/tests/test_check_release_version.py`
- Modify: `Makefile` (new target `check-version`)
- Modify: `CLAUDE.md` Commands block (one line for the target)

**Interfaces:**
- Produces: `versions(root: Path) -> dict[str, str]` mapping the three repo-relative file paths to the version string found in each; `check(tag: str, root: Path) -> list[str]` returning human-readable problems (empty list means the tag is good); `main(argv: list[str] | None = None) -> int` (0 ok, 1 problems, printing each problem on its own line). Task 3's workflow runs `python scripts/check_release_version.py "$GITHUB_REF_NAME"` from `backend/`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_check_release_version.py
"""The release workflow refuses a tag that disagrees with the three version files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.check_release_version import check, main, versions


def write_tree(root: Path, *, pyproject: str, init: str, package: str) -> None:
    (root / "backend" / "app").mkdir(parents=True)
    (root / "frontend").mkdir()
    (root / "backend" / "pyproject.toml").write_text(
        f'[project]\nname = "astrocaption"\nversion = "{pyproject}"\n'
    )
    (root / "backend" / "app" / "__init__.py").write_text(
        f'"""pkg."""\n\n__version__ = "{init}"\n'
    )
    (root / "frontend" / "package.json").write_text(
        json.dumps({"name": "astrocaption", "version": package}) + "\n"
    )


def test_versions_reads_all_three_files(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    assert versions(tmp_path) == {
        "backend/pyproject.toml": "0.1.0",
        "backend/app/__init__.py": "0.1.0",
        "frontend/package.json": "0.1.0",
    }


def test_check_accepts_a_matching_tag(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    assert check("v0.1.0", tmp_path) == []


def test_check_accepts_a_matching_prerelease_tag(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0-rc1", init="0.1.0-rc1", package="0.1.0-rc1")
    assert check("v0.1.0-rc1", tmp_path) == []


def test_check_reports_each_mismatching_file(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.0.9")
    problems = check("v0.1.0", tmp_path)
    assert len(problems) == 1
    assert "frontend/package.json" in problems[0]
    assert "0.0.9" in problems[0]
    assert "0.1.0" in problems[0]


def test_check_rejects_non_semver_tag(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    for tag in ("v1", "release-1", "0.1.0", "v0.1.0 "):
        problems = check(tag, tmp_path)
        assert problems, tag
        assert tag.strip() in problems[0]


def test_check_reports_missing_version_field(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    (tmp_path / "backend" / "app" / "__init__.py").write_text('"""no version here."""\n')
    problems = check("v0.1.0", tmp_path)
    assert any("backend/app/__init__.py" in p for p in problems)


def test_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.2.0")
    assert main(["v0.1.0", "--root", str(tmp_path)]) == 1
    out = capsys.readouterr().out
    assert "frontend/package.json" in out
    (tmp_path / "frontend" / "package.json").write_text(json.dumps({"version": "0.1.0"}))
    assert main(["v0.1.0", "--root", str(tmp_path)]) == 0


def test_repo_versions_agree() -> None:
    """The real tree: all three files carry one version, so a tag can match them."""
    root = Path(__file__).resolve().parents[2]
    found = set(versions(root).values())
    assert len(found) == 1, found
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_check_release_version.py -q`
Expected: FAIL at import, `ModuleNotFoundError: No module named 'scripts.check_release_version'`.

- [ ] **Step 3: Write the script**

```python
# backend/scripts/check_release_version.py
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

# v + semver: MAJOR.MINOR.PATCH with an optional pre-release suffix (-rc1, -beta.2).
TAG_RE = re.compile(r"^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$")
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
    match = TAG_RE.match(tag)
    if match is None:
        return [f"tag {tag.strip()!r} is not v<major>.<minor>.<patch>[-<prerelease>]"]
    wanted = match.group(1)
    found = versions(root)
    problems = [
        f"{rel}: no version field found" for rel in (PYPROJECT, INIT, PACKAGE_JSON) if rel not in found
    ]
    problems += [
        f"{rel}: version is {have} but the tag says {wanted}"
        for rel, have in found.items()
        if have != wanted
    ]
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/pytest tests/test_check_release_version.py -q`
Expected: 8 passed.

- [ ] **Step 5: Add the make target and document it**

In `Makefile`, after the `render-vectors`/`names-vectors` targets (keep the `## ` help comment style used by the neighbours):

```make
check-version: $(VENV)/.installed ## Check that TAG matches the three version files: make check-version TAG=v0.1.0
	@test -n "$(TAG)" || { echo "usage: make check-version TAG=v0.1.0"; exit 2; }
	cd backend && .venv/bin/python scripts/check_release_version.py "$(TAG)"
```

In `CLAUDE.md`, inside the Commands code block after the `make names-catalog` line:

```
make check-version TAG=v0.1.0   # the release workflow's tag guard: TAG must equal the version in pyproject, app/__init__.py and package.json
```

Run: `make check-version TAG=v0.1.0` → prints `v0.1.0: versions agree`, exit 0.
Run: `make check-version TAG=v9.9.9; echo $?` → three mismatch lines, exit 1.

- [ ] **Step 6: Lint**

Run: `cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy`
Expected: clean. If ruff format complains, run `.venv/bin/ruff format scripts/check_release_version.py tests/test_check_release_version.py` and re-check.

- [ ] **Step 7: Commit**

```bash
git add backend/scripts/check_release_version.py backend/tests/test_check_release_version.py Makefile CLAUDE.md
git commit -m "feat: release tag guard script (make check-version)"
```

---

### Task 2: Dockerfile builds the frontend on the build platform

**Files:**
- Modify: `docker/Dockerfile:5` (the `FROM node:24-alpine AS frontend` line and the comment above it)

**Interfaces:**
- Produces: an image identical in content to today's; the only change is where the Node stage runs during a multi-arch build. Task 3 relies on this so the arm64 half of the release build does not run `npm ci` and `vite build` under QEMU.

- [ ] **Step 1: Edit the Dockerfile**

Replace

```dockerfile
# ---- stage 1: frontend -------------------------------------------------------------
FROM node:24-alpine AS frontend
```

with

```dockerfile
# ---- stage 1: frontend -------------------------------------------------------------
# The bundle is platform-independent, so under a multi-arch build (release.yml) this stage
# runs once on the runner's own architecture instead of once per target under QEMU.
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend
```

- [ ] **Step 2: Build locally and record the size**

Run: `make build`
Expected: builds; the trailing `docker image ls astrocaption:local` line shows a size. Write the MB figure into the PR description later (Task 5). It must be under 400 MB; if it is not, stop and report, since that is the release blocker the CLAUDE.md rule guards. (`sudo docker` if the shell lacks the docker group.)

- [ ] **Step 3: Boot the local image and hit health**

```bash
docker run -d --rm --name ac-plan -p 8011:8000 -e NOVA_API_KEY=x astrocaption:local
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8011/api/health && break; sleep 1; done; echo
docker rm -f ac-plan
```

Expected: a JSON health body including `"version":"0.1.0"`.

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile
git commit -m "build: run the frontend stage on the build platform"
```

---

### Task 3: release.yml

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `backend/scripts/check_release_version.py` (Task 1) as `python scripts/check_release_version.py "$GITHUB_REF_NAME"`; the CI job's smoke shell (copied verbatim from `.github/workflows/ci.yml`, "image size must stay under 400 MB" and the boot loop).
- Produces: images `ghcr.io/ddovidenko/astrocaption:{X.Y.Z,X.Y,latest}` and a GitHub Release. Nothing else in the repo depends on it.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/release.yml
# Push a tag vX.Y.Z (or vX.Y.Z-rc1 for a dry run) and this publishes the image and a Release.
# Cutting a release: bump backend/pyproject.toml, backend/app/__init__.py and frontend/package.json
# in a `chore: release vX.Y.Z` PR, merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write   # the GitHub Release
  packages: write   # GHCR

concurrency:
  group: release-${{ github.ref_name }}
  cancel-in-progress: false

env:
  IMAGE: ghcr.io/${{ github.repository }}

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-python@v7
        with:
          python-version: "3.14"
      - name: the tag must match the three version files
        run: cd backend && python scripts/check_release_version.py "$GITHUB_REF_NAME"

      - uses: docker/setup-qemu-action@v4
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: image tags and labels
        id: meta
        uses: docker/metadata-action@v6
        with:
          images: ${{ env.IMAGE }}
          # A pre-release tag (v0.1.0-rc1) gets only its own tag: no X.Y, no latest.
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}},enable=${{ !contains(github.ref_name, '-') }}
            type=raw,value=latest,enable=${{ !contains(github.ref_name, '-') }}
          labels: |
            org.opencontainers.image.title=AstroCaption
            org.opencontainers.image.licenses=MIT

      # Build the amd64 half alone first and smoke it. Nothing has been pushed if this fails.
      - name: build amd64 for the smoke test
        uses: docker/build-push-action@v7
        with:
          context: .
          file: docker/Dockerfile
          platforms: linux/amd64
          push: false
          load: true
          tags: astrocaption:release-smoke
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: image size must stay under 400 MB
        run: |
          size=$(docker image inspect astrocaption:release-smoke --format '{{.Size}}')
          echo "image size: $((size / 1024 / 1024)) MB"
          test "$size" -lt $((400 * 1024 * 1024))
      - name: the image boots and answers /api/health
        run: |
          docker run -d --name ac -p 8000:8000 -e NOVA_API_KEY=smoke astrocaption:release-smoke
          for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8000/api/health && break; sleep 1; done
          echo
          curl -fsS http://127.0.0.1:8000/api/health | grep -F "\"version\":\"${GITHUB_REF_NAME#v}\""
      - name: container log
        if: failure()
        continue-on-error: true
        run: docker logs ac
      - name: remove the container
        if: always()
        continue-on-error: true
        run: docker rm -f ac

      - name: build both platforms and push
        uses: docker/build-push-action@v7
        with:
          context: .
          file: docker/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: GitHub Release with compose.yml and generated notes
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name }}
        run: |
          if gh release view "$TAG" >/dev/null 2>&1; then
            echo "release $TAG already exists; uploading compose.yml"
            gh release upload "$TAG" compose.yml --clobber
            exit 0
          fi
          prerelease=""
          case "$TAG" in *-*) prerelease="--prerelease";; esac
          gh release create "$TAG" compose.yml --verify-tag --generate-notes $prerelease
```

Notes for the implementer:
- `docker/setup-qemu-action@v4`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/metadata-action@v6`, `docker/build-push-action@v7`: use the current majors at implementation time (`gh api repos/docker/<action>/releases/latest --jq .tag_name`); `buildx@v4` and `build-push@v7` match what `ci.yml` already pins.
- The health grep is the tag guard's runtime twin: it fails if the running image reports a different version than the tag (e.g. a stale build cache serving an old `__init__.py`).
- Keep the two smoke shell blocks byte-identical to `ci.yml` apart from the image name; the spec chose duplication over a composite action.

- [ ] **Step 2: Validate the YAML parses and the expressions are well-formed**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"` (PyYAML is in the backend venv: `backend/.venv/bin/python`).
Expected: `yaml ok`.

If Docker is available, a stronger check of the workflow syntax is `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color`. Fix anything it reports. (This is a one-off local check, not a new dependency; do not add it to `make lint`.)

- [ ] **Step 3: Confirm the `enable=` expressions**

`docker/metadata-action` evaluates `enable=` after GitHub substitutes `${{ }}`, so the result is the literal `true`/`false`. Check the metadata-action README section "tags input → enable" via Context7 (`/docker/metadata-action`) that `enable=false` drops the tag entirely rather than emitting an empty one. Note the finding in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: release workflow publishes a multi-arch image and a GitHub Release on v* tags"
```

---

### Task 4: Docs

**Files:**
- Modify: `docs/INSTALL.md` (new section before "## Behind a reverse proxy", i.e. after the "## Data directory layout" section that ends at line 149)
- Modify: `docs/SPEC.md:461-462` (the `release.yml` bullet)
- Modify: `CLAUDE.md:95-99` (the Flow bullet)

- [ ] **Step 1: INSTALL.md**

Insert before `## Behind a reverse proxy`:

```markdown
## Releases, tags and upgrades

Images are published to `ghcr.io/ddovidenko/astrocaption` by the release workflow when a
`vX.Y.Z` tag is pushed:

| Tag | Meaning |
|---|---|
| `X.Y.Z` | that release, never changes |
| `X.Y` | the newest patch of that minor |
| `latest` | the newest stable release (never `main`, never a pre-release) |

Pre-releases (`0.2.0-rc1`) get only their own tag and are marked as such on the GitHub
Releases page, which also carries the release notes and the `compose.yml` of that version.

To upgrade an instance that uses `compose.yml` as shipped (`image: …:latest`):

```sh
docker compose pull && docker compose up -d
```

Back up `./data` first: the database schema is migrated forward on start, and an older image
refuses to start on a database written by a newer one. Pin `image:` to `X.Y` if you would rather
take patches only.
```

- [ ] **Step 2: SPEC.md § 12**

Replace lines 461–462:

```markdown
  - `release.yml` on tag `v*`: build multi-arch image, push to GHCR, attach `compose.yml` and a
    changelog to the GitHub Release. Uses `docker/build-push-action` with layer cache.
```

with

```markdown
  - `release.yml` on tag `v*`: refuse the tag unless it equals the version in `backend/pyproject.toml`,
    `backend/app/__init__.py` and `frontend/package.json` (`make check-version TAG=…`); build and smoke
    the amd64 image (size cap, `/api/health` reports the tag's version); then build amd64 + arm64,
    push to GHCR (`X.Y.Z`, `X.Y`, `latest`; a `-rc` tag gets only `X.Y.Z-rcN` and a pre-release)
    and create the GitHub Release with generated notes and `compose.yml` attached.
    Uses `docker/build-push-action` with the GHA layer cache.
```

- [ ] **Step 3: CLAUDE.md Flow bullet**

Append to the Flow bullet (after "Never push to `main`."):

```
  Cutting a release: bump the three version files in a `chore: release vX.Y.Z` PR, merge, then
  `git tag vX.Y.Z && git push origin vX.Y.Z`; `release.yml` does the rest. Dry-run with a `-rcN` tag first.
```

- [ ] **Step 4: Commit**

```bash
git add docs/INSTALL.md docs/SPEC.md CLAUDE.md
git commit -m "docs: release tags, upgrades and how a release is cut"
```

---

### Task 5: Lint, tests, PR

**Files:** none new.

- [ ] **Step 1: Full lint and test**

Run: `make lint test`
Expected: all green (ruff, mypy, eslint, tsc, pytest, vitest).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/release-workflow
gh pr create --title "feat: release workflow publishes a multi-arch GHCR image on v* tags" --body-file /tmp/claude-1000/-home-dmitr-astrocaption/173f80c0-2022-4d46-b59c-eb3eced6ba13/scratchpad/pr-body.md
```

PR body (write to the scratchpad file first):

```markdown
Milestone 6, PR 1. Closes #156. Spec: docs/superpowers/specs/2026-09-27-release-workflow-design.md.

- `release.yml` on `v*` tags: tag guard → amd64 build + smoke (size cap, health reports the tag's version) → amd64+arm64 push to GHCR → `gh release create` with `compose.yml` and generated notes. `-rcN` tags publish only their own tag as a pre-release.
- `make check-version TAG=v0.1.0`: the guard, unit-tested.
- Dockerfile: the Node stage runs on `$BUILDPLATFORM`, so Vite is not emulated under QEMU.
- INSTALL: tags and upgrades. SPEC § 12 and CLAUDE.md describe the flow.

Local image size after this change: <N> MB (`make build`).

Not verified here: the workflow itself only runs on a tag. Dry run after merge: bump to `0.1.0-rc1`, tag `v0.1.0-rc1`, then check the manifest list, the absence of `latest`, and the pre-release (steps in the spec's Verification section).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 3: Watch CI**

Run: `gh pr checks --watch`
Expected: backend, frontend, docker green. Then stop: the owner decides on merge (never merge without the explicit go).

---

## After merge (owner-driven, from the spec's Verification section)

1. Chore PR bumping the three version files to `0.1.0-rc1`; merge.
2. `git checkout main && git pull && git tag v0.1.0-rc1 && git push origin v0.1.0-rc1`; `gh run watch`.
3. Check: `docker manifest inspect ghcr.io/ddovidenko/astrocaption:0.1.0-rc1` lists amd64 and arm64; `docker manifest inspect ghcr.io/ddovidenko/astrocaption:latest` fails (not created); `gh release view v0.1.0-rc1` shows pre-release, notes, `compose.yml` asset.
4. Make the GHCR package public once (Package settings → Change visibility); then `docker pull` on the dev host and run it via `compose.yml` with `image:` pointed at `0.1.0-rc1`.
5. Any failure: fix-forward PR, bump to `-rc2`, new tag. Then #44 next.
