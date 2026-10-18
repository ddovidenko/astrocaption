# Sitemap and head tags for the public gallery — design

Issue #187 (Later milestone, batch 13 follow-on). Approved in conversation on 2026-10-17:
a sitemap, robots.txt, and server-filled head tags on the public routes, in one PR. The
description under a shared image names the labels printed on the export (option 1).

## Goal

Published work should be findable by a search engine and shareable with a proper preview card
without the SPA running. Today a crawler or a link-preview bot (Discord, Mastodon, iMessage,
Slack) receives the empty shell: a title of "AstroCaption", no description, no image. Google
runs JavaScript for some pages, slowly; the others never do. Two pieces: a sitemap that makes
discovery independent of the "Show more" chain, and head tags filled in by the server before
the SPA takes over on `/gallery` and `/gallery/{id}`.

Non-goals: server-rendering the two public pages in full (the issue's named follow-on), a
configurable description, structured data (JSON-LD), an image sitemap, `rel=prev/next`.

## Decisions

- **Template the built shell in the backend** (approach 1 of three). The backend reads the built
  `index.html` once at mount time and the SPA fallback inserts a block of tags before `</head>`
  for the public routes; every other route gets the shell with only the site title filled.
  Pre-rendering head files at export or publish time (2) goes stale on a title edit, an
  unpublish or the gallery toggle, and is a second write path. Full server rendering (3) is the
  follow-on.
- **The base URL is the request's.** Scheme and host come from `request.url`, which the proxy
  middleware already corrects from `X-Forwarded-Proto` under `TRUST_PROXY=1`; the host is the
  one the proxy passes through: Caddy by default, nginx only with `proxy_set_header Host $host`,
  which the INSTALL snippet gains in this PR (found in review, 2026-10-17). No new setting. A forged
  `Host` header can only change the URLs in the forger's own response.
- **The description names what the export shows.** The enabled labels' text, in label order, as
  the renderer prints it (`text_override` or the primary name under the style's name
  preference). Nothing becomes visible that the public export does not already print. The
  names come from the current annotations, so after an edit without a re-export the description
  can lead the export by a label or two; that is accepted.
- **Filtered and paged gallery URLs are not canonical.** Any `/gallery` URL with a query string
  (`q`, `kind`, `since`, `until`, `before`) carries `<link rel="canonical" href="…/gallery">`
  and no `noindex`, so the cursor chain stays followable and the index never fills with every
  kind, date and cursor combination. The sitemap lists the plain gallery and the image pages
  only. (A `noindex` beside a canonical to another page is a conflicting signal; canonical alone
  is the documented way to fold variants into one URL.)
- **The signed-out root is the gallery**, so `/` carries the gallery's tags with the canonical
  pointing at `/gallery`. The owner's Images page on the same URL is behind a session a crawler
  never has.
- **A miss is a 404 shell.** An unknown or unpublished id, an id whose export files are missing,
  and `/gallery` and `/gallery/{id}` while the gallery is off serve the plain shell with status
  404: the app still loads and shows its own message, and an engine drops the URL. `/` stays 200
  with the gallery off (it is also the sign-in landing and the owner's page; an uptime monitor
  must not read "gallery off" as "site down"; decided in review, 2026-10-17). Owner routes and
  files are untouched and keep their 200.

## Routes and the shell

`_mount_spa` (main.py) becomes a small module, `app/spa.py`:

- `ShellTemplate.load(static_dir)` reads `index.html` once, removes the first
  `<title>…</title>` and splits at the first `</head>`. `render(title, extra_tags)` returns the
  page with `<title>{title}</title>` and the tags inserted before `</head>`. A shell without a
  `</head>` is served verbatim (the pytest stub `<html>spa</html>` stays valid).
- The fallback route serves files under the static root as today. For a client route it asks
  `seo.head_for(request, path, settings, db)` for `(status, title, tags)`; the default is
  `(200, site_title, "")`. Only `/`, `/gallery` and `/gallery/{id}` produce tags.
- Two new public routes on the gallery router's module, outside the `/api` prefix and outside
  the router's gallery-off gate: `GET /sitemap.xml` and `GET /robots.txt`. They are registered
  before the SPA fallback so the catch-all never shadows them.

`seo.py` holds the tag logic and is the one public module that reads annotations and objects,
for published images only (the gallery router's docstring is amended to say so).

## Tags

Every page from the template carries `<title>{site title}</title>`. The public routes add, in
this order:

| tag | gallery (`/`, `/gallery`) | image (`/gallery/{id}`) |
| --- | --- | --- |
| `<title>` | site title | `{image title} · {site title}` |
| `meta description`, `og:description` | `{N} annotated astrophotos` (`1 annotated astrophoto`; `Annotated astrophotos` when none) | `{names}. Annotated astrophoto, uploaded {day}.` |
| `link canonical`, `og:url` | `{base}/gallery` | `{base}/gallery/{id}` |
| `og:type` | `website` | `article` |
| `og:title` | site title | image title |
| `og:site_name` | site title | site title |
| `og:image`, `og:image:width`, `og:image:height` | the newest published image's annotated preview, when there is one | the image's annotated preview |
| `twitter:card` | `summary_large_image` when there is an image | `summary_large_image` |

- `{names}` is the enabled labels' text joined with ` · `, capped at eight followed by
  `and {N} more`; an image with no enabled label gets `Annotated astrophoto, uploaded {day}.`
- `{day}` is the upload day as the cards print it: `22 Sep 2026` (UTC).
- `og:image` is absolute: `{base}/api/gallery/{id}/files/annotated-preview?v={exported_at}`.
  Its size is `fit_within(width, height, PREVIEW_MAX_PX)`, the preview's real pixels.
- Every value is HTML-escaped (`html.escape`, quotes included). Nothing carries a path or
  exception text; a title is the owner's text and is escaped like any other.
- Tag order and names are pinned by one pytest that compares the rendered head block for a
  known image against an expected string, so a drift is a visible diff.

## Sitemap and robots

- `GET /sitemap.xml`: `application/xml`, `Cache-Control: public, no-cache` (revalidate every
  use, as the gallery files). Lists `{base}/gallery` with no `lastmod`, then every published,
  currently solved image whose export files exist, newest first, as `{base}/gallery/{id}` with
  `lastmod` = `exported_at`. One query (`Database.published_images()`: the gallery's two
  conditions, `ORDER BY rowid DESC`, no limit); the export check is the existing
  `export_exists`. With the gallery off: an empty `<urlset>`, status 200.
- `GET /robots.txt`: `text/plain`, same cache header:

  ```
  User-agent: *
  Allow: /api/gallery/
  Allow: /api/health
  Disallow: /api/
  Disallow: /login
  Disallow: /setup
  Disallow: /config
  Disallow: /images/
  Sitemap: {base}/sitemap.xml
  ```

  The two Allow lines let a bot that obeys robots.txt (Twitterbot, LinkedIn, Google's renderer)
  fetch the preview-card image and the page's own data; the longest matching rule wins (found in
  review, 2026-10-17). The disallowed routes are owner routes that would only index as empty
  shells.

## Frontend

- `GalleryImagePage` sets `document.title` to `{title} · {site title}` once the item loads and
  restores the site title on unmount, so in-app navigation matches the server-rendered title.
  The site title comes from `health` as today (App.tsx sets the default).
- `frontend/index.html` is unchanged except that its `<title>` is now a placeholder the server
  replaces; Vite's dev server still shows "AstroCaption" because it serves the file itself.

Under `make dev` Vite serves the shell, so the tags are visible only from the backend's own
port after a frontend build: `npm --prefix frontend run build`, restart the unit, then
`curl http://127.0.0.1:8000/gallery/<id>`. The e2e suite runs against the built bundle and
covers the same path.

## Errors

- A miss is the 404 shell (above). The response body is the same shell a 200 gets, minus the
  tags: nothing leaks whether the id exists, is unpublished or lacks files.
- Annotations or objects that cannot be read for a published image (a corrupt row) log a
  warning and fall back to the no-label description; the page is still served with its tags.
- The sitemap and robots routes have no failure mode beyond the database being unreadable,
  which is the existing 500 path.

## Tests

- **pytest** (`tests/test_seo.py`): the image page's head block for a published image equals the
  expected string (title, description with names, canonical, `og:*`, size); the eighth-name cap;
  an image with no enabled label; a label with `text_override`; HTML escaping of a title with
  `<&"`; the gallery page's count and newest image; `/` as the gallery; the canonical on
  `/gallery?q=…` and `/gallery?before=…`; 404 shell for unpublished, unknown and missing-export
  ids and for every public route with the gallery off; owner routes untouched (200, site title
  only); the base URL follows `X-Forwarded-Proto` under `TRUST_PROXY`; sitemap contents, order,
  `lastmod`, a published image with missing files skipped, empty with the gallery off; robots
  body. `test_api.py`'s SPA test keeps passing with its headless stub.
- **vitest**: `GalleryImagePage` sets and restores the document title.
- **Playwright** (`e2e/seo.spec.ts`, built bundle): after publishing the Orion fixture, fetch
  `/gallery/{id}` with `page.request` and assert the title and `og:image` in the HTML; fetch
  `/sitemap.xml` and assert the image URL is listed; unpublish and assert the page is a 404 and
  the sitemap no longer lists it.

## Documents

SPEC § 5.5 (one paragraph: head tags, canonical rule, 404 shell, sitemap and robots), § 8 (the
two routes under "Public besides `/api/gallery`"). INSTALL: one note that preview cards and the
sitemap use the hostname the proxy passes through, which the documented snippet already does.
Issue #187 closes with the PR.

## PR

`feat: sitemap, robots and server-filled head tags for the public gallery (#187)` — `spa.py`,
`seo.py`, the two routes, `Database.published_images`, the frontend title effect, tests, SPEC,
INSTALL. `Closes #187`.

Ritual (CLAUDE.md): `make lint test`, `make e2e`, `/code-review high`, the silent-failure pass,
`/simplify`, the owner's smoke on `make dev` (plus the built-bundle curl above) before commit,
and stop after CI is green for the owner's go before merging.
