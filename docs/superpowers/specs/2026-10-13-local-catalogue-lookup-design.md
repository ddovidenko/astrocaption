# Local catalogue lookup: objects nova does not annotate — design

Issue #17 (Later milestone). Approved in conversation on 2026-10-13: all three source groups
(Sharpless + Barnard, LDN + LBN, PGC galaxies), a fixed diameter cut in the shipped data, and a
one-time additive backfill at startup for images solved before this shipped.

## Goal

A solved field gets labels for the objects an astrophotographer expects to see named, not only
the ones nova happens to annotate. nova returns NGC, IC and bright stars; it never returns a
Sharpless region (Sh2-279 in Orion), a Barnard or Lynds dark nebula, or a PGC galaxy (PGC 68029
next to NGC 7209, #130). OpenNGC carries no Sharpless identifiers either (spike on #17,
2026-09-26), so a cross-id table alone cannot close the gap: the fix is a local catalogue of
positions projected through the WCS every solve already stores.

Non-goals: a "dark nebula" bucket in the Objects tab, a per-image depth setting, user-added
objects (SPEC § 13 "custom object entries" stays a separate item), any change to either renderer.

## Decisions

- **Approach A** of the three considered: local catalogue + stored WCS, at solve time and in a
  startup backfill. Cross-ids only (B) cannot produce Sh2-279; computing on demand without
  storing (C) would ripple through ids, layout and export for no gain.
- **No astropy.** It would add well over 100 MB to a 400 MB image budget. A TAN projection with
  SIP distortion is fifty lines of stdlib math, and the recorded fixtures give an exact oracle.
- **Diameter, not magnitude**, for the galaxy cut: for a photograph apparent size predicts
  visibility better than magnitude. PGC at D25 ≥ 1′ is 22,800 rows (D25 ≥ 0.5′ would be 163,207).
  The cut is a build-time ceiling in the data file, not a config option: per-image noise is
  already handled by the default-enabled rule (SPEC § 5.2 step 5) and the Objects tab's chips
  and search. Going deeper is a rebuild of the file (`make objects-catalog`), like `names.json`.
- **Backfill at startup, additive, before the server accepts requests.** It never contacts nova:
  it reads each image's stored `wcs.fits`. Existing labels, positions, enabled states and
  overrides are untouched; only rows are added. A lookup that would only append names to
  existing objects is not applied (the label text would change while the export's content hash,
  and so the out-of-date signal, stayed put); names arrive together with added rows. An image
  whose lookup raises is logged with its traceback, left unstamped, and the start continues.
- **Image size.** The catalogue data is about 1.5 MB. The 400 MB rule stays.

## Data: `backend/app/catalog/objects.json`

One file beside `names.json`, loaded once at startup. Shape:

```json
{"version": "2026-10-13",
 "objects": [{"names": ["Sh2-279"], "ra": 83.85, "dec": -4.85, "radius_arcmin": 10.0,
              "type": "sharpless"}, ...]}
```

- `version`: the build date. The backfill compares it with each image's stamp.
- `names`: display forms the app already uses: `Sh2-279`, `B 33`, `LDN 1622`, `LBN 974`,
  `PGC 68029`. A row can carry several: LBN's name column gives Sharpless cross-ids, PGC's
  alternate names give NGC, IC, UGC, MCG and Arp. These are what the merge matches on; the
  names table (`names.json`) adds Messier and common names on top at read time, exactly as it
  does for nova's objects today (`enrich_names`).
- `ra`, `dec`: J2000 degrees. VizieR computes J2000 positions for the 1900/1950-epoch lists
  (`_RAJ2000`, `_DEJ2000`), so no precession code.
- `radius_arcmin`: half the diameter; LDN gives an area in square degrees, converted to the
  radius of a disc of that area; LBN gives two diameters, the larger is used. Always > 0.
- `type`: the source, one of `sharpless`, `lbn`, `barnard`, `ldn`, `pgc`. Goes into the object's
  existing free-text `type` field, so no schema change for kinds. The kind follows from the type
  in one map (`KIND_BY_TYPE` in `app/catalog`): the first four are `nebula` (dark nebulae
  included: no fourth bucket), `pgc` is `galaxy`. The names table does not know these objects,
  which is why the kind cannot come from it.

### Sources (CDS VizieR, free with attribution)

| Table | Catalogue | Rows | Position | Size column |
|---|---|---|---|---|
| VII/20 | Sharpless 1959 | 313 | `_RAJ2000`, `_DEJ2000` | `Diam` (arcmin) |
| VII/220A | Barnard 1927 | 349 | `_RA.icrs`, `_DE.icrs` | `Diam` (arcmin) |
| VII/7A | Lynds dark nebulae 1962 | ~1,800 | `_RA.icrs`, `_DE.icrs` | `Area` (deg²) |
| VII/9 | Lynds bright nebulae 1965 | ~1,100 | `_RA.icrs`, `_DE.icrs` | `Diam1`, `Diam2` (arcmin); `Name` holds Sharpless cross-ids |
| VII/237 | PGC 2003 | 22,800 at `logD25 ≥ 1.0` | `RAJ2000`, `DEJ2000` | `logD25` (log of D25 in 0.1′); `ANames` cross-names |

Fetched as TSV from `https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=…&-out.max=unlimited`
with explicit `-out=` columns; the PGC filter is passed as `logD25=>=1.0` so the 983k-row table is
cut server-side.

### Build: `make objects-catalog` → `backend/scripts/build_objects_catalog.py`

Mirrors `build_names_catalog.py`: `--from DIR` reads saved TSVs instead of the network. Steps:
download the five tables, parse, format names, convert sizes, fold an LBN row whose name is a
Sharpless number into that Sharpless row (names merged, larger radius kept), write the file, print
the row count per source. A unit test builds from hand-written sample rows of each table (no
network). A second test on the shipped file: it loads, carries a version, every row has a name,
finite coordinates and a positive radius, and landmarks are present: Sh2-279, B 33, LDN 1622,
PGC 68029 and the NGC 7209 cross-name.

Attribution: `backend/app/catalog/CDS-ATTRIBUTION.md` beside `OPENNGC-LICENSE.md`, naming the five
tables and their papers. The package-data glob already ships every JSON under `catalog/`.

## Projection: `backend/app/wcs.py`

- **Parse** the stored header text (80-character FITS cards). Keys read: `CTYPE1/2` (must be
  `RA---TAN` or `RA---TAN-SIP` and the Dec twin), `CRVAL1/2`, `CRPIX1/2`, `CD1_1`, `CD1_2`, `CD2_1`,
  `CD2_2`, `IMAGEW`, `IMAGEH`, and the SIP polynomials `A_p_q`, `B_p_q` (pixel → sky) and `AP_p_q`,
  `BP_p_q` (sky → pixel) with their `*_ORDER`. Anything else is ignored. A missing required key or
  a non-TAN `CTYPE` raises `WcsError(public, detail)`; SIP keys are optional (no SIP = identity).
- **`sky_to_pixel(ra, dec)`**: gnomonic (TAN) projection about `CRVAL` to standard coordinates,
  the inverse CD matrix to pixel offsets, the `AP`/`BP` polynomials for distortion, then `CRPIX`
  back on. Returns None for a point behind the tangent plane. FITS pixels are one-based and
  centred; the oracle test settles the half-pixel convention against nova's own positions.
- **`pixel_to_sky(x, y)`**: the forward path with `A`/`B`. Used once per image to project the
  frame centre and corners, giving the field centre and angular radius.
- **`plate_scale_deg`**: `sqrt(|det CD|)`, degrees per solve-copy pixel.
- **Membership**: an object is in the field when its centre lands inside the solve copy's bounds,
  the rule nova applies. Candidates are pre-filtered by one dot product per row against the field
  radius (plus the object's own radius) before projecting, so 25,000 rows cost milliseconds.
- **Scale**: the WCS describes the solve copy; pixel positions and radii are multiplied by the
  row's `solve_scale`, as nova's are (`objects_from_nova`). Radius in pixels = `radius_arcmin / 60 /
  plate_scale_deg × solve_scale`.
- **Tests**: OpenNGC's J2000 positions for the NGC/IC objects of both recorded fields (Orion 3.9°,
  Pelican 1°) projected through the stored headers land within 2 px of nova's `pixelx`/`pixely`;
  pixel → sky → pixel round-trips across the frame within 0.01 px; a header without SIP terms
  works; a malformed header raises `WcsError`.

## Merging: `backend/app/objects.py`

- `objects_from_catalog(wcs_text, solve_scale, catalog) -> list[SolveObject]`: the hits, in
  original pixels, same shape as nova's objects (`catalog_names` enriched the same way).
- `merge_objects(nova, hits, *, next_id) -> list[SolveObject]`:
  1. **By name.** A hit sharing any normalised name with an existing object joins it: names
     appended (deduplicated), the existing position and radius stay. NGC 6334 gains `Sh2-8`.
     A group designation (Arp, HCG) names several objects, so it is carried but never joins.
  2. **By position, narrowly.** A hit of the same kind as an existing object, both with known
     (non-zero) radii, whose centre is within half the smaller radius of that object's centre,
     joins it the same way. Dark nebulae (Barnard, LDN) are excepted: nova's nebulae are bright
     ones and a dark cloud inside one is its own object. Nothing else merges: NGC 1980 and ι Ori
     stay two objects.
  3. **Ids.** Existing objects keep their ids (nova's 1..n exactly as today). Remaining hits are
     appended with ids from `next_id`, ordered by descending radius then primary name.
  4. **Cap.** `MAX_LABELS` (5,000) bounds the document; if existing + hits would exceed it, hits
     are dropped smallest first.
- **Kind.** `api/images.py` consults `KIND_BY_TYPE` before the names-table fallback: `sharpless`,
  `lbn`, `barnard`, `ldn` → `nebula`; `pgc` → `galaxy`; `bright`, `hd` → `star` as now; else
  `kind_for(names) or "other"`.
- **Enablement.** Unchanged (`layout.default_enabled`): drawn when radius ≥ 0.4 % of image width.
  Every catalogue row has a radius, so a small galaxy arrives listed but off, a large Barnard
  cloud arrives drawn.
- **Tests**: merge by name, by position, refused across kinds, refused at a distance, id order,
  the cap.

## Solve time and the startup backfill

- **Solve** (`worker._store_result`): after `objects_from_nova`, the stored header goes through
  `objects_from_catalog` and `merge_objects`; then default annotations (first solve) or
  `rematch_annotations` (re-solve) as today. A `WcsError` is logged with the image id and the image
  gets nova's objects alone. The row's `objects_catalog` stamp is written with the catalogue
  version.
- **Stamp**: schema migration 6 adds `images.objects_catalog TEXT` (nullable). Null means
  "computed before the local catalogue existed".
- **Backfill** (`catalog_backfill.run(db, settings)` called from the lifespan after `db.init()` and
  before `worker.start()`, in `asyncio.to_thread`): for every image that is solved, has a stored
  header and whose stamp differs from the shipped version: project, `merge_objects` into the
  stored objects with `next_id` after the current highest id; if anything was added, run
  `rematch_annotations(previous, old_objects, merged, …)`, which carries every existing label and
  autoplaces only the new ones, and store objects + annotations in one transaction. Stamp either
  way. Unsolved images and images without a header are skipped and left unstamped (a later solve
  stamps them). One log line: images visited, changed, objects added. A normal restart finds
  nothing to do.
- **Cost**: tens of milliseconds per image; a few hundred images delay readiness by seconds, once
  per catalogue version. Runs before the server accepts requests so no editor is mid-edit while
  its document is rewritten; that is why it is not a background task.
- **What the owner sees**: the document version moves for images that gained objects, so the
  images page shows their export as out of date and the gallery keeps the old export until
  re-exported. Images that gained nothing show no change.
- **Rebuilding the catalogue** later bumps the version; the next start adds only what is new,
  because the merge by name sees the previous catalogue objects in the stored list.
- **Tests**: an image solved and edited under a null stamp gains objects at startup while every
  existing label keeps position, enabled state and overrides; the stamp is set; a second start
  changes nothing; an image without a header is skipped and unstamped; the document version moves.
  A solve of the Orion fixture lists catalogue objects beside nova's twenty with `Sh2-279` among
  the names; the objects endpoint reports `nebula`/`galaxy` for the new types.

## End to end and documents

- The fake nova still replays the Orion set, so the e2e field gains catalogue objects; the panel
  spec's counts ("20 of 20 objects", the star/NGC/IC tallies) change to the real result. The parity
  pixel diff is unaffected (neither renderer changes). `make screenshots` reruns if a newly drawn
  label lands in a README frame.
- SPEC: § 5.2 step 4 gains the lookup and the merge rules; step 5 notes catalogue radii are always
  known; § 7 data model gains `objects_catalog`; § 8 names the new `type` values and their kinds;
  a new § 5.2 subsection "Local catalogue" describes the data file, its sources, the cut and the
  startup backfill; § 13 "Later" drops this item. INSTALL: the first start after the upgrade takes
  a few seconds per hundred images. ARCHITECTURE: `wcs.py`, `objects.json`, the backfill.
- CLAUDE.md commands: `make objects-catalog`.

## PRs

1. Data + builder + attribution + tests (no behaviour change).
2. `wcs.py` + oracle tests.
3. Merge + worker + API kind map + stamp migration + backfill + SPEC/INSTALL/ARCHITECTURE +
   e2e count updates + screenshots if needed. Closes #17.
