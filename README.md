# AstroCaption

Self-hosted web app that plate-solves a **finished, colour-graded** astrophoto (JPG, PNG or
TIFF) with nova.astrometry.net and renders clean, legible annotations onto a full-resolution
copy. Your original file is never modified.

Status: **milestone 1** (upload → solve → auto-placed labels → export). No login or editor
yet; see `docs/SPEC.md` § 13 for the roadmap.

```sh
export NOVA_API_KEY=...            # from your nova.astrometry.net profile
docker compose up -d --build
open http://localhost:8080
```

- Install and configuration: `docs/INSTALL.md`
- Product and technical spec: `docs/SPEC.md`
- Code map: `docs/ARCHITECTURE.md`

Licence: MIT. Bundled fonts carry their own OFL licences in `fonts/LICENSES/`; the object-name
table in `backend/app/catalog/names.json` is derived from [OpenNGC](https://github.com/mattiaverga/OpenNGC)
under CC BY-SA 4.0 (see `backend/app/catalog/OPENNGC-LICENSE.md`).
