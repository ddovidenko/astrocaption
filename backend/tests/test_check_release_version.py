"""The release workflow refuses a tag that disagrees with the version files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.check_release_version import VersionFileError, check, main, versions


def write_tree(
    root: Path, *, pyproject: str, init: str, package: str, lock: tuple[str, str] | None = None
) -> None:
    """``lock`` is the lockfile's (top-level, packages[""]) pair; by default both follow package."""
    (root / "backend" / "app").mkdir(parents=True)
    (root / "frontend").mkdir()
    (root / "backend" / "pyproject.toml").write_text(
        f'[project]\nname = "astrocaption"\nversion = "{pyproject}"\n'
    )
    (root / "backend" / "app" / "__init__.py").write_text(f'"""pkg."""\n\n__version__ = "{init}"\n')
    (root / "frontend" / "package.json").write_text(
        json.dumps({"name": "astrocaption", "version": package}) + "\n"
    )
    top, nested = lock or (package, package)
    (root / "frontend" / "package-lock.json").write_text(
        json.dumps({"name": "astrocaption", "version": top, "packages": {"": {"version": nested}}})
    )


def test_versions_reads_every_location(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    assert versions(tmp_path) == {
        "backend/pyproject.toml": "0.1.0",
        "backend/app/__init__.py": "0.1.0",
        "frontend/package.json": "0.1.0",
        "frontend/package-lock.json (version)": "0.1.0",
        'frontend/package-lock.json (packages[""].version)': "0.1.0",
    }


def test_check_accepts_a_matching_tag(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    assert check("v0.1.0", tmp_path) == []


def test_check_accepts_a_matching_prerelease_tag(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0-rc1", init="0.1.0-rc1", package="0.1.0-rc1")
    assert check("v0.1.0-rc1", tmp_path) == []


def test_check_reports_each_mismatching_file(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.0.9", lock=("0.1.0", "0.1.0"))
    problems = check("v0.1.0", tmp_path)
    assert len(problems) == 1
    assert "frontend/package.json" in problems[0]
    assert "0.0.9" in problems[0]
    assert "0.1.0" in problems[0]


def test_check_rejects_non_semver_tag(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    for tag in ("v1", "release-1", "0.1.0", "v0.1.0 ", "v0.1.0\n"):
        problems = check(tag, tmp_path)
        assert problems, tag
        assert repr(tag) in problems[0]


def test_check_rejects_tags_that_semver_would_normalise(tmp_path: Path) -> None:
    """metadata-action parses loosely: v01.1.0 would ship as image tag 1.1.0 while
    /api/health says 01.1.0, the drift the guard exists to prevent. Refuse them here."""
    write_tree(tmp_path, pyproject="01.1.0", init="01.1.0", package="01.1.0")
    for tag in ("v01.1.0", "v0.1.0-", "v0.1.0-.", "v0.1.0-rc1..", "v0.1.0-rc1.", "v0.1.0-rc_1"):
        assert check(tag, tmp_path), tag


def test_check_accepts_dotted_prerelease_identifiers(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="1.0.0-beta.2", init="1.0.0-beta.2", package="1.0.0-beta.2")
    assert check("v1.0.0-beta.2", tmp_path) == []


def test_check_reports_missing_version_field(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    (tmp_path / "backend" / "app" / "__init__.py").write_text('"""no version here."""\n')
    problems = check("v0.1.0", tmp_path)
    assert any("backend/app/__init__.py" in p for p in problems)


def test_check_reports_each_lockfile_field(tmp_path: Path) -> None:
    """A hand-edited package.json leaves the lockfile behind; both of its fields are named."""
    write_tree(tmp_path, pyproject="0.2.0", init="0.2.0", package="0.2.0", lock=("0.1.0", "0.2.0"))
    problems = check("v0.2.0", tmp_path)
    assert problems == [
        "frontend/package-lock.json (version): version is 0.1.0 but the tag says 0.2.0"
    ]
    (tmp_path / "frontend" / "package-lock.json").write_text(
        json.dumps({"version": "0.2.0", "packages": {"": {"version": "0.1.0"}}})
    )
    problems = check("v0.2.0", tmp_path)
    assert problems == [
        'frontend/package-lock.json (packages[""].version): version is 0.1.0 but the tag says 0.2.0'
    ]


def test_check_names_a_missing_file_instead_of_raising(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    (tmp_path / "frontend" / "package-lock.json").unlink()
    problems = check("v0.1.0", tmp_path)
    assert len(problems) == 1 and problems[0].startswith(
        "frontend/package-lock.json: cannot be read"
    )
    with pytest.raises(VersionFileError):
        versions(tmp_path)


def test_check_names_a_file_that_does_not_parse(tmp_path: Path) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.1.0")
    (tmp_path / "backend" / "pyproject.toml").write_text("[project\nversion = ")
    (tmp_path / "frontend" / "package.json").write_text("{nope")
    problems = check("v0.1.0", tmp_path)
    assert [p.split(" (")[0] for p in problems] == [
        "backend/pyproject.toml: not valid TOML",
        "frontend/package.json: not valid JSON",
    ]


def test_main_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    write_tree(tmp_path, pyproject="0.1.0", init="0.1.0", package="0.2.0")
    assert main(["v0.1.0", "--root", str(tmp_path)]) == 1
    captured = capsys.readouterr()
    assert "frontend/package.json" in captured.err and captured.out == ""  # problems go to stderr
    (tmp_path / "frontend" / "package.json").write_text(json.dumps({"version": "0.1.0"}))
    (tmp_path / "frontend" / "package-lock.json").write_text(
        json.dumps({"version": "0.1.0", "packages": {"": {"version": "0.1.0"}}})
    )
    assert main(["v0.1.0", "--root", str(tmp_path)]) == 0
    assert capsys.readouterr().out.strip() == "v0.1.0: versions agree"


def test_repo_versions_agree() -> None:
    """The real tree: every location carries one version, so a tag can match them."""
    root = Path(__file__).resolve().parents[2]
    found = set(versions(root).values())
    assert len(found) == 1, found
