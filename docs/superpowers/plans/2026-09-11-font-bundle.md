# Font Bundle Swap (Milestone 3, PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five bundled font families that have no Greek glyphs (Lato, Montserrat, Nunito, Poppins, Raleway) with five that do (Ubuntu, Manrope, Roboto Condensed, Play, Source Serif 4), with a repeatable fetch script, a regression test that every bundled font renders the glyphs labels need, and the docs updated.

**Architecture:** A small stdlib script, `backend/scripts/fetch_fonts.py`, holds the family list and downloads the static Regular/Bold TTFs from the Google Fonts CSS API (legacy user agent, `latin,latin-ext,greek,cyrillic` subsets) plus each family's licence text from the google/fonts repository, into `fonts/`. A new pytest, `backend/tests/test_fonts.py`, renders the Greek letters, the middle dot and the curly apostrophe in every bundled TTF and fails if any comes out as the font's missing-glyph box. The API, renderer and frontend need no change: fonts are discovered from the directory and referenced by file name.

**Tech Stack:** Python 3.13+ standard library (`urllib`, `re`), Pillow (already a dependency), pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-v1-design.md` § 1 (spike findings) and § 2 (font bundle); `docs/SPEC.md` § 9.

## Global Constraints

- Python 3.13+, type hints everywhere, ruff defaults, mypy. No new dependencies (CLAUDE.md: ask first).
- Fonts are referenced by file name only (`Inter-Regular.ttf`), never by family name; the file naming stays `<FamilyNoSpaces>-Regular.ttf` / `<FamilyNoSpaces>-Bold.ttf`.
- Twelve families, Regular + Bold, 24 files. `backend/tests/test_api.py::test_config_and_fonts` asserts `len(fonts) == 24` and must keep passing.
- The default style font stays `Inter-Regular.ttf` (`backend/app/models.py:239`); tests reference `Inter-Regular.ttf` and `Roboto-Bold.ttf`, both of which stay.
- Never call any network service from tests. The fetch script is run by hand (`make fonts`), like `make names-catalog`.
- Docker image under 400 MB (the swap changes the bundle by well under 1 MB).
- Backend commands run from `backend/` with `.venv/bin/pytest`, `.venv/bin/ruff`, `.venv/bin/mypy`; `make lint test` at the repo root before every commit that touches code.
- Conventional commit messages ending with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TNKdZ87piewzen3n7xzz4e
  ```
- Branch from `main` (the docs branch `docs/editor-v1-design` holds the spec; rebase or cherry-pick is not needed, the spec PR merges separately). Stop after `gh pr create` and `gh pr checks --watch`; the owner merges.
- Dev servers run as the systemd unit `astrocaption-dev`. Do not run `npm ci` or `make install` on this checkout while it is active; this PR needs neither.

## File map

| File | Responsibility |
|---|---|
| `backend/scripts/fetch_fonts.py` (create) | The bundled family list; `parse_css` turns a Google Fonts CSS response into `{weight: url}`; `main()` downloads TTFs and licences into `fonts/`. |
| `backend/tests/test_fetch_fonts.py` (create) | Pure tests for `parse_css` and the output file naming; no network. |
| `backend/tests/test_fonts.py` (create) | Glyph coverage of every bundled TTF (θ ι υ λ μ · ’), the regression guard for the bundle. |
| `Makefile` (modify) | `fonts` target running the script; `.PHONY` and the help line. |
| `fonts/*.ttf`, `fonts/LICENSES/*.txt` (modify) | Ten files out, ten in; five licence texts out, five in. |
| `fonts/README.md` (modify) | Family table, licence column, fetch instructions pointing at `make fonts`. |
| `docs/SPEC.md` § 9 (modify) | The new family list and the licence sentence. |
| `CLAUDE.md` (modify) | One line in the Commands block for `make fonts`. |

---

### Task 1: Glyph coverage test (fails on the current bundle)

**Files:**
- Create: `backend/tests/test_fonts.py`

**Interfaces:**
- Consumes: `app.config.REPO_ROOT` (the repo root `Path`, used by `conftest.py` as `FONTS_DIR = REPO_ROOT / "fonts"`), `app.fonts.list_fonts(fonts_dir) -> list[FontOut]`.
- Produces: nothing; a guard.

- [ ] **Step 1: Write the failing test**

```python
"""Every bundled font must render what a label can contain (SPEC § 9).

Bayer designations carry Greek letters (θ1 Ori C), alias lines use the middle dot and some
common names an apostrophe. A font that lacks a glyph makes Pillow draw its missing-glyph box
while the browser silently substitutes a system font, and preview and export stop agreeing.
"""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.fonts import list_fonts

from .conftest import FONTS_DIR

REQUIRED_GLYPHS = "θιυλμ·’"
NOT_A_CHARACTER = "￿"  # never mapped by any font: renders the .notdef box
SIZE = 60


def _ink(font: ImageFont.FreeTypeFont, text: str) -> bytes:
    img = Image.new("L", (SIZE * 2, SIZE * 2), 0)
    ImageDraw.Draw(img).text((SIZE // 2, SIZE // 2), text, font=font, fill=255)
    return img.tobytes()


@pytest.mark.parametrize("file", [f.file for f in list_fonts(FONTS_DIR)])
def test_bundled_font_has_every_label_glyph(file: str) -> None:
    font = ImageFont.truetype(str(FONTS_DIR / file), SIZE)
    notdef = _ink(font, NOT_A_CHARACTER)
    missing = [ch for ch in REQUIRED_GLYPHS if _ink(font, ch) == notdef]
    assert not missing, f"{file} cannot render {''.join(missing)!r}"


def test_bundle_is_twelve_families_regular_and_bold() -> None:
    files = sorted(f.file for f in list_fonts(FONTS_DIR))
    assert len(files) == 24
    families = {name.rsplit("-", 1)[0] for name in files}
    assert len(families) == 12
    for family in families:
        assert f"{family}-Regular.ttf" in files and f"{family}-Bold.ttf" in files
```

- [ ] **Step 2: Run it to verify it fails on the old bundle**

Run: `cd backend && .venv/bin/pytest tests/test_fonts.py -v`
Expected: 10 FAILED (`Lato-*`, `Montserrat-*`, `Nunito-*`, `Poppins-*`, `Raleway-*` cannot render `'θιυ…'`), 15 passed.

- [ ] **Step 3: Commit the test alone**

```bash
git add backend/tests/test_fonts.py
git commit -m "test: every bundled font must render the label glyphs

Fails on the current bundle: Lato, Montserrat, Nunito, Poppins and Raleway
have no Greek letters (SPEC § 9, spike of 2026-09-11)."
```
(Append the attribution lines from Global Constraints.)

---

### Task 2: Fetch script with a parser test

**Files:**
- Create: `backend/scripts/fetch_fonts.py`
- Create: `backend/tests/test_fetch_fonts.py`
- Modify: `Makefile` (after the `names-catalog` target, and the `.PHONY` line at the top)
- Modify: `CLAUDE.md` Commands block (after `make names-catalog`)

**Interfaces:**
- Produces: `FAMILIES: list[Family]` where `Family(name: str, licence: str)` (`licence` is the path inside github.com/google/fonts, e.g. `ofl/inter/OFL.txt`); `parse_css(css: str) -> dict[str, str]` mapping `"400"`/`"700"` to the TTF URL; `file_name(family: str, weight: str) -> str` giving `Inter-Regular.ttf` / `Inter-Bold.ttf`; `main() -> int`.

- [ ] **Step 1: Write the failing parser tests**

```python
"""The fetch script's pure parts. The network part is run by hand (`make fonts`)."""

from __future__ import annotations

import pytest

from scripts.fetch_fonts import FAMILIES, file_name, parse_css

CSS = """
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/regular.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/bold.ttf) format('truetype');
}
"""


def test_parse_css_maps_weight_to_ttf_url() -> None:
    assert parse_css(CSS) == {
        "400": "https://fonts.gstatic.com/s/manrope/v1/regular.ttf",
        "700": "https://fonts.gstatic.com/s/manrope/v1/bold.ttf",
    }


def test_parse_css_rejects_a_response_without_both_weights() -> None:
    with pytest.raises(ValueError, match="700"):
        parse_css("@font-face" + CSS.split("@font-face")[1])


def test_file_names_follow_the_bundle_convention() -> None:
    assert file_name("Roboto Condensed", "400") == "RobotoCondensed-Regular.ttf"
    assert file_name("Source Serif 4", "700") == "SourceSerif4-Bold.ttf"


def test_family_list_is_the_twelve_from_the_spec() -> None:
    assert [f.name for f in FAMILIES] == [
        "Inter", "Roboto", "Open Sans", "Source Sans 3", "Fira Sans", "IBM Plex Sans",
        "JetBrains Mono", "Ubuntu", "Manrope", "Roboto Condensed", "Play", "Source Serif 4",
    ]
    assert all(f.licence.endswith(("OFL.txt", "UFL.txt")) for f in FAMILIES)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && .venv/bin/pytest tests/test_fetch_fonts.py -v`
Expected: FAIL at import (`ModuleNotFoundError: No module named 'scripts.fetch_fonts'`).

- [ ] **Step 3: Write the script**

```python
"""Refresh the bundled fonts in fonts/ from Google Fonts (SPEC § 9).

The Google Fonts CSS API serves static TTF instances to a legacy user agent, one per
weight, for the subsets we ask for. Each family's licence text comes from the google/fonts
repository. Run from backend/:  python scripts/fetch_fonts.py   (or `make fonts` at the repo
root). Network access is needed; tests never run this.

Every family must cover Greek (Bayer letters such as θ1 Ori C), the middle dot and the
curly apostrophe; tests/test_fonts.py checks the result.
"""

from __future__ import annotations

import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

FONTS_DIR = Path(__file__).resolve().parent.parent.parent / "fonts"
LICENSES_DIR = FONTS_DIR / "LICENSES"
CSS_API = "https://fonts.googleapis.com/css"
SUBSETS = "latin,latin-ext,greek,cyrillic"
LICENCE_BASE = "https://raw.githubusercontent.com/google/fonts/main/"
LEGACY_UA = {"User-Agent": "Mozilla/4.0"}  # newer agents get variable WOFF2, not static TTF
WEIGHTS = {"400": "Regular", "700": "Bold"}
TIMEOUT = 60


@dataclass(frozen=True)
class Family:
    name: str
    licence: str  # path inside github.com/google/fonts


FAMILIES: list[Family] = [
    Family("Inter", "ofl/inter/OFL.txt"),
    Family("Roboto", "ofl/roboto/OFL.txt"),
    Family("Open Sans", "ofl/opensans/OFL.txt"),
    Family("Source Sans 3", "ofl/sourcesans3/OFL.txt"),
    Family("Fira Sans", "ofl/firasans/OFL.txt"),
    Family("IBM Plex Sans", "ofl/ibmplexsans/OFL.txt"),
    Family("JetBrains Mono", "ofl/jetbrainsmono/OFL.txt"),
    Family("Ubuntu", "ufl/ubuntu/UFL.txt"),
    Family("Manrope", "ofl/manrope/OFL.txt"),
    Family("Roboto Condensed", "ofl/robotocondensed/OFL.txt"),
    Family("Play", "ofl/play/OFL.txt"),
    Family("Source Serif 4", "ofl/sourceserif4/OFL.txt"),
]

_FACE = re.compile(r"font-weight:\s*(\d+);.*?url\((https://[^)]+\.ttf)\)", re.S)


def parse_css(css: str) -> dict[str, str]:
    """``{weight: ttf_url}`` from a CSS API response; both weights must be present."""
    found = {w: url for w, url in _FACE.findall(css) if w in WEIGHTS}
    missing = [w for w in WEIGHTS if w not in found]
    if missing:
        raise ValueError(f"CSS response lacks weight(s) {', '.join(missing)}")
    return found


def file_name(family: str, weight: str) -> str:
    return f"{family.replace(' ', '')}-{WEIGHTS[weight]}.ttf"


def _get(url: str) -> bytes:
    request = urllib.request.Request(url, headers=LEGACY_UA)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read()


def fetch_family(family: Family) -> list[str]:
    query = urllib.parse.quote(family.name) + ":400,700&subset=" + SUBSETS
    urls = parse_css(_get(f"{CSS_API}?family={query}").decode("utf-8"))
    written = []
    for weight, url in urls.items():
        name = file_name(family.name, weight)
        (FONTS_DIR / name).write_bytes(_get(url))
        written.append(name)
    licence = LICENSES_DIR / f"{family.name.replace(' ', '')}.txt"
    licence.write_bytes(_get(LICENCE_BASE + family.licence))
    return written


def main() -> int:
    LICENSES_DIR.mkdir(parents=True, exist_ok=True)
    expected: set[str] = set()
    for family in FAMILIES:
        written = fetch_family(family)
        expected.update(written)
        print(f"{family.name}: {', '.join(written)}")
    strays = sorted(p.name for p in FONTS_DIR.glob("*.ttf") if p.name not in expected)
    if strays:
        print(f"not in the family list, remove by hand: {', '.join(strays)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the parser tests**

Run: `cd backend && .venv/bin/pytest tests/test_fetch_fonts.py -v`
Expected: 4 passed.

- [ ] **Step 5: Add the make target and the CLAUDE.md line**

In `Makefile`, add `fonts` to the `.PHONY` list (line 9) and after the `names-catalog` target:

```make
fonts: $(VENV)/.installed ## Refresh fonts/*.ttf and fonts/LICENSES from Google Fonts (network)
	cd backend && .venv/bin/python scripts/fetch_fonts.py
```

In `CLAUDE.md`, in the Commands block after the `make names-catalog` line:

```
make fonts               # refresh fonts/*.ttf + LICENSES from Google Fonts (network); family list in backend/scripts/fetch_fonts.py
```

- [ ] **Step 6: Lint**

Run: `make lint`
Expected: ruff, mypy, eslint, tsc all clean (`backend/pyproject.toml` already points mypy at `scripts`, and `tests/test_record_nova_fixtures.py` imports a script the same way).

- [ ] **Step 7: Commit**

```bash
git add backend/scripts/fetch_fonts.py backend/tests/test_fetch_fonts.py Makefile CLAUDE.md
git commit -m "chore: make fonts refreshes the bundle from Google Fonts"
```
(Append the attribution lines.)

---

### Task 3: Swap the files

**Files:**
- Modify: `fonts/*.ttf` (10 removed, 10 added), `fonts/LICENSES/*.txt` (5 removed, 5 added)

**Interfaces:**
- Consumes: `make fonts` from Task 2.

- [ ] **Step 1: Remove the outgoing families**

```bash
git rm fonts/Lato-*.ttf fonts/Montserrat-*.ttf fonts/Nunito-*.ttf fonts/Poppins-*.ttf fonts/Raleway-*.ttf \
       fonts/LICENSES/Lato.txt fonts/LICENSES/Montserrat.txt fonts/LICENSES/Nunito.txt \
       fonts/LICENSES/Poppins.txt fonts/LICENSES/Raleway.txt
```

- [ ] **Step 2: Fetch the full bundle**

Run: `make fonts`
Expected: twelve lines, one per family, each naming its `-Regular.ttf` and `-Bold.ttf`; exit 0 (no strays). The seven families that stay are re-downloaded; `git status` should show them unchanged or with byte-identical content (if Google served a newer build of one of them, that is fine: it is the same static instance route the bundle came from; mention it in the PR body).

- [ ] **Step 3: Check the new files**

Run: `ls fonts/*.ttf | wc -l && ls fonts/LICENSES && head -3 fonts/LICENSES/Ubuntu.txt fonts/LICENSES/Manrope.txt`
Expected: 24; twelve licence files; Ubuntu's begins `UBUNTU FONT LICENCE Version 1.0`, Manrope's names the SIL Open Font License.

- [ ] **Step 4: Run the coverage test, now green**

Run: `cd backend && .venv/bin/pytest tests/test_fonts.py tests/test_api.py -v`
Expected: all passed (24 coverage cases, the family-count test, and `test_config_and_fonts` still sees 24 fonts).

- [ ] **Step 5: Commit**

```bash
git add fonts
git commit -m "chore: swap five Greek-less font families for Ubuntu, Manrope, Roboto Condensed, Play, Source Serif 4

Lato, Montserrat, Nunito, Poppins and Raleway have no θ ι υ, so Bayer
names rendered as boxes in exports. The replacements were checked for
Greek, the middle dot and the curly apostrophe."
```
(Append the attribution lines.)

---

### Task 4: Docs

**Files:**
- Modify: `fonts/README.md`
- Modify: `docs/SPEC.md:271-277` (§ 9)

- [ ] **Step 1: Rewrite `fonts/README.md`**

```markdown
# Bundled fonts

Twelve open-licence families, Regular and Bold, used identically by the browser
(`@font-face` from `/fonts/`) and by Pillow on the server. Always reference a font by
**file name** (`Inter-Regular.ttf`), never by family name (CLAUDE.md).

Every family covers Latin, Latin Extended, Greek and Cyrillic: labels carry Bayer letters
(θ1 Ori C), the middle dot between aliases and the odd apostrophe (Mairan's Nebula), and a
font that lacks a glyph makes the export and the preview disagree. `backend/tests/test_fonts.py`
checks every file.

| Family | Files | Licence |
|---|---|---|
| Inter | `Inter-Regular.ttf`, `Inter-Bold.ttf` | OFL (`LICENSES/Inter.txt`) |
| Roboto | `Roboto-*.ttf` | OFL |
| Open Sans | `OpenSans-*.ttf` | OFL |
| Source Sans 3 | `SourceSans3-*.ttf` | OFL |
| Fira Sans | `FiraSans-*.ttf` | OFL |
| IBM Plex Sans | `IBMPlexSans-*.ttf` | OFL |
| JetBrains Mono | `JetBrainsMono-*.ttf` | OFL |
| Ubuntu | `Ubuntu-*.ttf` | Ubuntu Font Licence 1.0 (`LICENSES/Ubuntu.txt`) |
| Manrope | `Manrope-*.ttf` | OFL |
| Roboto Condensed | `RobotoCondensed-*.ttf` | OFL |
| Play | `Play-*.ttf` | OFL |
| Source Serif 4 | `SourceSerif4-*.ttf` | OFL |

The TTFs are the static instances the Google Fonts CSS API serves to a legacy user agent for
the `latin, latin-ext, greek, cyrillic` subsets. `make fonts` refreshes them and the licence
texts; the family list lives in `backend/scripts/fetch_fonts.py`.

Lato, Montserrat, Nunito, Poppins and Raleway were bundled until milestone 3 and dropped
because their Google Fonts builds have no Greek glyphs.
```

- [ ] **Step 2: Update SPEC § 9**

Replace the first paragraph of § 9 (lines 273–277) with:

```markdown
Bundle 12 open-licence families as static TTFs in `fonts/`, checked into the repo with licences:
Inter, Roboto, Open Sans, Source Sans 3, Fira Sans, IBM Plex Sans, JetBrains Mono, Ubuntu, Manrope,
Roboto Condensed, Play, Source Serif 4. Regular + Bold weights; all OFL except Ubuntu (Ubuntu Font
Licence). Every family must cover Greek (Bayer letters), the middle dot and the apostrophe; a test
renders those glyphs in every file. `make fonts` refreshes the bundle from Google Fonts. Frontend loads
them via `@font-face` from `/fonts/`; server loads the same files with `ImageFont.truetype`. The
render-parity tests (milestone 3) measure real label strings in every font.
```

(Lato, Montserrat, Nunito, Poppins and Raleway were dropped on 2026-09-11: no Greek glyphs.)

- [ ] **Step 3: Full check and commit**

Run: `make lint test`
Expected: all green (pytest count grows by 29: 24 + 1 in `test_fonts.py`, 4 in `test_fetch_fonts.py`).

```bash
git add fonts/README.md docs/SPEC.md
git commit -m "docs: font bundle after the milestone-3 swap"
```
(Append the attribution lines.)

---

### Task 5: Image size check and the PR

- [ ] **Step 1: Build the image and check its size**

Run: `make build && sudo docker image ls astrocaption:local --format '{{.Size}}'`
Expected: about the same as before (≈ 280 MB), under 400 MB. (`sudo` if the docker group is not active in this shell.)

- [ ] **Step 2: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "chore: font bundle with Greek coverage (milestone 3, PR 1)" --body-file - <<'EOF'
Milestone 3, PR 1 of 8 (design: docs/superpowers/specs/2026-09-11-editor-v1-design.md § 2).

Lato, Montserrat, Nunito, Poppins and Raleway have no Greek glyphs, so Bayer names (θ1 Ori C)
exported as boxes while the browser preview substituted a system font. They are replaced by
Ubuntu, Manrope, Roboto Condensed, Play and Source Serif 4, all checked for θ ι υ λ μ, the
middle dot and the curly apostrophe.

- `make fonts` (`backend/scripts/fetch_fonts.py`) refreshes the bundle and licence texts from
  Google Fonts; the family list is code.
- `backend/tests/test_fonts.py` renders the required glyphs in every bundled file.
- Ubuntu ships under the Ubuntu Font Licence 1.0; the rest are OFL (README, SPEC § 9).

Docker image: <size> MB.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01TNKdZ87piewzen3n7xzz4e
EOF
gh pr checks --watch
```

Stop here; the owner smoke-tests and merges.
