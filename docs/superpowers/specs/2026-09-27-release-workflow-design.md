# Release workflow (milestone 6, PR 1)

Implements SPEC § 11 (image on GHCR, multi-arch) and § 12 (`release.yml`). Issue #156.
Milestone 6 track: this PR, then #44 (TRUST_PROXY), #68 + #69 (solved-image gate, tolerant label
load), #157 (issue templates), #158 (Codespaces), #159 (README/INSTALL), #160 (branch protection + tag).

## Goal

Pushing a tag `vX.Y.Z` to the repo produces, with no manual step:

- `ghcr.io/ddovidenko/astrocaption:X.Y.Z`, `:X.Y` and `:latest`, one manifest list covering
  `linux/amd64` and `linux/arm64`;
- a GitHub Release for the tag with generated notes and `compose.yml` attached.

A pre-release tag (`v0.1.0-rc1`) publishes `:0.1.0-rc1` only (no `:X.Y`, no `:latest`) and marks the
Release as a pre-release. That is the dry run before `v0.1.0`.

## What changes

### `docker/Dockerfile`

`FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend`. The bundle is platform-independent, so
the Vite build runs once on the runner's own architecture instead of once per target under QEMU.
The runtime stage is unchanged: `python:3.14-slim` is multi-arch and the app's wheels
(Pillow, pydantic-core, httpx, uvicorn) ship `cp314` manylinux wheels for aarch64. If the arm64 build
falls back to compiling a wheel from source the dry run will show it in the build time; that is the
signal to pin or drop the package, not a case to design for now.

### `.github/workflows/release.yml`

Trigger: `push` on tags `v*`. Permissions: `contents: write` (the Release), `packages: write` (GHCR).
Concurrency group per tag. One job, steps in order:

1. **Checkout.**
2. **Tag guard.** The tag without its `v` must equal the version in `backend/pyproject.toml`,
   `backend/app/__init__.py` and `frontend/package.json`. A mismatch fails the job before anything
   is pushed, so the `/api/health` version and the image tag cannot disagree. The three files are
   bumped by hand in a `chore: release vX.Y.Z` PR before tagging; the guard is what makes that
   discipline enforceable rather than a workflow that edits files.
3. **QEMU + Buildx** (`docker/setup-qemu-action`, `docker/setup-buildx-action`).
4. **Login to GHCR** with `GITHUB_TOKEN` (`docker/login-action`).
5. **Tags and labels** from `docker/metadata-action`: `type=semver,pattern={{version}}`,
   `type=semver,pattern={{major}}.{{minor}}` and `latest` (both of the latter disabled for tags
   containing `-`), plus the standard OCI labels (source, revision, version, licence).
6. **Smoke the amd64 image first.** `build-push-action` with `load: true`, `platforms: linux/amd64`,
   `push: false`, same GHA layer cache as CI. Then the same checks CI runs against `astrocaption:ci`:
   image size under 400 MB, container boots, `/api/health` answers 200. Nothing has been pushed yet
   if this fails.
7. **Multi-arch build and push.** `build-push-action` again with `platforms: linux/amd64,linux/arm64`,
   `push: true`, the metadata tags and labels, `cache-from: type=gha`. The amd64 layers come from the
   cache written in step 6, so this mostly costs the arm64 runtime stage.
8. **GitHub Release.** `gh release create "$TAG" compose.yml --generate-notes --verify-tag`, with
   `--prerelease` when the tag contains `-`. Using the `gh` CLI that the runner already carries
   avoids a further third-party action. Generated notes list the squash-merged PRs since the previous
   tag; that is the changelog SPEC § 12 asks for.

The three new actions (`setup-qemu-action`, `login-action`, `metadata-action`) fall under the
existing `actions` Dependabot group, so they update with the rest.

### `.github/workflows/ci.yml`

No behaviour change. The image-size and health checks are duplicated verbatim from CI into the
release job's smoke step. Two copies of a five-line shell block cost less than a composite action;
a third copy would be the point to extract one.

### Docs

- `docs/INSTALL.md`: a "Releases and tags" paragraph: what `:latest`, `:X.Y` and `:X.Y.Z` mean,
  that `latest` tracks the newest stable tag and never `main`, and that `docker compose pull && docker
  compose up -d` is the upgrade. The full self-hoster rewrite of INSTALL waits for #159.
- `docs/SPEC.md` § 12: the release bullet gains the tag guard and the pre-release convention.
- `CLAUDE.md` "Commands": nothing new (there is no local target; a release is a tag push). The
  "Flow" bullet gains one sentence on cutting a release: bump the three version files in a chore PR,
  merge, `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Out of scope

- Signing or attestations (cosign, provenance). Not in SPEC; revisit if a self-hoster asks.
- A local multi-arch `make` target. `make build` stays single-arch; the workflow is the only
  multi-arch builder.
- Editing `compose.yml`'s header comment ("once released") and the README status line: #159.
- Branch protection and the `v0.1.0` tag itself: #160, after the rc dry run.

## Verification

Workflows have no unit tests. Verification is the dry run:

1. Merge the PR (CI green as usual; the release workflow does not run on PRs).
2. Bump the three version files to `0.1.0-rc1` in a chore PR, merge, tag `v0.1.0-rc1`, push the tag.
3. Watch the run (`gh run watch`). Check: the tag guard passed, the amd64 smoke passed, the run
   pushed one manifest list with both platforms (`docker manifest inspect ghcr.io/…:0.1.0-rc1`),
   no `:latest` was created, the Release exists as a pre-release with `compose.yml` attached and
   notes listing the PRs since the first commit.
4. On the dev host: `docker pull ghcr.io/ddovidenko/astrocaption:0.1.0-rc1`, run it with
   `compose.yml` pointing at that tag, sign in, upload and export once. If a Raspberry Pi or any
   arm64 box is available, the same pull there proves the arm64 half; otherwise
   `docker run --platform linux/arm64 … python -c "import PIL, pydantic_core"` under QEMU is the
   fallback check.
5. Failure at any step is a fix-forward PR plus a new rc tag; rc tags are never deleted.

The GHCR package is created private on first push. Making it public (Package settings → Change
visibility) is a one-time manual step the dry run surfaces; INSTALL notes it in #159.
