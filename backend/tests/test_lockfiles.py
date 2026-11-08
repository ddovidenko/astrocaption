"""The pinned requirements files stay in step with pyproject.toml.

`make lock` writes backend/requirements.txt (what the image installs) and
backend/requirements-dev.txt (what `make install` and CI install) from pyproject.toml with
uv; Dependabot and pip-audit read the pins (#250). This test is what fails when someone edits
pyproject.toml and forgets to run `make lock`, or when a Dependabot bump leaves the two files
disagreeing about a shared package.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

BACKEND = Path(__file__).resolve().parent.parent
PYPROJECT = BACKEND / "pyproject.toml"
RUNTIME_LOCK = BACKEND / "requirements.txt"
DEV_LOCK = BACKEND / "requirements-dev.txt"


@dataclass(frozen=True)
class Pin:
    version: Version
    hashes: int


def read_pins(path: Path) -> dict[str, Pin]:
    """Pinned name -> (version, hash count) from a uv/pip-compile style requirements file."""
    logical: list[str] = []
    buffer = ""
    for raw in path.read_text().splitlines():
        line = raw.split(" #", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line:
            continue
        if line.endswith("\\"):
            buffer += line[:-1]
            continue
        logical.append(buffer + line)
        buffer = ""
    pins: dict[str, Pin] = {}
    for entry in logical:
        spec, *options = entry.split(" --hash=")
        requirement = Requirement(spec)
        name = canonicalize_name(requirement.name)
        assert name not in pins, f"{path.name}: {name} is pinned twice"
        assert len(requirement.specifier) == 1, f"{path.name}: {entry} is not an exact pin"
        (specifier,) = requirement.specifier
        assert specifier.operator == "==", f"{path.name}: {entry} is not an exact pin"
        pins[name] = Pin(Version(specifier.version), len(options))
    return pins


def declared() -> tuple[list[Requirement], list[Requirement]]:
    project = tomllib.loads(PYPROJECT.read_text())["project"]
    runtime = [Requirement(dep) for dep in project["dependencies"]]
    dev = [Requirement(dep) for dep in project["optional-dependencies"]["dev"]]
    return runtime, dev


def assert_pinned(requirements: list[Requirement], pins: dict[str, Pin], lock: Path) -> None:
    for requirement in requirements:
        name = canonicalize_name(requirement.name)
        assert name in pins, f"{lock.name} lacks {requirement}; run `make lock`"
        assert pins[name].version in requirement.specifier, (
            f"{lock.name} pins {name}=={pins[name].version}, outside {requirement}; run `make lock`"
        )


@pytest.mark.parametrize("lock", [RUNTIME_LOCK, DEV_LOCK], ids=lambda p: p.name)
def test_lockfile_exists_and_every_pin_is_hashed(lock: Path) -> None:
    assert lock.is_file(), f"{lock.name} is missing; run `make lock`"
    pins = read_pins(lock)
    assert pins, f"{lock.name} pins nothing"
    unhashed = sorted(name for name, pin in pins.items() if pin.hashes == 0)
    assert not unhashed, f"{lock.name}: no --hash for {unhashed}"


def test_runtime_lock_covers_the_declared_dependencies() -> None:
    runtime, _ = declared()
    assert_pinned(runtime, read_pins(RUNTIME_LOCK), RUNTIME_LOCK)


def test_dev_lock_covers_runtime_and_dev_dependencies() -> None:
    runtime, dev = declared()
    pins = read_pins(DEV_LOCK)
    assert_pinned(runtime + dev, pins, DEV_LOCK)


def test_dev_lock_is_a_superset_of_the_runtime_lock() -> None:
    """The venv and CI must test the exact versions the image ships."""
    runtime = read_pins(RUNTIME_LOCK)
    dev = read_pins(DEV_LOCK)
    missing = sorted(set(runtime) - set(dev))
    assert not missing, f"requirements-dev.txt lacks runtime pins {missing}; run `make lock`"
    drift = {
        name: (str(pin.version), str(dev[name].version))
        for name, pin in runtime.items()
        if pin.version != dev[name].version
    }
    assert not drift, f"runtime and dev lockfiles disagree (runtime, dev): {drift}; run `make lock`"
