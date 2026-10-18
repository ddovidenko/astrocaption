"""The built frontend: static files plus the index.html fallback for client routes, with the
head filled in by the server (#187).

The shell is read once at mount time. Every page gets ``<title>{site title}</title>``; the
public gallery routes also get the tags ``seo.head_for`` builds (description, canonical, Open
Graph), inserted before ``</head>``. A shell with no ``</head>`` (the test stub) is served as
it is.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

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
        block = f"<title>{html.escape(title)}</title>\n{tags}"
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
