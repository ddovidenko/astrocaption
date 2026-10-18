# Public gallery sitemap and head tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A crawler or a link-preview bot that fetches `/gallery` or `/gallery/{id}` gets a title, description, canonical and preview-card image in the HTML, and `/sitemap.xml` lists every published image (#187).

**Architecture:** The backend reads the built `index.html` once into a `ShellTemplate` and the SPA fallback renders it per request with the site title and, for the public routes, a block of head tags from a new `seo` module. Two public routes, `/sitemap.xml` and `/robots.txt`, are served by the backend from the gallery's query. The SPA sets the document title on the image page so in-app navigation matches.

**Tech Stack:** FastAPI, stdlib (`html.escape`, `xml.sax.saxutils`), stdlib sqlite3 via `Database`, React 19 + react-router, pytest, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-17-public-seo-design.md`

## Global Constraints

- No new dependency, Python or npm (CLAUDE.md: ask first; the spec uses stdlib only).
- API responses and pages never carry a server path or exception text; every tag value is HTML-escaped with quotes.
- Public routes are read-only and expose nothing unpublished: a miss is the plain shell with status 404, the same body whether the id is unknown, unpublished or lacks files.
- The base URL is `request.base_url` (scheme and host; the proxy middleware already corrects the scheme under `TRUST_PROXY=1`). No new setting.
- Filtered or paged gallery URLs (any query string) carry a canonical link to the plain gallery and no `noindex`.
- `seo.py` is the one public module allowed to read annotations and objects, for published images only.
- Owner routes keep their 200 and get the shell with only the site title filled.
- Commit messages are conventional (`feat:`, `test:`, `docs:`), each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Stage by path, never `git add -A`.
- Run tests from the repo root: `backend/.venv/bin/pytest backend/tests/<file> -q`, `npx --prefix frontend vitest run --root frontend <file>`.

## Review Focus

1. A title containing `<`, `&` or `"` (the owner's upload filename) must come out escaped in every tag and never break the head; Task 3 pins it.
2. A published image whose annotations row is missing or whose labels point at objects that no longer exist must still get a page with tags (no-label description), not a 500; Task 3 pins both.
3. `/gallery/` with a trailing slash, `/gallery/{id}/` and `/gallery/{id}/extra` are not image pages: they must get the plain shell (200, SPA shows its own route), never a tag block for a partial id; Task 4 pins it.
4. With `TRUST_PROXY=1` and `X-Forwarded-Proto: https`, every absolute URL (canonical, `og:url`, `og:image`, sitemap, robots) must be https; without the flag the header is ignored; Task 4 and Task 5 pin it.
5. A published image whose export files were deleted by hand must be absent from the sitemap and a 404 shell on its page, consistent with `/api/gallery`; Tasks 4 and 5 pin it.

---

## File structure

- `backend/app/spa.py` (new): `ShellTemplate` (load, render) and the mount function moved out of `main.py`, which keeps `create_app` short. Depends on `seo.head_for`.
- `backend/app/seo.py` (new): pure tag building (`gallery_head`, `image_head`, `label_names`, `Head` dataclass) plus `head_for(request, path, settings, db)` which decides route → `(status, title, tags)`. Reads `Database` and `storage.export_exists`.
- `backend/app/api/gallery.py`: gains `GET /sitemap.xml` and `GET /robots.txt` on a second router (`public_router`, no prefix, no gallery-off gate) included from `main.py`.
- `backend/app/db.py`: `Database.published_images()`.
- `backend/app/main.py`: `_mount_spa` removed, `spa.mount(app, cfg.static_dir)` called instead; `gallery.public_router` added to `API_ROUTERS`? No: `API_ROUTERS` is walked by the auth test expecting owner gating, so the public router is included separately, right after the loop.
- `frontend/index.html`: unchanged in content (its `<title>` is what the template replaces).
- `frontend/src/pages/GalleryImagePage.tsx`: `siteTitle` prop and the title effect; `App.tsx` passes `health.site_title`.
- Tests: `backend/tests/test_seo.py` (new), `backend/tests/test_db.py`, `backend/tests/test_api.py` (SPA stub stays), `frontend/src/pages/GalleryPage.test.tsx`, `frontend/e2e/seo.spec.ts` (new).
- Docs: `docs/SPEC.md` § 5.5 and § 8, `docs/INSTALL.md`.

---

### Task 1: `Database.published_images`

**Files:**
- Modify: `backend/app/db.py` (after `list_published_images`, around line 574)
- Test: `backend/tests/test_db.py`

**Interfaces:**
- Consumes: `Database._list_images`, `SolveStatus`, `ImageRecord` (existing).
- Produces: `Database.published_images(self) -> list[ImageRecord]` (published and solved, newest first by rowid, no limit).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_db.py` (it already imports `Database`, `SolveStatus` and has `_plain_image`; check the top of the file for the helper names and reuse them):

```python
def test_published_images_are_the_gallery_rows_newest_first(db: Database) -> None:
    # Three rows: the first published and solved, the second published but solving (not a
    # gallery row), the third unpublished. Insert order is rowid order.
    db.insert_image(_plain_image("first"))
    db.insert_image(_plain_image("second"))
    db.insert_image(_plain_image("third"))
    db.update_image("first", {"published": True, "solve_status": SolveStatus.SOLVED})
    db.update_image("second", {"published": True, "solve_status": SolveStatus.SOLVING})
    db.update_image("third", {"published": False, "solve_status": SolveStatus.SOLVED})
    db.insert_image(_plain_image("fourth"))
    db.update_image("fourth", {"published": True, "solve_status": SolveStatus.SOLVED})
    assert [r.id for r in db.published_images()] == ["fourth", "first"]
```

If `test_db.py` names its fixture or helper differently (`_image`, `make_db`), use those names; the assertion is what matters.

- [ ] **Step 2: Run the test to verify it fails**

Run: `backend/.venv/bin/pytest backend/tests/test_db.py -q -k published_images`
Expected: FAIL with `AttributeError: 'Database' object has no attribute 'published_images'`

- [ ] **Step 3: Implement**

In `backend/app/db.py`, directly after `list_published_images`:

```python
    def published_images(self) -> list[ImageRecord]:
        """Every gallery row, newest first, no page: the sitemap and the head tags (#187)."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM images WHERE published = 1 AND solve_status = ? ORDER BY rowid DESC",
                (SolveStatus.SOLVED.value,),
            ).fetchall()
        return [_row_to_image(r) for r in rows]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `backend/.venv/bin/pytest backend/tests/test_db.py -q`
Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/db.py backend/tests/test_db.py
git commit -m "feat: the database lists the gallery's rows without a page (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `ShellTemplate` and the SPA mount in `spa.py`

**Files:**
- Create: `backend/app/spa.py`
- Modify: `backend/app/main.py` (remove `_mount_spa`, lines ~255–270; call `spa.mount`)
- Test: `backend/tests/test_seo.py` (new), `backend/tests/test_api.py::test_spa_is_served_when_built` (unchanged, must keep passing)

**Interfaces:**
- Consumes: nothing new. (Task 3 adds `seo.head_for`; until then the mount renders every route with the site title only.)
- Produces: `ShellTemplate.load(static_dir: Path) -> ShellTemplate | None` (None when there is no `index.html`); `ShellTemplate.render(self, title: str, tags: str = "") -> str`; `mount(app: FastAPI, static_dir: Path) -> None`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_seo.py`:

```python
"""The SPA shell's server-filled head: title, tags for the public routes, the sitemap and
robots (SPEC § 5.5, § 8; #187)."""

from __future__ import annotations

from pathlib import Path

from app.spa import ShellTemplate

SHELL = (
    "<!doctype html>\n<html>\n  <head>\n    <meta charset=\"UTF-8\" />\n"
    "    <title>AstroCaption</title>\n    <link rel=\"icon\" href=\"/favicon.ico\" />\n"
    "  </head>\n  <body><div id=\"root\"></div></body>\n</html>\n"
)


def write_shell(tmp_path: Path, text: str = SHELL) -> Path:
    static = tmp_path / "static"
    static.mkdir(exist_ok=True)
    (static / "index.html").write_text(text, encoding="utf-8")
    return static


def test_template_replaces_the_title_and_inserts_tags_before_head_end(tmp_path: Path) -> None:
    template = ShellTemplate.load(write_shell(tmp_path))
    assert template is not None
    page = template.render("Sky & Stars", '<meta name="description" content="x" />\n')
    assert "<title>AstroCaption</title>" not in page
    assert "<title>Sky &amp; Stars</title>" in page
    assert page.index('<meta name="description"') < page.index("</head>")
    assert page.index('<link rel="icon"') < page.index('<meta name="description"')
    assert page.endswith("</html>\n")


def test_template_without_a_head_is_served_verbatim(tmp_path: Path) -> None:
    template = ShellTemplate.load(write_shell(tmp_path, "<html>spa</html>"))
    assert template is not None
    assert template.render("Sky", "<meta />") == "<html>spa</html>"


def test_template_is_none_without_a_built_shell(tmp_path: Path) -> None:
    assert ShellTemplate.load(tmp_path / "nope") is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.spa'`

- [ ] **Step 3: Create `backend/app/spa.py`**

```python
"""The built frontend: static files plus the index.html fallback for client routes, with the
head filled in by the server (#187).

The shell is read once at mount time. Every page gets ``<title>{site title}</title>``; the
public gallery routes also get the tags ``seo.head_for`` builds (description, canonical, Open
Graph), inserted before ``</head>``. A shell with no ``</head>`` (the test stub) is served as
it is.
"""

from __future__ import annotations

import html
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

log = logging.getLogger(__name__)

_TITLE = re.compile(r"<title>.*?</title>\s*", re.DOTALL)
_HEAD_END = "</head>"


@dataclass(frozen=True)
class ShellTemplate:
    before: str  # up to the insertion point (the first </head>), the original <title> removed
    after: str  # from </head> on; empty when the shell has no head (then `before` is all of it)
    indent: str  # the whitespace before </head>, so inserted tags line up with the built head

    @classmethod
    def load(cls, static_dir: Path) -> ShellTemplate | None:
        index = static_dir / "index.html"
        if not index.is_file():
            return None
        text = index.read_text(encoding="utf-8")
        cut = text.find(_HEAD_END)
        if cut < 0:
            return cls(text, "", "")
        head = _TITLE.sub("", text[:cut], count=1)
        line_start = head.rfind("\n") + 1
        indent = head[line_start:]
        if indent.strip():  # </head> shares its line with other markup: insert right there
            line_start, indent = len(head), ""
        return cls(head[:line_start], text[cut:], indent)

    def render(self, title: str, tags: str = "") -> str:
        if not self.after:
            return self.before
        block = f"<title>{html.escape(title)}</title>\n"
        if tags:
            block += tags
        indented = "".join(f"{self.indent}{line}\n" for line in block.splitlines())
        return f"{self.before}{indented}{self.indent}{self.after}"


def mount(app: FastAPI, static_dir: Path) -> None:
    """Serve the built frontend (if present) with an index.html fallback for client routes."""
    template = ShellTemplate.load(static_dir)
    if template is None:
        return
    root = static_dir.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, request: Request) -> Response:
        if path.startswith("api/"):
            raise HTTPException(404)
        if path:
            candidate = (root / path).resolve()
            if candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
        settings = request.app.state.settings_source.current()
        return HTMLResponse(template.render(settings.site_title))
```

In `backend/app/main.py`: delete `_mount_spa` and its `FileResponse` import if nothing else uses it (`FileResponse` is still imported for nothing else: check with `grep -n FileResponse backend/app/main.py`, and drop it from the import line when unused); add `from . import spa` beside the other relative imports and replace `_mount_spa(app, cfg.static_dir)` with `spa.mount(app, cfg.static_dir)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py backend/tests/test_api.py -q -k "template or spa"`
Expected: PASS (3 new tests and `test_spa_is_served_when_built`).

Then `make lint-backend`: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app/spa.py backend/app/main.py backend/tests/test_seo.py
git commit -m "refactor: the SPA shell is a template whose title the server fills (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `seo.py`: the tag builders (pure)

**Files:**
- Create: `backend/app/seo.py`
- Test: `backend/tests/test_seo.py`

**Interfaces:**
- Consumes: `ImageRecord`, `Annotations`, `Label`, `SolveObject`, `StyleConfig` (models), `fit_within`, `PREVIEW_MAX_PX` (storage), `render.label_text` (existing, `label_text(obj, label, style) -> LabelText` with `.primary`).
- Produces:
  - `label_names(ann: Annotations | None, objects: list[SolveObject]) -> list[str]`: the enabled labels' text in label order, as the export prints it.
  - `image_description(names: list[str], created_at: str) -> str`
  - `image_head(base: str, site_title: str, rec: ImageRecord, names: list[str]) -> Head`
  - `gallery_head(base: str, site_title: str, count: int, newest: ImageRecord | None) -> Head`
  - `@dataclass(frozen=True) class Head: title: str; tags: str` (tags = the head lines, each ending in `\n`, no title).
  - `MAX_NAMES = 8`, `day_label(iso: str) -> str` ("22 Sep 2026").

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_seo.py`:

```python
from app.models import Annotations, ImageRecord, Label, SolveObject, SolveStatus, StyleConfig
from app.seo import MAX_NAMES, Head, gallery_head, image_description, image_head, label_names

BASE = "https://sky.example.test"


def _rec(**over: object) -> ImageRecord:
    values: dict[str, object] = {
        "id": "img1",
        "created_at": "2026-09-22T10:00:00+00:00",
        "updated_at": "2026-09-22T10:00:00+00:00",
        "title": "Orion Field",
        "original_name": "orion.jpg",
        "original_path": "uploads/img1/original.jpg",
        "preview_path": "uploads/img1/preview.jpg",
        "thumb_path": "uploads/img1/thumb.jpg",
        "width": 6000,
        "height": 4000,
        "solve_status": SolveStatus.SOLVED,
        "published": True,
        "exported_at": "2026-10-01T12:00:00+00:00",
    }
    values.update(over)
    return ImageRecord(**values)  # type: ignore[arg-type]


def _obj(id_: int, *names: str) -> SolveObject:
    return SolveObject(id=id_, catalog_names=list(names), type="ngc", x=1.0, y=1.0)


def _ann(*labels: Label) -> Annotations:
    return Annotations(image_id="img1", style=StyleConfig(), labels=list(labels))


def test_label_names_follow_the_export_text_in_label_order() -> None:
    objects = [_obj(1, "NGC 1976", "M 42", "Orion Nebula"), _obj(2, "NGC 1977"), _obj(3, "IC 434")]
    ann = _ann(
        Label(object_id=3, enabled=True),
        Label(object_id=1, enabled=True),
        Label(object_id=2, enabled=False),
        Label(object_id=9, enabled=True),  # points at an object that no longer exists
    )
    assert label_names(ann, objects) == ["IC 434", "M 42"]


def test_label_names_honour_an_override_and_an_absent_document() -> None:
    objects = [_obj(1, "NGC 1976", "M 42")]
    ann = _ann(Label(object_id=1, enabled=True, text_override="  The Great Nebula "))
    assert label_names(ann, objects) == ["The Great Nebula"]
    assert label_names(None, objects) == []


def test_image_description_caps_the_names() -> None:
    assert image_description([], "2026-09-22T10:00:00Z") == (
        "Annotated astrophoto, uploaded 22 Sep 2026."
    )
    assert image_description(["M 42", "NGC 1977"], "2026-09-22T10:00:00Z") == (
        "M 42 · NGC 1977. Annotated astrophoto, uploaded 22 Sep 2026."
    )
    names = [f"N {i}" for i in range(MAX_NAMES + 3)]
    text = image_description(names, "2026-09-22T10:00:00Z")
    assert text.startswith(" · ".join(names[:MAX_NAMES]) + " and 3 more. ")


def test_image_head_is_pinned() -> None:
    head = image_head(BASE, "Sky", _rec(), ["M 42", "NGC 1977"])
    assert head == Head(
        title="Orion Field · Sky",
        tags=(
            '<meta name="description" content="M 42 · NGC 1977. Annotated astrophoto, uploaded 22 Sep 2026." />\n'
            '<link rel="canonical" href="https://sky.example.test/gallery/img1" />\n'
            '<meta property="og:type" content="article" />\n'
            '<meta property="og:title" content="Orion Field" />\n'
            '<meta property="og:description" content="M 42 · NGC 1977. Annotated astrophoto, uploaded 22 Sep 2026." />\n'
            '<meta property="og:url" content="https://sky.example.test/gallery/img1" />\n'
            '<meta property="og:site_name" content="Sky" />\n'
            '<meta property="og:image" content="https://sky.example.test/api/gallery/img1/files/annotated-preview?v=2026-10-01T12%3A00%3A00%2B00%3A00" />\n'
            '<meta property="og:image:width" content="2048" />\n'
            '<meta property="og:image:height" content="1365" />\n'
            '<meta name="twitter:card" content="summary_large_image" />\n'
        ),
    )


def test_image_head_escapes_the_owner_text() -> None:
    head = image_head(BASE, 'A "Sky" & <more>', _rec(title='M<42> & "friends"'), ['<b>'])
    assert head.title == 'M<42> & "friends" · A "Sky" & <more>'  # the template escapes the title
    assert '<meta property="og:title" content="M&lt;42&gt; &amp; &quot;friends&quot;" />' in head.tags
    assert '<meta property="og:site_name" content="A &quot;Sky&quot; &amp; &lt;more&gt;" />' in head.tags
    assert "&lt;b&gt;. Annotated" in head.tags
    assert "<b>" not in head.tags


def test_gallery_head_counts_and_shows_the_newest() -> None:
    none = gallery_head(BASE, "Sky", 0, None)
    assert none.title == "Sky"
    assert '<meta name="description" content="Annotated astrophotos" />' in none.tags
    assert "og:image" not in none.tags and "twitter:card" not in none.tags
    assert '<link rel="canonical" href="https://sky.example.test/gallery" />' in none.tags
    assert '<meta property="og:type" content="website" />' in none.tags
    one = gallery_head(BASE, "Sky", 1, _rec(width=3000, height=2000))
    assert '<meta name="description" content="1 annotated astrophoto" />' in one.tags
    assert '<meta property="og:image:width" content="2048" />' in one.tags
    assert '<meta property="og:image:height" content="1365" />' in one.tags
    assert '<meta name="twitter:card" content="summary_large_image" />' in one.tags
    many = gallery_head(BASE, "Sky", 12, _rec())
    assert '<meta name="description" content="12 annotated astrophotos" />' in many.tags
```

`_rec` lists every required `ImageRecord` field (models.py ~line 449); the `type: ignore` covers the untyped dict unpacking.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.seo'`

- [ ] **Step 3: Create `backend/app/seo.py`**

```python
"""Head tags for the public routes (#187): what a crawler or a link-preview bot reads before
the SPA runs. Pure builders here; ``head_for`` (below, Task 4) picks the route.

This is the one public module that reads annotations and objects, and only for a published
image: the description names the enabled labels as the export prints them, which the public
export already shows.
"""

from __future__ import annotations

import html
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote

from .models import Annotations, ImageRecord, SolveObject
from .render import label_text
from .storage import PREVIEW_MAX_PX, fit_within

MAX_NAMES = 8
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


@dataclass(frozen=True)
class Head:
    title: str  # unescaped; the shell template escapes it
    tags: str  # head lines, each ending in a newline, every value escaped


def day_label(iso: str) -> str:
    """The upload day as the cards print it (frontend/src/day.ts): UTC, "22 Sep 2026"."""
    d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if d.tzinfo is not None:
        d = d.astimezone(UTC)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def label_names(ann: Annotations | None, objects: list[SolveObject]) -> list[str]:
    """The enabled labels' text in label order, as the export prints it; a label whose
    object is gone is skipped."""
    if ann is None:
        return []
    by_id = {o.id: o for o in objects}
    names: list[str] = []
    for label in ann.labels:
        obj = by_id.get(label.object_id)
        if label.enabled and obj is not None:
            names.append(label_text(obj, label, ann.style).primary)
    return names


def image_description(names: list[str], created_at: str) -> str:
    tail = f"Annotated astrophoto, uploaded {day_label(created_at)}."
    if not names:
        return tail
    shown = " · ".join(names[:MAX_NAMES])
    if len(names) > MAX_NAMES:
        shown += f" and {len(names) - MAX_NAMES} more"
    return f"{shown}. {tail}"


def _meta(attr: str, name: str, value: str) -> str:
    return f'<meta {attr}="{name}" content="{html.escape(value, quote=True)}" />\n'


def _image_tags(base: str, rec: ImageRecord) -> str:
    assert rec.exported_at  # the callers check export_exists first
    w, h = fit_within(rec.width, rec.height, PREVIEW_MAX_PX)
    url = f"{base}/api/gallery/{rec.id}/files/annotated-preview?v={quote(rec.exported_at)}"
    return (
        _meta("property", "og:image", url)
        + _meta("property", "og:image:width", str(w))
        + _meta("property", "og:image:height", str(h))
        + _meta("name", "twitter:card", "summary_large_image")
    )


def _common(base_url: str, kind: str, title: str, description: str, site_title: str) -> str:
    return (
        _meta("name", "description", description)
        + f'<link rel="canonical" href="{html.escape(base_url, quote=True)}" />\n'
        + _meta("property", "og:type", kind)
        + _meta("property", "og:title", title)
        + _meta("property", "og:description", description)
        + _meta("property", "og:url", base_url)
        + _meta("property", "og:site_name", site_title)
    )


def image_head(base: str, site_title: str, rec: ImageRecord, names: list[str]) -> Head:
    url = f"{base}/gallery/{rec.id}"
    description = image_description(names, rec.created_at)
    tags = _common(url, "article", rec.title, description, site_title) + _image_tags(base, rec)
    return Head(title=f"{rec.title} · {site_title}", tags=tags)


def gallery_head(base: str, site_title: str, count: int, newest: ImageRecord | None) -> Head:
    if count == 0:
        description = "Annotated astrophotos"
    elif count == 1:
        description = "1 annotated astrophoto"
    else:
        description = f"{count} annotated astrophotos"
    tags = _common(f"{base}/gallery", "website", site_title, description, site_title)
    if newest is not None:
        tags += _image_tags(base, newest)
    return Head(title=site_title, tags=tags)
```

`day_label` is UTC like `day.ts` (a naive stamp is taken as UTC). `rec.id` and `rec.exported_at` are never user text, but they are escaped by `_meta` anyway; `base` comes from `request.base_url` and is escaped where it lands in an attribute.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py -q`
Expected: PASS. If `test_image_head_is_pinned` differs only in the `v=` encoding, make the test match what `quote` produces for `2026-10-01T12:00:00+00:00` (the gallery item URL uses the same `quote`), not the other way round.

Then `make lint-backend`: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app/seo.py backend/tests/test_seo.py
git commit -m "feat: head tags for a published image and the gallery, built from what the export shows (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `head_for` and the public routes through the shell

**Files:**
- Modify: `backend/app/seo.py` (add `head_for`), `backend/app/spa.py` (call it)
- Test: `backend/tests/test_seo.py`

**Interfaces:**
- Consumes: `ShellTemplate.render(title, tags)`, `gallery_head`, `image_head`, `label_names`, `Database.published_images`, `Database.get_image`, `Database.get_annotations`, `Database.get_objects`, `storage.export_exists`, `Settings.public_gallery_enabled`, `Settings.site_title`.
- Produces: `head_for(request: Request, path: str, settings: Settings, db: Database) -> tuple[int, Head]`: status and head for any client route; `(200, Head(site_title, ""))` for every route that is not public.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_seo.py` (these go through the app with a built shell stub; `published_image` and `exported_image` come from `tests.test_gallery`, `make_client`, `make_settings`, `login` from `tests.conftest`):

```python
import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import login, make_client, make_settings
from tests.test_gallery import exported_image, published_image, set_published


@contextmanager
def shell_client(tmp_path: Path, fake_solver: Any, **overrides: Any) -> Iterator[TestClient]:
    """A logged-in owner on an app with a built shell stub (the public routes ignore the cookie)."""
    settings = make_settings(tmp_path, static_dir=write_shell(tmp_path), **overrides)
    with make_client(settings, lambda: fake_solver) as client:
        login(client)
        yield client


def head_of(text: str) -> str:
    return text[text.index("<head>") : text.index("</head>")]


def test_image_page_carries_its_tags_and_the_gallery_lists_it(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        image = published_image(client, sample_jpeg)
        resp = client.get(f"/gallery/{image['id']}")
        assert resp.status_code == 200
        head = head_of(resp.text)
        assert "<title>Orion Field · Test Site</title>" in head
        assert '<link rel="canonical" href="http://testserver/gallery/' + image["id"] + '" />' in head
        assert re.search(r'<meta name="description" content="[^"]*M 42[^"]*uploaded \d{1,2} \w{3} \d{4}\." />', head)
        assert f'content="http://testserver/api/gallery/{image["id"]}/files/annotated-preview?v=' in head
        assert "<title>AstroCaption</title>" not in head
        assert '<div id="root"></div>' in resp.text

        for path in ("/", "/gallery"):
            resp = client.get(path)
            assert resp.status_code == 200, path
            head = head_of(resp.text)
            assert "<title>Test Site</title>" in head
            assert '<meta name="description" content="1 annotated astrophoto" />' in head
            assert '<link rel="canonical" href="http://testserver/gallery" />' in head
            assert f"/api/gallery/{image['id']}/files/annotated-preview?v=" in head


def test_filtered_and_paged_gallery_urls_point_at_the_plain_gallery(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        image = published_image(client, sample_jpeg)
        for url in ("/gallery?q=orion", "/gallery?kind=nebula&since=2026-01-01", f"/gallery?before={image['id']}"):
            head = head_of(client.get(url).text)
            assert '<link rel="canonical" href="http://testserver/gallery" />' in head, url
            assert "noindex" not in head


def test_misses_are_the_plain_shell_with_404(tmp_path: Path, sample_jpeg: Path, fake_solver: Any) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        unpublished = exported_image(client, sample_jpeg)
        published = published_image(client, sample_jpeg)
        gone = published_image(client, sample_jpeg)
        (client.app.state.settings_source.current().renders_dir / gone["id"] / "annotated_preview.jpg").unlink()
        plain = client.get("/config").text  # an owner route: the shell with the site title only
        assert "<title>Test Site</title>" in plain and "og:" not in plain
        for path in (f"/gallery/{unpublished['id']}", "/gallery/nope", f"/gallery/{gone['id']}"):
            resp = client.get(path)
            assert resp.status_code == 404, path
            assert resp.text == plain, path
        # Not image pages: the shell, 200, no tags (the SPA shows its own route).
        for path in ("/gallery/", f"/gallery/{published['id']}/", f"/gallery/{published['id']}/x"):
            resp = client.get(path)
            assert resp.status_code == 200 and "og:" not in resp.text, path


def test_public_routes_are_404_shells_when_the_gallery_is_off(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver, public_gallery_enabled=False) as client:
        image = published_image(client, sample_jpeg)
        for path in ("/", "/gallery", f"/gallery/{image['id']}"):
            resp = client.get(path)
            assert resp.status_code == 404, path
            assert "<title>Test Site</title>" in resp.text and "og:" not in resp.text


def test_absolute_urls_follow_the_proxy_scheme_only_when_trusted(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    https = {"X-Forwarded-Proto": "https"}
    with shell_client(tmp_path, fake_solver) as client:
        image = published_image(client, sample_jpeg)
        head = head_of(client.get(f"/gallery/{image['id']}", headers=https).text)
        assert 'href="http://testserver/gallery/' in head
    with shell_client(tmp_path / "proxied", fake_solver, trust_proxy=True) as client:
        image = published_image(client, sample_jpeg)
        head = head_of(client.get(f"/gallery/{image['id']}", headers=https).text)
        assert f'href="https://testserver/gallery/{image["id"]}"' in head
        assert 'content="https://testserver/api/gallery/' in head


def test_a_published_image_without_labels_or_annotations_still_gets_tags(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any, caplog: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        image = published_image(client, sample_jpeg)
        db = client.app.state.db
        with db.connect() as conn:  # autocommit connection
            conn.execute("DELETE FROM annotations WHERE image_id = ?", (image["id"],))
        head = head_of(client.get(f"/gallery/{image['id']}").text)
        assert re.search(r'<meta name="description" content="Annotated astrophoto, uploaded \d{1,2} \w{3} \d{4}\." />', head)
```

`tmp_path / "proxied"` for the second client: `make_settings` derives `data_dir` from the path, so two apps in one test need two directories; change `write_shell` (Task 2) to `static.mkdir(parents=True, exist_ok=True)` so the nested one works.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py -q`
Expected: the six new tests FAIL (`og:` absent, status 200 where 404 is expected); the Task 2 and 3 tests still PASS.

- [ ] **Step 3: Implement `head_for` and wire the mount**

Append to `backend/app/seo.py`:

```python
import logging
import re

from fastapi import Request

from .config import Settings
from .db import Database
from .storage import export_exists

log = logging.getLogger(__name__)

_IMAGE_PATH = re.compile(r"^gallery/([^/]+)$")


def _base(request: Request) -> str:
    """Scheme and host as the request names them (the proxy middleware has already applied
    X-Forwarded-Proto under TRUST_PROXY), without the trailing slash."""
    return str(request.base_url).rstrip("/")


def head_for(request: Request, path: str, settings: Settings, db: Database) -> tuple[int, Head]:
    """Status and head for a client route. Only the public gallery routes get tags; every
    other route is the shell with the site title. A miss on a public route is 404 with the
    plain head, the same body whether the id is unknown, unpublished or lacks files."""
    site = settings.site_title
    plain = Head(site, "")
    is_gallery = path in ("", "gallery")
    image_match = _IMAGE_PATH.match(path)
    if not is_gallery and image_match is None:
        return 200, plain
    if not settings.public_gallery_enabled:
        return 404, plain
    base = _base(request)
    if is_gallery:
        rows = db.published_images()
        newest = next((r for r in rows if export_exists(settings, r)), None)
        return 200, gallery_head(base, site, len(rows), newest)
    rec = db.get_image(image_match.group(1))
    if rec is None or not rec.published or not export_exists(settings, rec):
        return 404, plain
    try:
        names = label_names(db.get_annotations(rec.id), db.get_objects(rec.id))
    except Exception:  # a corrupt row must not take the page down; the export still shows
        log.warning("head tags: could not read the labels of image %s", rec.id, exc_info=True)
        names = []
    return 200, image_head(base, site, rec, names)
```

The imports go to the top of the module (ruff's isort insists). The gallery description counts every gallery row (`len(rows)`) while the image shown is the newest whose files exist: one query serves both, and the gallery list skips missing-file rows one by one in the same way.

In `backend/app/spa.py`, replace the last two lines of `spa()` with:

```python
        state = request.app.state
        status, head = seo.head_for(request, path, state.settings_source.current(), state.db)
        return HTMLResponse(template.render(head.title, head.tags), status_code=status)
```

and add `from . import seo` to the imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py backend/tests/test_api.py backend/tests/test_gallery.py backend/tests/test_db.py -q`
Expected: PASS.

Then `make lint-backend`: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app/seo.py backend/app/spa.py backend/tests/test_seo.py
git commit -m "feat: the public gallery routes serve the shell with their head tags, misses with a 404 (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `/sitemap.xml` and `/robots.txt`

**Files:**
- Modify: `backend/app/api/gallery.py` (a second router), `backend/app/main.py` (include it)
- Test: `backend/tests/test_seo.py`

**Interfaces:**
- Consumes: `Database.published_images`, `export_exists`, `seo._base` (make it public: rename to `base_url(request)`, update Task 4's call).
- Produces: `gallery.public_router: APIRouter` with `GET /sitemap.xml` and `GET /robots.txt`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_seo.py`:

```python
def test_sitemap_lists_the_gallery_and_every_published_image_newest_first(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        exported_image(client, sample_jpeg)  # unpublished: absent
        first = published_image(client, sample_jpeg)
        second = published_image(client, sample_jpeg)
        gone = published_image(client, sample_jpeg)
        (client.app.state.settings_source.current().renders_dir / gone["id"] / "annotated.jpg").unlink()
        resp = client.get("/sitemap.xml")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/xml")
        assert resp.headers["cache-control"] == "public, no-cache"
        locs = re.findall(r"<loc>(.*?)</loc>", resp.text)
        assert locs == [
            "http://testserver/gallery",
            f"http://testserver/gallery/{second['id']}",
            f"http://testserver/gallery/{first['id']}",
        ]
        mods = re.findall(r"<lastmod>(.*?)</lastmod>", resp.text)
        assert mods == [second["exported_at"], first["exported_at"]]
        assert resp.text.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')

        set_published(client, second["id"], False)
        assert f"/gallery/{second['id']}" not in client.get("/sitemap.xml").text


def test_sitemap_is_empty_when_the_gallery_is_off(tmp_path: Path, sample_jpeg: Path, fake_solver: Any) -> None:
    with shell_client(tmp_path, fake_solver, public_gallery_enabled=False) as client:
        published_image(client, sample_jpeg)
        resp = client.get("/sitemap.xml")
        assert resp.status_code == 200
        assert "<loc>" not in resp.text and "<urlset" in resp.text


def test_robots_names_the_sitemap_and_keeps_crawlers_out_of_the_owner_routes(
    tmp_path: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver, trust_proxy=True) as client:
        resp = client.get("/robots.txt", headers={"X-Forwarded-Proto": "https"})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/plain")
        assert resp.text == (
            "User-agent: *\nDisallow: /api/\nDisallow: /login\nDisallow: /setup\n"
            "Disallow: /config\nDisallow: /images/\nSitemap: https://testserver/sitemap.xml\n"
        )
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py -q -k "sitemap or robots"`
Expected: FAIL: the SPA fallback answers 200 with HTML (`content-type` text/html), so the content-type assertions fail.

- [ ] **Step 3: Implement**

In `backend/app/api/gallery.py`, after the existing router's routes:

```python
from xml.sax.saxutils import escape as xml_escape

from fastapi import Request
from fastapi.responses import PlainTextResponse, Response

from ..seo import base_url

# Two public files outside /api and outside the gallery-off gate: with the gallery off the
# sitemap is empty rather than a 404, so a crawler that already knows it sees "nothing here"
# instead of an error it will retry (#187).
public_router = APIRouter(include_in_schema=False)

ROBOTS = "User-agent: *\nDisallow: /api/\nDisallow: /login\nDisallow: /setup\nDisallow: /config\nDisallow: /images/\n"


@public_router.get("/sitemap.xml")
async def sitemap(request: Request, settings: SettingsDep, db: DbDep) -> Response:
    base = base_url(request)
    urls: list[str] = []
    if settings.public_gallery_enabled:
        urls.append(f"  <url><loc>{xml_escape(base)}/gallery</loc></url>")
        for rec in db.published_images():
            if not export_exists(settings, rec):
                continue
            assert rec.exported_at  # export_exists checked it
            urls.append(
                f"  <url><loc>{xml_escape(base)}/gallery/{rec.id}</loc>"
                f"<lastmod>{xml_escape(rec.exported_at)}</lastmod></url>"
            )
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + ("\n" if urls else "")
        + "</urlset>\n"
    )
    return Response(body, media_type="application/xml", headers={"Cache-Control": CACHE})


@public_router.get("/robots.txt")
async def robots(request: Request) -> PlainTextResponse:
    return PlainTextResponse(
        f"{ROBOTS}Sitemap: {base_url(request)}/sitemap.xml\n", headers={"Cache-Control": CACHE}
    )
```

Imports go to the top of the module. In `backend/app/seo.py` rename `_base` to `base_url` (public, used here and in `head_for`). In `backend/app/main.py`, after the `for router in API_ROUTERS:` loop and before the fonts mount:

```python
    app.include_router(gallery.public_router)  # /sitemap.xml and /robots.txt, before the SPA fallback
```

It is not added to `API_ROUTERS`: `tests/test_auth_api.py` walks that tuple to prove every non-public route demands a session, and these two are public files, like the shell. Check that test still passes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `backend/.venv/bin/pytest backend/tests/test_seo.py backend/tests/test_auth_api.py -q`
Expected: PASS.

Then `make lint-backend`: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/gallery.py backend/app/seo.py backend/app/main.py backend/tests/test_seo.py
git commit -m "feat: sitemap.xml lists every published image and robots.txt points at it (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The image page sets the document title

**Files:**
- Modify: `frontend/src/pages/GalleryImagePage.tsx`, `frontend/src/App.tsx` (the `/gallery/:id` route, ~line 149)
- Test: `frontend/src/pages/GalleryPage.test.tsx` (the `GalleryImagePage` describe block, ~line 314)

**Interfaces:**
- Consumes: `GalleryItem.title`, `HealthOut.site_title`.
- Produces: `GalleryImagePage({ siteTitle }: { siteTitle: string })`.

- [ ] **Step 1: Write the failing test**

In `frontend/src/pages/GalleryPage.test.tsx`, change `renderAt` in the `GalleryImagePage` block to pass the prop, and add a test:

```tsx
  function renderAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/gallery/:id" element={<GalleryImagePage siteTitle="Sky" />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('names the image in the document title while it is open, as the server-filled shell does', async () => {
    document.title = 'Sky'
    vi.mocked(api.galleryImage).mockResolvedValue(item)
    const { unmount } = renderAt('/gallery/img-1')
    await screen.findByRole('link', { name: /^Download annotated image/ })
    expect(document.title).toBe('Orion · Sky')
    unmount()
    expect(document.title).toBe('Sky')
  })
```

`item.title` is `'Orion'` in `galleryTestItem.ts`; check and use the real value.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx --prefix frontend vitest run --root frontend src/pages/GalleryPage.test.tsx`
Expected: FAIL: `document.title` is `'Sky'` where `'Orion · Sky'` is expected (tsc may also flag the unknown prop; vitest does not type-check, the failure is the assertion).

- [ ] **Step 3: Implement**

In `frontend/src/pages/GalleryImagePage.tsx`:

```tsx
/** One published image at preview size with the same hover swap, plus the download (§ 5.5).
 *  The document title names the image while the page is open, matching the title the server
 *  fills into the shell for a direct load (#187). */
export default function GalleryImagePage({ siteTitle }: { siteTitle: string }) {
  const { id = '' } = useParams()
  const [item, setItem] = useState<GalleryItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!item) return
    document.title = `${item.title} · ${siteTitle}`
    return () => {
      document.title = siteTitle
    }
  }, [item, siteTitle])
```

(the rest of the component unchanged). In `frontend/src/App.tsx`, the `/gallery/:id` route: `<GalleryImagePage siteTitle={health.site_title} />`. `health` is the `HealthOut` the routes already receive (`GalleryPage health={health}` on the line above); if it is typed as nullable at that point, use `health?.site_title ?? 'AstroCaption'` to match the shell's default.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx --prefix frontend vitest run --root frontend src/pages && make lint-frontend`
Expected: PASS, eslint and tsc clean.

Known edge, accepted: `App.tsx` resets the title to the site title whenever `health` is refetched (sign-in, sign-out, a session end). A visitor's health is fetched once before the routes render, so the image title stands for a visitor; the owner's refetches are rare and only revert the tab text.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/GalleryImagePage.tsx frontend/src/App.tsx frontend/src/pages/GalleryPage.test.tsx
git commit -m "feat: the full-size gallery view names the image in the document title (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Playwright: the built shell and the sitemap

**Files:**
- Create: `frontend/e2e/seo.spec.ts`

**Interfaces:**
- Consumes: `ensureSetUpAndSignedIn`, `ensureSolvedImage`, `ensureExported`, `imagesTitled` from `./helpers`; `test`, `expect` from `./fixtures`.

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from './fixtures'
import { ensureExported, ensureSetUpAndSignedIn, ensureSolvedImage, imagesTitled } from './helpers'

// What a crawler or a link-preview bot gets without running the app (#187): the built shell
// carries the title, description and preview-card image of a published image, the sitemap
// lists it, and an unpublished image is a 404 shell. Runs against the built bundle (`make e2e`).
test('the shell carries head tags for a published image and the sitemap lists it', async ({ page }) => {
  await ensureSetUpAndSignedIn(page)
  const card = await ensureSolvedImage(page, 'Orion')
  await ensureExported(card, 'Orion')
  const [image] = await imagesTitled(page.request, 'Orion')
  expect(image).toBeTruthy()

  try {
    await card.getByRole('button', { name: 'Publish' }).click()
    await expect(card.getByRole('button', { name: 'Unpublish' })).toBeVisible()

    const res = await page.request.get(`/gallery/${image!.id}`)
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Orion · ')
    expect(html).toMatch(/<meta name="description" content="[^"]*M 42[^"]*Annotated astrophoto, uploaded \d{1,2} \w{3} \d{4}\." \/>/)
    expect(html).toContain(`<meta property="og:image" content="http://127.0.0.1:${new URL(res.url()).port}/api/gallery/${image!.id}/files/annotated-preview?v=`)
    expect(html).toContain(`<link rel="canonical" href="http://127.0.0.1:${new URL(res.url()).port}/gallery/${image!.id}" />`)

    const gallery = await (await page.request.get('/gallery?q=orion')).text()
    expect(gallery).toMatch(/<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/gallery" \/>/)

    const sitemap = await page.request.get('/sitemap.xml')
    expect(sitemap.headers()['content-type']).toContain('application/xml')
    expect(await sitemap.text()).toContain(`/gallery/${image!.id}</loc>`)
    expect(await (await page.request.get('/robots.txt')).text()).toContain('Sitemap: ')

    // The app still loads on a direct hit: the shell's root div is filled by the SPA.
    await page.goto(`/gallery/${image!.id}`)
    await expect(page).toHaveTitle(/^Orion · /)
    await expect(page.getByRole('link', { name: /^Download annotated image/ })).toBeVisible()
  } finally {
    await page.request.put(`/api/images/${image!.id}/published`, { data: { published: false } })
  }

  const gone = await page.request.get(`/gallery/${image!.id}`)
  expect(gone.status()).toBe(404)
  expect(await gone.text()).not.toContain('og:image')
  expect(await (await page.request.get('/sitemap.xml')).text()).not.toContain(`/gallery/${image!.id}</loc>`)
})
```

`page.request` carries the owner's cookie; the public routes do not care, and the 404 for an unpublished image is the same for the owner. The `og:image` host assertion uses the port the request actually hit so the spec does not hard-code the app port; if `res.url()` is not available on the response, compute the origin from `page.url()` after a `page.goto('/')` instead.

- [ ] **Step 2: Run the spec**

Run: `cd frontend && npm run build && E2E_START_APP=1 npx playwright test e2e/seo.spec.ts --project=chromium; cd ..`
Expected: 1 passed. (If the `make e2e` recipe sets other env, use `make e2e` and read the seo line.)

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/seo.spec.ts
git commit -m "test: a crawler's view of a published image, the sitemap and robots (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Documents

**Files:**
- Modify: `docs/SPEC.md` (§ 5.5 after the "Routes: signed out…" bullet, ~line 224; § 8 "Public besides…" line, ~line 491), `docs/INSTALL.md` (the "What `TRUST_PROXY=1` does" section, ~line 298)

- [ ] **Step 1: SPEC § 5.5**

After the `Routes: signed out, …` bullet add:

```markdown
- Crawlers and link previews (#187): the server fills the shell's head for `/`, `/gallery` and
  `/gallery/{id}` before the app runs: `<title>` (`{title} · {site title}` on an image page),
  a description (the enabled labels' names as the export prints them, at most eight, then the
  upload day), a canonical link, Open Graph tags with the annotated preview as the image, and a
  Twitter card. Any gallery URL with a query string (search, chips, dates, `before`) is canonical
  to the plain `/gallery`, with no `noindex`, so the chain stays followable and the index holds
  one gallery. An unpublished or unknown id, a missing export, and every public route while the
  gallery is off serve the plain shell with status 404. `/sitemap.xml` lists `/gallery` and
  every published image with `lastmod` from its export time (empty with the gallery off);
  `/robots.txt` names it and keeps crawlers out of `/api/` and the owner routes. The app sets the
  same title on the full-size view when a visitor navigates to it in-app.
```

- [ ] **Step 2: SPEC § 8**

Replace the `Public besides …` line with:

```markdown
Public besides `/api/gallery`: `/api/health`, the font files under `/fonts/`, the SPA shell (with the
head filled in on the public routes, § 5.5), `/sitemap.xml` (`application/xml`, `Cache-Control: public,
no-cache`) and `/robots.txt`.
```

- [ ] **Step 3: INSTALL**

At the end of the "What `TRUST_PROXY=1` does" section add one paragraph:

```markdown
The links the app writes for crawlers and link previews (the canonical URL, the preview-card
image, `/sitemap.xml`) use the scheme and host of the request as the proxy passes them on:
`X-Forwarded-Proto` for the scheme (so the flag matters here too: without it a proxied site
advertises `http://` links) and the `Host` header, which the snippets above forward unchanged.
```

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md docs/INSTALL.md
git commit -m "docs: the public gallery's head tags, sitemap and robots (#187)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Whole-suite verification

- [ ] **Step 1:** `make lint test` → clean, pytest and vitest green (note the counts).
- [ ] **Step 2:** `make e2e` → all passed (the seo spec included).
- [ ] **Step 3:** Smoke for the owner: `npm --prefix frontend run build`, `sudo systemctl restart astrocaption-dev`, then `curl -s http://127.0.0.1:8000/gallery/<a published id> | head -30`, `curl -s http://127.0.0.1:8000/sitemap.xml | head`, `curl -s http://127.0.0.1:8000/robots.txt`; and in the browser on :5173 open a gallery image and check the tab title. Report and wait for the owner's verdict before the PR.
