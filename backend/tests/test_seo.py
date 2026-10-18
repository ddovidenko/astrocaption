"""The SPA shell's server-filled head: title, tags for the public routes, the sitemap and
robots (SPEC § 5.5, § 8; #187)."""

from __future__ import annotations

from pathlib import Path

from app.spa import ShellTemplate

SHELL = (
    '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n'
    '    <title>AstroCaption</title>\n    <link rel="icon" href="/favicon.ico" />\n'
    '  </head>\n  <body><div id="root"></div></body>\n</html>\n'
)


def write_shell(tmp_path: Path, text: str = SHELL) -> Path:
    static = tmp_path / "static"
    static.mkdir(parents=True, exist_ok=True)
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
