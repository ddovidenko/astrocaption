# nova.astrometry.net fixtures

Replayed by `tests/test_nova.py` through an `httpx.MockTransport`; tests never contact
nova (CLAUDE.md hard rule).

Recorded on 2026-09-08 with `python scripts/record_nova_fixtures.py <image>` from a real
solve of the owner's Orion Nebula field (7994 × 5995 px original, 3000 × 2250 px solve
copy, scale 2.6647; see `provenance.json`). The session token, the account e-mail in the
login message and the nova user id are scrubbed. Two responses cannot be recorded from a
successful solve and are written by hand to the documented shape: `job_failure.json` and
`upload_bad_session.json`.

| file | endpoint |
|---|---|
| `login.json` | `POST /api/login` |
| `login_bad_key.json` | `POST /api/login` with an invalid key |
| `upload.json` | `POST /api/upload` |
| `upload_bad_session.json` | `POST /api/upload` with an expired session (hand-written) |
| `submission_queued.json` | `GET /api/submissions/{subid}` before processing starts |
| `submission_pending.json` | `GET /api/submissions/{subid}` while the job is being created (`jobs: [null]`) |
| `submission_ready.json` | `GET /api/submissions/{subid}` once the job id exists |
| `job_solving.json`, `job_success.json` | `GET /api/jobs/{jobid}` |
| `job_failure.json` | `GET /api/jobs/{jobid}` for a failed solve (hand-written) |
| `job_info.json` | `GET /api/jobs/{jobid}/info/` (calibration, tags) |
| `annotations.json` | `GET /api/jobs/{jobid}/annotations/` (20 entries: 9 ngc, 3 ic, 8 bright) |
| `wcs.fits` | `GET /wcs_file/{jobid}` (header-only FITS with SIP terms, ASCII) |

What the recording taught us, and what the code now relies on: NGC/IC entries carry a single
designation (aliases such as `M 42` come from `app/catalog/names.json`); bright stars carry
`"ι Ori / 44 Ori"` plus an optional proper name; entries are never merged because nova puts
e.g. NGC 1980 and ι Ori at the same pixel; `hd` entries were absent for this 2.4° field.
