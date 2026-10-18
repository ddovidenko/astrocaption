"""The SPA shell's server-filled head: title, tags for the public routes, the sitemap and
robots (SPEC § 5.5, § 8; #187)."""

from __future__ import annotations

from pathlib import Path

from app.models import Annotations, ImageRecord, Label, SolveObject, SolveStatus, StyleConfig
from app.seo import MAX_NAMES, Head, gallery_head, image_description, image_head, label_names
from app.spa import ShellTemplate

BASE = "https://sky.example.test"

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
    head = image_head(BASE, 'A "Sky" & <more>', _rec(title='M<42> & "friends"'), ["<b>"])
    assert head.title == 'M<42> & "friends" · A "Sky" & <more>'  # the template escapes the title
    assert (
        '<meta property="og:title" content="M&lt;42&gt; &amp; &quot;friends&quot;" />' in head.tags
    )
    assert (
        '<meta property="og:site_name" content="A &quot;Sky&quot; &amp; &lt;more&gt;" />'
        in head.tags
    )
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
