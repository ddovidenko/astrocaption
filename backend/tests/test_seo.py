"""The SPA shell's server-filled head: title, tags for the public routes, the sitemap and
robots (SPEC § 5.5, § 8; #187)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import REPO_ROOT, Settings
from app.db import Database
from app.models import Annotations, ImageRecord, Label, SolveObject, SolveStatus, StyleConfig
from app.seo import MAX_NAMES, Head, gallery_head, image_description, image_head, label_names
from app.spa import HEAD_MARKER, TITLE_PLACEHOLDER, ShellTemplate
from tests.conftest import login, make_client, make_settings
from tests.test_gallery import exported_image, published_image, set_published

BASE = "https://sky.example.test"

SHELL = (
    "<!doctype html>\n<html>\n  <head>\n"
    '    <meta charset="UTF-8" />\n'
    f"    {TITLE_PLACEHOLDER}\n"
    '    <link rel="icon" href="/favicon.ico" />\n'
    f"    {HEAD_MARKER}\n"
    '  </head>\n  <body><div id="root"></div></body>\n</html>\n'
)


def messages(caplog: pytest.LogCaptureFixture, logger: str) -> list[str]:
    """What one logger said during the test (the app's own start-up lines are not it)."""
    return [r.message for r in caplog.records if r.name == logger]


def write_shell(tmp_path: Path, text: str = SHELL) -> Path:
    static = tmp_path / "static"
    static.mkdir(parents=True, exist_ok=True)
    (static / "index.html").write_text(text, encoding="utf-8")
    return static


# --- the template ---------------------------------------------------------------------------


def test_template_fills_the_title_and_the_marker_at_the_marker_indent(tmp_path: Path) -> None:
    template = ShellTemplate.load(write_shell(tmp_path))
    assert template is not None
    page = template.render(
        "Sky & Stars", '<meta name="description" content="x" />\n<meta name="b" />\n'
    )
    assert TITLE_PLACEHOLDER not in page and HEAD_MARKER not in page
    assert "<title>Sky &amp; Stars</title>" in page
    assert '\n    <meta name="description" content="x" />\n    <meta name="b" />\n  </head>' in page
    # No tags: the marker's line goes, not just the marker.
    assert "\n    <title>Sky</title>\n" in template.render("Sky")
    assert '<link rel="icon" href="/favicon.ico" />\n  </head>' in template.render("Sky")


def test_the_built_shell_carries_the_placeholder_and_the_marker() -> None:
    # frontend/index.html and spa.py agree on two literals; Vite copies them into the build.
    template = ShellTemplate.load(REPO_ROOT / "frontend")
    assert template is not None
    page = template.render("Sky", '<meta name="x" />\n')
    assert "<title>Sky</title>" in page and '<meta name="x" />' in page
    assert TITLE_PLACEHOLDER not in page and HEAD_MARKER not in page


def test_template_without_the_markers_is_served_verbatim_with_a_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # A hand-edited or misbuilt shell must not fail the start, but the owner has to be told
    # that pages go out without the site title or any tag.
    with caplog.at_level(logging.WARNING, logger="app.spa"):
        template = ShellTemplate.load(write_shell(tmp_path, "<html>spa</html>"))
    assert template is not None
    assert template.render("Sky", "<meta />") == "<html>spa</html>"
    assert messages(caplog, "app.spa") == [
        (
            f"spa shell: index.html lacks {TITLE_PLACEHOLDER} or {HEAD_MARKER}; pages go out "
            "without the site title or head tags"
        )
    ]


def test_template_is_none_without_a_built_shell(tmp_path: Path) -> None:
    assert ShellTemplate.load(tmp_path / "nope") is None


# --- the tag builders -----------------------------------------------------------------------

_REC = ImageRecord(
    id="img1",
    created_at="2026-09-22T10:00:00+00:00",
    updated_at="2026-09-22T10:00:00+00:00",
    title="Orion Field",
    original_name="orion.jpg",
    original_path="uploads/img1/original.jpg",
    preview_path="uploads/img1/preview.jpg",
    thumb_path="uploads/img1/thumb.jpg",
    width=6000,
    height=4000,
    solve_status=SolveStatus.SOLVED,
    published=True,
    exported_at="2026-10-01T12:00:00+00:00",
)


def _rec(**over: object) -> ImageRecord:
    return _REC.model_copy(update=over)


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
    one = gallery_head(BASE, "Sky", 1, _rec())
    assert '<meta name="description" content="1 annotated astrophoto" />' in one.tags
    assert "og:image" in one.tags  # the image tags' shape is pinned by test_image_head_is_pinned
    many = gallery_head(BASE, "Sky", 12, _rec())
    assert '<meta name="description" content="12 annotated astrophotos" />' in many.tags


# --- the routes -----------------------------------------------------------------------------


@contextmanager
def shell_client(
    tmp_path: Path, fake_solver: Any, **overrides: Any
) -> Iterator[tuple[TestClient, Settings]]:
    """A logged-in owner on an app with a built shell stub (the public routes ignore the cookie)."""
    settings = make_settings(tmp_path, static_dir=write_shell(tmp_path), **overrides)
    with make_client(settings, lambda: fake_solver) as client:
        login(client)
        yield client, settings


def head_of(text: str) -> str:
    return text[text.index("<head>") : text.index("</head>")]


def assert_plain_shell(resp: Any, status: int) -> None:
    assert resp.status_code == status, resp.request.url
    assert "<title>Test Site</title>" in resp.text and "og:" not in resp.text, resp.request.url


def test_image_page_carries_its_tags_and_the_gallery_lists_it(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as (client, _):
        image = published_image(client, sample_jpeg)
        resp = client.get(f"/gallery/{image['id']}")
        assert resp.status_code == 200
        head = head_of(resp.text)
        assert "<title>Orion Field · Test Site</title>" in head
        assert f'<link rel="canonical" href="http://testserver/gallery/{image["id"]}" />' in head
        assert '<meta name="description" content="' in head and "M 42" in head
        assert (
            f'content="http://testserver/api/gallery/{image["id"]}/files/annotated-preview?v='
            in head
        )
        assert TITLE_PLACEHOLDER not in head and HEAD_MARKER not in head
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
    with shell_client(tmp_path, fake_solver) as (client, _):
        image = published_image(client, sample_jpeg)
        for url in (
            "/gallery?q=orion",
            "/gallery?kind=nebula&since=2026-01-01",
            f"/gallery?before={image['id']}",
        ):
            head = head_of(client.get(url).text)
            assert '<link rel="canonical" href="http://testserver/gallery" />' in head, url
            assert "noindex" not in head


def test_misses_are_the_plain_shell_with_404(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any, caplog: pytest.LogCaptureFixture
) -> None:
    with shell_client(tmp_path, fake_solver) as (client, settings):
        unpublished = exported_image(client, sample_jpeg)
        published = published_image(client, sample_jpeg)
        gone = published_image(client, sample_jpeg)
        (settings.renders_dir / gone["id"] / "annotated_preview.jpg").unlink()
        plain = client.get("/config").text  # an owner route: the shell with the site title only
        assert "<title>Test Site</title>" in plain and "og:" not in plain
        for path in (f"/gallery/{unpublished['id']}", "/gallery/nope", f"/gallery/{gone['id']}"):
            resp = client.get(path)
            assert resp.status_code == 404, path
            assert resp.text == plain, path
        # Not image pages: the shell, 200, no tags (the SPA shows its own route).
        for path in ("/gallery/", f"/gallery/{published['id']}/", f"/gallery/{published['id']}/x"):
            assert_plain_shell(client.get(path), 200)
        # The gallery's card image skips the row without files and says so, as the list does;
        # the count is the gallery's row count (a hand-emptied render dir is the owner's to fix).
        with caplog.at_level(logging.WARNING, logger="app.seo"):
            gallery = head_of(client.get("/gallery").text)
        assert '<meta name="description" content="2 annotated astrophotos" />' in gallery
        assert f"/api/gallery/{published['id']}/files/annotated-preview?v=" in gallery
        assert messages(caplog, "app.seo") == [
            f"head tags: skipping published image {gone['id']}: its export files are missing"
        ]


def test_gallery_routes_are_404_shells_when_the_gallery_is_off(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver, public_gallery_enabled=False) as (client, _):
        image = published_image(client, sample_jpeg)
        for path in ("/gallery", f"/gallery/{image['id']}"):
            assert_plain_shell(client.get(path), 404)
        # The root is also the sign-in landing and the owner's own page: an uptime monitor
        # pointed at it must not read "gallery off" as "site down".
        assert_plain_shell(client.get("/"), 200)


def test_absolute_urls_follow_the_proxy_scheme_only_when_trusted(
    tmp_path: Path, fake_solver: Any
) -> None:
    https = {"X-Forwarded-Proto": "https"}
    with shell_client(tmp_path, fake_solver) as (client, _):
        head = head_of(client.get("/gallery", headers=https).text)
        assert '<link rel="canonical" href="http://testserver/gallery" />' in head
    with shell_client(tmp_path / "proxied", fake_solver, trust_proxy=True) as (client, _):
        head = head_of(client.get("/gallery", headers=https).text)
        assert '<link rel="canonical" href="https://testserver/gallery" />' in head


def test_a_corrupt_objects_row_degrades_to_a_nameless_description(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any, caplog: pytest.LogCaptureFixture
) -> None:
    with shell_client(tmp_path, fake_solver) as (client, settings):
        image = published_image(client, sample_jpeg)
        with Database(settings.db_path).connect() as conn:  # autocommit connection
            conn.execute(
                "UPDATE objects SET catalog_names = 'not json' WHERE image_id = ?", (image["id"],)
            )
        with caplog.at_level(logging.ERROR, logger="app.seo"):
            resp = client.get(f"/gallery/{image['id']}")
        assert resp.status_code == 200
        head = head_of(resp.text)
        assert '<meta name="description" content="Annotated astrophoto, uploaded ' in head
        assert "og:image" in head
        assert messages(caplog, "app.seo") == [
            (
                f"head tags: image {image['id']} has an unreadable objects row; its description "
                "names no labels until the row is repaired"
            )
        ]


def test_the_shell_is_served_when_the_database_cannot_be_read(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any, caplog: pytest.LogCaptureFixture
) -> None:
    # Before #187 the shell never touched the database; the root is the sign-in page too, so a
    # database fault must still serve it (the app then shows the API's own error).
    with shell_client(tmp_path, fake_solver) as (client, settings):
        published_image(client, sample_jpeg)
        with Database(settings.db_path).connect() as conn:  # autocommit connection
            conn.execute("ALTER TABLE images RENAME TO images_gone")
        with caplog.at_level(logging.ERROR, logger="app.spa"):
            resp = client.get("/")
        assert_plain_shell(resp, 200)
        assert messages(caplog, "app.spa") == [
            "spa shell: head tags for '/' unavailable; serving the plain shell"
        ]
        (record,) = [r for r in caplog.records if r.name == "app.spa"]
        assert record.exc_info is not None  # the traceback goes to the log


def test_a_missing_hashed_asset_is_a_404_not_the_shell(tmp_path: Path, fake_solver: Any) -> None:
    # After a redeploy an old bundle asks for a hash that no longer exists; answering with the
    # HTML shell gives a blank page and a 200 in the log.
    with shell_client(tmp_path, fake_solver) as (client, _):
        assert client.get("/assets/index-OLDHASH.js").status_code == 404


# --- sitemap and robots ---------------------------------------------------------------------


def test_sitemap_lists_the_gallery_and_every_published_image_newest_first(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any, caplog: pytest.LogCaptureFixture
) -> None:
    with shell_client(tmp_path, fake_solver) as (client, settings):
        exported_image(client, sample_jpeg)  # unpublished: absent
        first = published_image(client, sample_jpeg)
        second = published_image(client, sample_jpeg)
        gone = published_image(client, sample_jpeg)
        (settings.renders_dir / gone["id"] / "annotated.jpg").unlink()
        with caplog.at_level(logging.WARNING, logger="app.api.gallery"):
            resp = client.get("/sitemap.xml")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/xml")
        assert resp.headers["cache-control"] == "public, no-cache"
        assert resp.text == (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            "  <url><loc>http://testserver/gallery</loc></url>\n"
            f"  <url><loc>http://testserver/gallery/{second['id']}</loc>"
            f"<lastmod>{second['exported_at']}</lastmod></url>\n"
            f"  <url><loc>http://testserver/gallery/{first['id']}</loc>"
            f"<lastmod>{first['exported_at']}</lastmod></url>\n"
            "</urlset>\n"
        )
        assert messages(caplog, "app.api.gallery") == [
            f"sitemap: skipping published image {gone['id']}: its export files are missing"
        ]

        set_published(client, second["id"], False)
        assert f"/gallery/{second['id']}" not in client.get("/sitemap.xml").text


def test_sitemap_is_empty_when_the_gallery_is_off(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver, public_gallery_enabled=False) as (client, _):
        published_image(client, sample_jpeg)
        resp = client.get("/sitemap.xml")
        assert resp.status_code == 200
        assert "<loc>" not in resp.text and "<urlset" in resp.text


def test_robots_names_the_sitemap_and_keeps_crawlers_out_of_the_owner_routes(
    tmp_path: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver, trust_proxy=True) as (client, _):
        resp = client.get("/robots.txt", headers={"X-Forwarded-Proto": "https"})
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/plain")
        assert resp.text == (  # pinned; the rationale for each line sits beside ROBOTS
            "User-agent: *\nAllow: /api/gallery/\nAllow: /api/health\nDisallow: /api/\n"
            "Disallow: /login\nDisallow: /setup\nDisallow: /config\nDisallow: /images/\n"
            "Sitemap: https://testserver/sitemap.xml\n"
        )
