# nova.astrometry.net fixtures: narrow field

A second recording, made on 2026-09-08 with
`make record-fixtures IMAGE=… OUT=backend/tests/fixtures/nova-narrow` from the owner's Pelican
Nebula (IC 5070) field: 2160 × 2880 px original, sent to nova unscaled (scale 1.0), solved
radius 1.00°, 1.99″/px. Same file set and scrubbing as `../nova/` (see its README); the two
hand-written error fixtures live only there.

Recorded because the 3.9° Orion set has no `hd` entries. nova adds HD stars only to small
fields: of the owner's solved images, fields with a radius of 1.22° and 1.46° had none, and
this 1.00° field and a 0.61° one had five and six. `annotations.json` holds 8 entries:

| type | entries |
|---|---|
| `ic` | IC 5070 (radius 903 px; aliases LBN 350 and Pelican Nebula come from `names.json`) |
| `bright` | 56 Cyg, 57 Cyg |
| `hd` | HD 198639, HD 198896, HD 198931, HD 199081, HD 199178 (radius 0) |

What it taught us: nova lists a bright star twice, as a `bright` entry and as an `hd` entry
at the same pixel (56 Cyg = HD 198639, 57 Cyg = HD 199081). Entries are never merged; the
default-enable rule hides the `hd` twin and keeps the named star.
