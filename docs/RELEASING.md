# Releasing

For maintainers. Self-hosters only need the tag table in `INSTALL.md`.

A release is a git tag `vX.Y.Z` on `main`. The `release.yml` workflow does everything else:
it refuses the tag unless it matches the version recorded in the three version files, builds
and smoke-tests the amd64 image (size cap, `/api/health` reports the tag's version), then
builds amd64 + arm64, pushes them to `ghcr.io/ddovidenko/astrocaption` and creates the GitHub
Release with generated notes and that version's `compose.yml` attached.

## Steps

1. **Bump the version** in one `chore: release vX.Y.Z` PR:
   `backend/pyproject.toml` and `backend/app/__init__.py` by hand, and `frontend/package.json`
   plus its lockfile with `npm --prefix frontend version X.Y.Z --no-git-tag-version`.
   `make check-version TAG=vX.Y.Z` is the same guard the workflow runs. Run `make screenshots`
   in the same PR: the README screenshots show the version in the page header.
2. **Merge** it (squash, like every PR), then `git checkout main && git pull`.
3. **Tag and push:** `git tag vX.Y.Z && git push origin vX.Y.Z`. Watch the run under Actions.
4. **Check the result:** the Release page lists the notes and `compose.yml`; the package page
   shows `X.Y.Z`, `X.Y` and `latest`; `docker compose pull && docker compose up -d` on an
   instance that follows `latest` picks it up.

## Pre-releases

Dry-run a release with an `-rcN` tag first: the version files must carry `X.Y.Z-rcN` for that
tag, and a second chore PR bumps them to `X.Y.Z` afterwards. An rc tag publishes only its own
image tag and a GitHub pre-release; it never moves `X.Y` or `latest`.

## What not to do

- **Never re-run an old tag's workflow after a newer stable release has shipped.** Every stable
  tag's run re-points `latest` (and `X.Y`) at the image it built, so re-running `v0.1.0` after
  `v0.2.0` exists would send everyone following `latest` back to 0.1.0. If an old release needs
  a fix, cut a new patch tag instead.
- Never push to `main` directly; `main` allows squash merges only, and the tag guard assumes the
  version files were changed in a reviewed PR.
- Never tag a commit whose version files do not match: the workflow stops at the guard, but the
  tag is already public, so delete it (`git push origin :vX.Y.Z`) before tagging again.

## Package visibility

The GHCR package inherits the repository's visibility through the image's source label, so the
public repo publishes a public package. A fork's package is private after its first push until
the fork's owner changes it under the package's settings.
