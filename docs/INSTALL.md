# Installing AstroCaption

> Status: milestone 2. Upload, solve, export and the owner login work; the config page and the
> lockout CLI follow in this milestone.

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

## First run

The first visit to <http://localhost:8080> shows the setup page: choose the owner password
(at least 8 characters), optionally paste the nova API key and a site title. That writes
`data/config.json` (password hash, a random session secret, the key, the title) with owner-only
permissions and sends you to the sign-in page. Setup is closed from then on.

Until setup is completed, anyone who can reach the port can claim the site. Finish setup right
after the first start, or set `ASTROCAPTION_PASSWORD` when the port is reachable from anywhere
you don't trust.

Headless installs set `ASTROCAPTION_PASSWORD` instead: on start, if no password has been set
yet, the app performs setup with it. The variable is read once, so you can remove it afterwards.
Passwords shorter than 8 characters are ignored with a log line.

Sign-ins are rate-limited (five wrong passwords → 60 seconds). Forgot the password: stop the
container, delete the `password_hash` line from `data/config.json` (or the whole file, which
also drops the key and title), start it again and the setup page returns; images and the
database are untouched. A `reset-password` command and `docs/LOCKOUT.md` arrive later in this
milestone.

## Configuration

| Setting | Where | Default |
|---|---|---|
| nova API key | `NOVA_API_KEY` env (alias: `ASTROMETRY_API_KEY`), or `"nova_api_key"` in `data/config.json` | unset (solves fail with a hint) |
| Upload limit | `ASTROCAPTION_MAX_UPLOAD_MB` env, or `"max_upload_mb"` | 60 (and 300 megapixels) |
| Site title | `ASTROCAPTION_SITE_TITLE` env, or `"site_title"` | AstroCaption |
| Data directory | `ASTROCAPTION_DATA_DIR` env | `/data` in the container |
| Default label style | `"default_style"` object in `data/config.json` | size-relative defaults |
| Owner password | setup page, or `ASTROCAPTION_PASSWORD` env at first start | required |
| Secure cookies | `TRUST_PROXY=1` env when the app is served over HTTPS by a proxy | off |

Values set by environment variables win over `data/config.json`; the config page (PR 2) shows
them read-only.

`data/config.json` is created by the app (uid 1000 inside the container) with owner-only
permissions (0600); editing it directly on the host may need `sudo`.

Setup adds `password_hash` and `session_secret` to this file; leave those two alone. A minimal
`data/config.json`:

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

The file is re-read whenever it changes, so every setting in it is live without a restart, and
`/api/health` reports any parse error in the file. The key itself is never logged and never
returned by the API; `GET /api/config` (owner-only) reports only whether one is set.

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

Set `TRUST_PROXY=1` in `compose.yml` once the proxy terminates HTTPS, so the session cookie is
marked Secure.

## Running from source (development)

```sh
make install        # backend venv + frontend packages (needs python3 ≥ 3.13 and node ≥ 22)
make dev            # API on :8000, Vite on :5173 with /api and /fonts proxied
make test           # pytest + vitest
make lint           # ruff + mypy + eslint + tsc
```

The dev server uses `./data` in the repo (git-ignored).

To have the dev servers come up whenever the machine (or the WSL distro) boots, on a host with
systemd:

```sh
make dev-service          # installs and enables /etc/systemd/system/astrocaption-dev.service (sudo)
journalctl -u astrocaption-dev -f
sudo systemctl stop astrocaption-dev    # before running make dev by hand; start it again afterwards
make dev-service-remove   # undo
```

The unit runs `make dev` from this checkout as your user. Under WSL the distro itself only starts
when something launches it; to bring it up at Windows sign-in, add a Task Scheduler entry that runs
`wsl.exe -d <distro> --exec /bin/true`.
