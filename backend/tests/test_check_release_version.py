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
    (root / "backend" / "app" / "__init__.py").write_text(f'"""pkg."""\n\n__version__ = "{init}"\n')
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
