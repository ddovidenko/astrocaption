"""`make audit` fails when the image's Node or Python is close to its end of life.

No test here touches the network: ``check`` takes the lookup as an argument.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from scripts import check_runtime_eol
from scripts.check_runtime_eol import DOCKERFILE, EolLookupError, check, main, pinned

DOCKER = """\
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:26-alpine AS frontend
RUN npm ci
FROM python:3.15-slim AS runtime
"""
EOL: dict[tuple[str, str], object] = {
    ("nodejs", "26"): "2029-04-30",
    ("python", "3.15"): "2031-10-31",
}
TODAY = date(2026, 11, 25)


def write(root: Path, text: str = DOCKER) -> Path:
    (root / "docker").mkdir()
    (root / DOCKERFILE).write_text(text)
    return root


def table(product: str, cycle: str) -> object:
    return EOL[(product, cycle)]


def test_the_repo_dockerfile_names_both_runtimes() -> None:
    found, problems = pinned()
    assert problems == []
    assert set(found) == {"node", "python"}


def test_release_lines_come_from_the_from_lines(tmp_path: Path) -> None:
    assert pinned(write(tmp_path)) == ({"node": "26", "python": "3.15"}, [])


def test_a_patch_pin_still_names_its_release_line(tmp_path: Path) -> None:
    text = DOCKER.replace("node:26-alpine", "node:26.13.1-alpine").replace("3.15-slim", "3.15.2")
    assert pinned(write(tmp_path, text))[0] == {"node": "26", "python": "3.15"}


def test_supported_runtimes_pass_with_a_note_each(tmp_path: Path) -> None:
    problems, notes = check(TODAY, write(tmp_path), table)
    assert problems == []
    assert notes == [
        "node 26: supported until 2029-04-30 (887 days)",
        "python 3.15: supported until 2031-10-31 (1801 days)",
    ]


def test_inside_the_warning_window_is_a_problem(tmp_path: Path) -> None:
    problems, notes = check(date(2028, 11, 2), write(tmp_path), table)
    assert problems == ["node 26: end of life on 2029-04-30, in 179 days; plan the move now"]
    assert len(notes) == 1


def test_the_day_the_window_opens_still_passes(tmp_path: Path) -> None:
    assert check(date(2028, 11, 1), write(tmp_path), table)[0] == []


def test_past_end_of_life_is_a_problem(tmp_path: Path) -> None:
    problems, _ = check(date(2029, 5, 1), write(tmp_path), table)
    assert problems == ["node 26: past its end of life (2029-04-30); move to a supported one"]


@pytest.mark.parametrize(
    ("eol", "problem"),
    [
        (True, "past its end of life"),
        ("soon", "not a date"),
        (None, "not a date"),
        (20290430, "not a date"),
    ],
)
def test_other_answers_from_the_source(tmp_path: Path, eol: object, problem: str) -> None:
    problems, _ = check(TODAY, write(tmp_path), lambda product, cycle: eol)
    assert len(problems) == 2
    assert all(problem in p for p in problems)


def test_no_announced_end_of_life_passes(tmp_path: Path) -> None:
    problems, notes = check(TODAY, write(tmp_path), lambda product, cycle: False)
    assert problems == []
    assert notes[0] == "node 26: no end of life announced"


def test_a_failed_lookup_is_a_problem_not_a_pass(tmp_path: Path) -> None:
    def down(product: str, cycle: str) -> object:
        raise EolLookupError(f"endoflife.date could not be read for {product} {cycle}")

    problems, notes = check(TODAY, write(tmp_path), down)
    assert notes == []
    assert problems == [
        "node 26: endoflife.date could not be read for nodejs 26",
        "python 3.15: endoflife.date could not be read for python 3.15",
    ]


def test_a_runtime_missing_from_the_dockerfile_is_a_problem(tmp_path: Path) -> None:
    root = write(tmp_path, "FROM python:3.15-slim\n")
    problems, notes = check(TODAY, root, table)
    assert problems == [
        f"{DOCKERFILE}: no node image found, so its end of life is not being watched"
    ]
    assert len(notes) == 1


def test_a_tag_without_a_release_line_is_a_problem(tmp_path: Path) -> None:
    found, problems = pinned(write(tmp_path, DOCKER.replace("python:3.15-slim", "python:3-slim")))
    assert found == {"node": "26"}
    assert problems == [f"python:3 in {DOCKERFILE} does not name a release line"]


def test_a_missing_dockerfile_is_a_problem(tmp_path: Path) -> None:
    found, problems = pinned(tmp_path)
    assert found == {}
    assert len(problems) == 1
    assert problems[0].startswith(f"{DOCKERFILE}: cannot be read")


def test_main_exit_codes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(check_runtime_eol, "lookup", table)
    root = write(tmp_path)
    assert main(["--root", str(root)]) == 0
    assert "node 26: supported until 2029-04-30" in capsys.readouterr().out
    assert main(["--root", str(root), "--warn-days", "5000"]) == 1
    assert "plan the move now" in capsys.readouterr().err
