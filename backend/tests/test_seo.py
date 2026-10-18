"""The SPA shell's server-filled head: title, tags for the public routes, the sitemap and
robots (SPEC § 5.5, § 8; #187)."""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

from fastapi.testclient import TestClient

from app.models import Annotations, ImageRecord, Label, SolveObject, SolveStatus, StyleConfig
from app.seo import MAX_NAMES, Head, gallery_head, image_description, image_head, label_names
from app.spa import ShellTemplate
from tests.conftest import login, make_client, make_settings
from tests.test_gallery import exported_image, published_image, set_published

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
    assert "\n    <title>Sky &amp; Stars</title>\n    <meta name=" in page  # the tags' own indent
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


@contextmanager
def shell_client(tmp_path: Path, fake_solver: Any, **overrides: Any) -> Iterator[TestClient]:
    """A logged-in owner on an app with a built shell stub (the public routes ignore the cookie)."""
    settings = make_settings(tmp_path, static_dir=write_shell(tmp_path), **overrides)
    with make_client(settings, lambda: fake_solver) as client:
        login(client)
        yield client


def app_state(client: TestClient) -> Any:
    return cast(Any, client.app).state


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
        assert f'<link rel="canonical" href="http://testserver/gallery/{image["id"]}" />' in head
        assert re.search(
            r'<meta name="description" content="[^"]*M 42[^"]*uploaded \d{1,2} \w{3} \d{4}\." />',
            head,
        )
        assert (
            f'content="http://testserver/api/gallery/{image["id"]}/files/annotated-preview?v='
            in head
        )
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
        for url in (
            "/gallery?q=orion",
            "/gallery?kind=nebula&since=2026-01-01",
            f"/gallery?before={image['id']}",
        ):
            head = head_of(client.get(url).text)
            assert '<link rel="canonical" href="http://testserver/gallery" />' in head, url
            assert "noindex" not in head


def test_misses_are_the_plain_shell_with_404(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        unpublished = exported_image(client, sample_jpeg)
        published = published_image(client, sample_jpeg)
        gone = published_image(client, sample_jpeg)
        renders = app_state(client).settings_source.current().renders_dir
        (renders / gone["id"] / "annotated_preview.jpg").unlink()
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


def test_a_published_image_without_annotations_still_gets_tags(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        image = published_image(client, sample_jpeg)
        with app_state(client).db.connect() as conn:  # autocommit connection
            conn.execute("DELETE FROM annotations WHERE image_id = ?", (image["id"],))
        head = head_of(client.get(f"/gallery/{image['id']}").text)
        assert re.search(
            r'<meta name="description" content="Annotated astrophoto, uploaded \d{1,2} \w{3} \d{4}\." />',
            head,
        )


def test_sitemap_lists_the_gallery_and_every_published_image_newest_first(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
    with shell_client(tmp_path, fake_solver) as client:
        exported_image(client, sample_jpeg)  # unpublished: absent
        first = published_image(client, sample_jpeg)
        second = published_image(client, sample_jpeg)
        gone = published_image(client, sample_jpeg)
        renders = app_state(client).settings_source.current().renders_dir
        (renders / gone["id"] / "annotated.jpg").unlink()
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
        assert resp.text.startswith(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        )

        set_published(client, second["id"], False)
        assert f"/gallery/{second['id']}" not in client.get("/sitemap.xml").text


def test_sitemap_is_empty_when_the_gallery_is_off(
    tmp_path: Path, sample_jpeg: Path, fake_solver: Any
) -> None:
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
