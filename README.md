# AstroCaption

Self-hosted web app that plate-solves a **finished, colour-graded** astrophoto (JPG, PNG or
TIFF) with nova.astrometry.net and renders clean, legible annotations onto a full-resolution
copy. Your original file is never modified.

Status: **milestone 2** (upload → solve → auto-placed labels → export, behind an owner login, with
a config page). The editor is milestone 3; see `docs/SPEC.md` § 13 for the roadmap.

```sh
git clone https://github.com/ddovidenko/astrocaption.git && cd astrocaption
export NOVA_API_KEY=...            # from your nova.astrometry.net profile (or add it later on the config page)
docker compose up -d --build
```

Then visit http://localhost:8080 and choose the owner password.

- Install and configuration: `docs/INSTALL.md`
- Product and technical spec: `docs/SPEC.md`
- Code map: `docs/ARCHITECTURE.md`
- Locked out: `docs/LOCKOUT.md`

Licence: MIT. Bundled fonts carry their own open-font licences in `fonts/LICENSES/` (OFL, and
the Ubuntu Font Licence for Ubuntu); the object-name
table in `backend/app/catalog/names.json` is derived from [OpenNGC](https://github.com/mattiaverga/OpenNGC)
under CC BY-SA 4.0 (see `backend/app/catalog/OPENNGC-LICENSE.md`).
