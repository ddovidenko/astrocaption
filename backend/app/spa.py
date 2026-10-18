"""The built frontend: static files plus the index.html fallback for client routes, with the
head filled in by the server (#187).

``frontend/index.html`` carries two literals Vite copies into the build: the title
placeholder and a ``<!--app-head-->`` marker before ``</head>``. Every page gets
``<title>{site title}</title>``; the three public routes (``/``, ``/gallery``,
``/gallery/{id}``) also get the tags ``seo`` builds at the marker. The shell is read once at
mount; a shell without the two literals (the pytest stub, a hand-edited file) is served as it
is, with a warning.
"""

from __future__ import annotations

import html
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

from . import seo
from .api.deps import DbDep, SettingsDep, base_url

log = logging.getLogger(__name__)

TITLE_PLACEHOLDER = "<title>AstroCaption</title>"
HEAD_MARKER = "<!--app-head-->"


@dataclass(frozen=True)
class ShellTemplate:
    text: str
    indent: str  # the marker's own indent, so the inserted lines line up with the built head

    @classmethod
    def load(cls, static_dir: Path) -> ShellTemplate | None:
        index = static_dir / "index.html"
        if not index.is_file():
            log.info("no built frontend found; only the API is served")
            return None
        text = index.read_text(encoding="utf-8")
        if TITLE_PLACEHOLDER not in text or HEAD_MARKER not in text:
            log.warning(
                "spa shell: index.html lacks %s or %s; pages go out without the site title or "
                "head tags",
                TITLE_PLACEHOLDER,
                HEAD_MARKER,
            )
            return cls(text, "")
        marker = text.index(HEAD_MARKER)
        lead = text[text.rfind("\n", 0, marker) + 1 : marker]
        return cls(text, lead if lead.isspace() or not lead else "")

    def render(self, title: str, tags: str = "") -> str:
        page = self.text.replace(TITLE_PLACEHOLDER, f"<title>{html.escape(title)}</title>", 1)
        if not tags:  # the marker's whole line goes, not just the marker
            return page.replace(f"{self.indent}{HEAD_MARKER}\n", "", 1).replace(HEAD_MARKER, "", 1)
        # Only "\n" ends a head line: splitlines() would also break on U+2028, NEL, \v, \f
        # inside a quoted value.
        lines = tags.rstrip("\n").split("\n")
        return page.replace(HEAD_MARKER, f"\n{self.indent}".join(lines), 1)


def mount(app: FastAPI, static_dir: Path) -> None:
    """Serve the built frontend (if present): the public pages with their head, every other
    client route as the plain shell, and the files under the static root."""
    template = ShellTemplate.load(static_dir)
    if template is None:
        return
    static_root = static_dir.resolve()

    def shell(
        request: Request, settings_title: str, head: Callable[[], seo.Head | None], miss: int
    ) -> HTMLResponse:
        """The shell with ``head()``'s tags, or the plain shell: with ``miss`` when the lookup
        says the visitor may not see the page, with 200 when the lookup itself fails. The
        shell is also the sign-in page, so a database fault must not take it down; the app
        then shows the API's own error, and the traceback is in the log."""
        try:
            found = head()
        except Exception:
            log.exception(
                "spa shell: head tags for %r unavailable; serving the plain shell",
                request.url.path,
            )
            return HTMLResponse(template.render(settings_title))
        if found is None:
            return HTMLResponse(template.render(settings_title), status_code=miss)
        return HTMLResponse(template.render(found.title, found.tags))

    @app.get("/", include_in_schema=False)
    async def root_page(request: Request, settings: SettingsDep, db: DbDep) -> HTMLResponse:
        # Also the sign-in landing and the owner's page: never a 404, even with the gallery off.
        def head() -> seo.Head | None:
            return seo.gallery_head_for(settings, db, base_url(request))

        return shell(request, settings.site_title, head, miss=200)

    @app.get("/gallery", include_in_schema=False)
    async def gallery_page(request: Request, settings: SettingsDep, db: DbDep) -> HTMLResponse:
        def head() -> seo.Head | None:
            return seo.gallery_head_for(settings, db, base_url(request))

        return shell(request, settings.site_title, head, miss=404)

    @app.get("/gallery/{image_id}", include_in_schema=False)
    async def image_page(
        image_id: str, request: Request, settings: SettingsDep, db: DbDep
    ) -> HTMLResponse:
        def head() -> seo.Head | None:
            return seo.image_head_for(settings, db, base_url(request), image_id)

        return shell(request, settings.site_title, head, miss=404)

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, settings: SettingsDep) -> Response:
        if path.startswith("api/"):
            raise HTTPException(404)
        if path:
            candidate = (static_root / path).resolve()
            if candidate.is_file() and candidate.is_relative_to(static_root):
                return FileResponse(candidate)
            if path.startswith("assets/"):
                # A bundle from before a redeploy asking for a hash that is gone: a 404 in both
                # logs beats a blank page from the shell served as JavaScript.
                raise HTTPException(404)
        return HTMLResponse(template.render(settings.site_title))
