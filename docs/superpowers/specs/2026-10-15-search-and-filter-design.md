# Search and filter on the Images page and the public gallery — design

Issue #189 (Later milestone, batch 13). Approved in conversation on 2026-10-15: everything the
issue lists (search, owner status and published filters, object kind, date range), in two PRs,
with SQLite `LIKE` over the title and the stored object names.

## Goal

The long-term answer to a big library is search, not scrolling (#172). A visitor or the owner
types "andromeda", "M 31", "m31" or "NGC 224" and finds the same photo, whether the text is in
the title (titles are mostly upload filenames, `M37_light_stacked_Siril…`) or in any catalogue
name of any object in the image. Filters narrow the list by what the data already knows: solve
status and visibility for the owner, object kind and upload date for everyone. Results are
URL-addressable (`/gallery?q=veil`) so they can be linked and crawled, in the spirit of #187, and
Show more keeps working inside a result set.

Non-goals: a match count, ranking or relevance (results stay newest first, which the keyset
cursor needs), FTS5 (the issue says only if `LIKE` ever is not enough), searching the editor's
label text, a capture-date filter (the JPG carries no reliable one), server-side rendering.

## Decisions

- **`LIKE` plus an `EXISTS` subquery on `objects`** (approach 1 of three). A denormalised
  `search_text` column (2) would be a second write path across solve, re-solve and the catalogue
  backfill for no gain at this scale (55 images, 558 objects on the dev host; milliseconds at a
  hundred times that). FTS5 (3) tokenises "M27" and "M 27" differently and needs its own
  normalisation anyway, plus trigger or manual sync.
- **Matching rule** is the editor's Objects-tab rule extended to the list: case-insensitive
  substring over the title and over every catalogue name of every object, with spaces removed
  from both sides, so "m27", "M 27" and "ngc6960" all work. `%` and `_` in the user's text are
  escaped so they are literal.
- **Kind is stored**, not computed at list time. `kind_of` needs the names table and nova's
  type per row; a Python post-filter would fight keyset paging. One column, written at insert,
  filled once by a migration, read back by the objects endpoint so the editor's chips and the
  list filter cannot disagree.
- **The URL is the single source of truth** for the filters on both pages, through
  `useSearchParams` as the gallery already does for `before`. Typing updates the URL with
  history replace after a debounce; chips update it at once; any filter change drops `before`.
- **Page shape and cursor rules are unchanged.** `{items, next}`; `before` still means "rows
  inserted before this one", so a cursor from a filtered page continues the same filtered list,
  and a deleted cursor row is still the existing 422.
- **Two PRs.** PR 1: search box, owner status and visibility chips, URL state, Show more
  carrying the filters. PR 2: the kind column and migration, kind chips, date range. PR 1 is
  useful on its own; PR 2 holds the schema work.

## API and storage (PR 1)

Both list endpoints, `GET /api/images` and `GET /api/gallery`, accept beside `limit` and
`before`:

- `q` — free text, trimmed. Empty or absent is no search. Matching per the rule above.
- `status` — owner endpoint only: `solving`, `failed` or `solved`. `solving` covers `pending`
  and every in-flight state, the rows the page polls. Unknown values are a 422 from Pydantic.
- `published` — owner endpoint only: `true` or `false`.

Storage: `_list_images` already takes `where` and `params`. A small `ListFilter` dataclass
(`q`, `status`, `published`, later `kind`, `since`, `until`) is turned into extra conditions by
one function used by both `list_images` and `list_published_images`; the gallery keeps its
`published = 1 AND solve_status = 'solved'` condition and ignores `status` and `published`.
The search condition is

```sql
(instr(fold(title), ?) > 0
 OR EXISTS (SELECT 1 FROM objects o WHERE o.image_id = images.id
            AND instr(fold_names(o.catalog_names), ?) > 0))
```

where `fold` (Unicode case-fold, whitespace removed) and `fold_names` (`fold` of every name in
the JSON cell, newline-separated) are Python functions registered on every connection, and the
parameter is `fold(q)`. `instr`, not `LIKE`: a `%` or `_` in the query is literal, and
`str.casefold` handles a Cyrillic title where SQLite's `LOWER` would not.

Object counts and annotation hashes for the owner page stay library-wide fetches in this PR.
No `count` of matches in the response: nothing displays it and it would be a second query.

## Pages and URL state (PR 1)

- **`ListFilters`**, one shared component: a `type="search"` input with a visible clear
  button, and an optional chip row. The gallery passes no chips in PR 1. The Images page passes
  two groups, status (Solving, Failed, Solved) and visibility (Published, Unpublished). Within
  a group chips are mutually exclusive and pressing the active one clears it, so each group is
  one query parameter. Chips reuse `.chip` with `aria-pressed`, as the Objects tab does.
- **A pure module** (`listQuery.ts`) maps URL params to the API query and back, shared by both
  pages and tested on its own.
- **URL state.** Both pages read `q`, `status`, `published` and `before` from the URL. Typing
  writes the URL with history replace after 250 ms; chips at once; any filter change removes
  `before`. A reload lands on the same results. The existing `?before=` behaviour (start from
  that page) is unchanged.
- **Show more keeps the filters.** `ShowMore` emits the current filter parameters plus
  `before`, so a crawler following the chain stays inside the result set and a visitor who
  opens the link starts from that page of the same search.
- **Images page plumbing.** First load, `refresh` (via `listFirst`), `showMore` and its 422
  fallback all pass the current filter. The busy-row poll by id is untouched. Because filters
  live in the URL, a refresh after a delete re-queries the filtered list; an upload clears the
  search and chips first, since the new card is pending and unpublished and would be out of
  sight under them (decided in review, 2026-10-16). The
  newest-answer-wins sequence guard already covers a slow old query landing after a fast new
  one; the gallery's cancelled flag does the same because the filter is in the effect's deps.
- **Empty states.** "No images yet. Upload a finished JPG to start." stays for an unfiltered
  empty library; "No images match." (owner) and "Nothing matches." (gallery) appear when any
  filter is active, next to the clear button.
- **Placement.** Images page: between the upload panel and the grid. Gallery: above the grid.
  Both rows wrap at phone width.

## Object kind and date range (PR 2)

- **Schema.** Migration 8 adds `objects.kind TEXT NOT NULL DEFAULT 'other'` and then a Python
  step that computes `kind_of` for every existing row from the bundled names table.
  `replace_objects` writes `kind` at insert; `GET /images/{id}/objects` reads it from the column
  instead of recomputing. A names-table update in a later release reaches old rows through the
  catalogue backfill, which already rewrites every image's objects when the catalogue changes.
- **`kind`** on both list endpoints: `galaxy`, `nebula`, `cluster`, `star` or `other`. Matches
  an image with at least one object of that kind (`EXISTS` on `objects.kind`). Independent of
  `q`: "nebula" plus "veil" is an image with a nebula whose title or any object name contains
  veil. The chip group shows all five kinds with the Objects tab's labels; Stars will match
  almost every image and is kept for consistency.
- **`since` and `until`**, each `YYYY-MM-DD`, on the upload date `created_at` in UTC, both ends
  inclusive. The server turns `until` into a strict less-than on the following day so the
  comparison is a plain string compare on the ISO stamp; ordering stays on rowid. A malformed
  date is a 422. UI: two native `type="date"` inputs, From and To, in the same filter row (the
  colour-dialog objection was about `input type=color`; native date inputs are consistent across
  Chrome, Safari and Firefox).
- **The gallery gets both** kind chips and the date range; the owner page gets them beside
  status and visibility.

## Errors

A failed list request shows the page-level error the list already shows, in plain language,
never echoing the query. An invalid parameter in a hand-edited URL is a 422 and the page shows
the error with the clear button, so the visitor recovers without knowing which parameter was
wrong. No server path or exception text, as everywhere.

## Tests

- **pytest.** `test_db.py`: `normalise_query` (case, spaces, wildcard escaping); `q` matching
  a title, a primary name and an alias of the same image; `q` with a cursor continuing the same
  result set; status and published on the owner list; the gallery ignoring both. PR 2: the
  migration (a version 7 database with objects gains correct kinds), `kind` through at least one
  object, the inclusive date range, a bad date giving 422. `test_gallery.py` and `test_api.py`:
  the parameters are accepted and the page shape is unchanged.
- **vitest.** `ListFilters.test.tsx`: chip exclusivity and clear. `listQuery.test.ts`: params
  to query and back. `ImagesPage.test.tsx` and `GalleryPage.test.tsx`: typing updates the URL
  after the debounce; a filter change drops `before`; Show more's link carries the filters; the
  "match" empty state only when a filter is active; a refresh re-queries with the current
  filters.
- **Playwright.** `gallery.spec.ts` gains a search step: after publishing, type part of an
  Orion object name and the card stays; type nonsense and "Nothing matches." appears; reload
  with `q` in the URL and the result is the same. No new fixture.

## Documents

SPEC § 5.5 (one sentence on search and filters, Show more carrying them), § 7 (the `kind`
column, PR 2), § 8 (the parameters on both endpoints). INSTALL: the first start after
upgrading runs a one-off migration over the objects table (PR 2). Issue #189 closes with PR 2.

## PRs

1. `feat: search and owner filters on the Images page and the gallery (#189)` — API `q`,
   `status`, `published`; `ListFilter` and `normalise_query`; `ListFilters`, `listQuery.ts`,
   URL state on both pages; `ShowMore` carrying the filters; tests; SPEC § 5.5 and § 8.
2. `feat: filter the Images page and the gallery by object kind and upload date (#189)` —
   migration 8 and the `kind` column; `kind`, `since`, `until`; kind chips and date inputs;
   tests; SPEC § 7 and § 8; INSTALL. `Closes #189`.

Ritual per PR (CLAUDE.md): `make lint test`, `make e2e`, `/code-review high`, the
silent-failure pass, `/simplify`, the owner's smoke test on `make dev` before commit, and stop
after CI is green for the owner's go before merging.
