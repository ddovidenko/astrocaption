# Installing AstroCaption

> Status: milestone 1. Upload, solve and export work; **there is no login yet** (milestone 2).
> Run it on a private network or behind your own authentication until then.

## Requirements

- Docker with the compose plugin (Docker Desktop on Windows/macOS, or Docker Engine on Linux/NAS).
- A free nova.astrometry.net account and its API key (profile page → *API key*).

## Three commands

```sh
git clone https://github.com/ddovidenko/astrocaption.git && cd astrocaption
export NOVA_API_KEY=your-key-here          # or put it in data/config.json, see below
docker compose up -d --build
```

Open <http://localhost:8080>. Uploaded images, previews, the SQLite database and exports
live in `./data` on the host; back that directory up and nothing else.

`make up` is the same as the last command when you have `make` installed.

## Configuration

| Setting | Where | Default |
|---|---|---|
| nova API key | `NOVA_API_KEY` env (alias: `ASTROMETRY_API_KEY`), or `"nova_api_key"` in `data/config.json` | unset (solves fail with a hint) |
| Upload limit | `ASTROCAPTION_MAX_UPLOAD_MB` env, or `"max_upload_mb"` | 60 |
| Site title | `ASTROCAPTION_SITE_TITLE` env, or `"site_title"` | AstroCaption |
| Data directory | `ASTROCAPTION_DATA_DIR` env | `/data` in the container |
| Default label style | `"default_style"` object in `data/config.json` | size-relative defaults |

A minimal `data/config.json`:

```json
{
  "nova_api_key": "your-key-here",
  "max_upload_mb": 60,
  "site_title": "My sky",
  "default_style": { "name_preference": "popular", "font_file": "Inter-Regular.ttf" }
}
```

`default_style` accepts any field of the style object (font file, colours, halo, sizes) and
applies to newly solved images. `name_preference` picks the label's primary line: `popular`
(Messier, Caldwell, Sharpless and Barnard first, then NGC, then IC, then other catalogues,
then common names) or `ngc_ic` (NGC and IC designations first). Stars show their proper name
first, then the Bayer letter, then the Flamsteed number. Other names appear on the alias line.

The key is read on every solve, so editing the file does not require a restart. It is never
logged and never returned by the API (`/api/health` only reports whether one is set).

## Data directory layout

```
data/
  astrocaption.sqlite        images, catalogue objects, annotation layouts
  config.json                optional, see above
  uploads/<id>/original.*    your file, byte-for-byte; never modified
  uploads/<id>/preview.jpg   ≤ 2048 px
  uploads/<id>/thumb.jpg     ≤ 400 px
  uploads/<id>/solve.jpg     ≤ 3000 px copy that is sent to nova
  uploads/<id>/nova_annotations.json, wcs.fits
  renders/<id>/annotated.jpg, annotated_preview.jpg
```

The container runs as uid 1000. If `./data` is owned by another user you will see
`cannot write to /data` on start; fix it with `chown -R 1000:1000 data`.

## Behind a reverse proxy

The app listens on port 8000 inside the container (8080 on the host in `compose.yml`).
Uploads can be large: raise the proxy's body limit to at least your upload limit.

Caddy:

```
sky.example.com {
    reverse_proxy localhost:8080
    request_body { max_size 100MB }
}
```

nginx:

```
server {
    server_name sky.example.com;
    client_max_body_size 100m;
    location / { proxy_pass http://127.0.0.1:8080; proxy_read_timeout 300; }
}
```

`TRUST_PROXY=1` (secure cookies) becomes relevant with the login in milestone 2.

## Running from source (development)

```sh
make install        # backend venv + frontend packages (needs python3 ≥ 3.13 and node ≥ 22)
make dev            # API on :8000, Vite on :5173 with /api and /fonts proxied
make test           # pytest + vitest
make lint           # ruff + mypy + eslint + tsc
```

The dev server uses `./data` in the repo (git-ignored).
