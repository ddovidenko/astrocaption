# Installing AstroCaption

> First release (0.1.0). Everything below is what the image ships with; the roadmap is in
> `SPEC.md` § 13.

## Requirements

- Docker with the compose plugin (Docker Desktop on Windows/macOS, or Docker Engine on Linux/NAS).
- A free nova.astrometry.net account and its API key (profile page → *API key*).
  Each solve uploads a copy of the image (at most 3000 px on its long side) to that account. It is
  not publicly listed, but nova has no way to delete uploads, so every copy stays there.

## Three commands

```sh
git clone https://github.com/ddovidenko/astrocaption.git && cd astrocaption
export NOVA_API_KEY=your-key-here          # optional here: the setup page and the config page take it too
docker compose up -d                       # pulls ghcr.io/ddovidenko/astrocaption:latest
```

To build the image yourself instead of pulling it: `docker compose up -d --build` (`make up`).

Open <http://localhost:8080>. Uploaded images, previews, the SQLite database and exports
live in `./data` on the host; back that directory up and nothing else.

## First run

The first visit to <http://localhost:8080> shows the setup page: choose the owner password
(at least 8 characters), optionally paste the nova API key and a site title. An input whose
value is already pinned by an environment variable (`NOVA_API_KEY`, `ASTROCAPTION_SITE_TITLE`)
is shown disabled and marked "set by the environment": the variable wins either way, so there
is nothing to type. That writes
`data/config.json` (password hash, a random session secret, the key, the title) with owner-only
permissions and sends you to the sign-in page. Setup is closed from then on.

Until setup is completed, anyone who can reach the port can claim the site. Finish setup right
after the first start, or set `ASTROCAPTION_PASSWORD` when the port is reachable from anywhere
you don't trust.

Headless installs set `ASTROCAPTION_PASSWORD` instead: on start, if no password has been set
yet, the app performs setup with it. The variable is read once, so you can remove it afterwards.
Passwords outside 8 to 1024 characters are ignored with a log line.

Change the password later on the Config page: it asks for the current one, keeps you signed in,
and signs every other browser out.

Sign-ins are rate-limited (five wrong passwords → 60 seconds). Forgot the password:
`make reset-password` (or `docker compose exec app python -m app.cli reset-password`) asks for
a new one inside the running container and logs every browser out; on a source checkout it is
`make reset-password-dev`. See `docs/LOCKOUT.md` for the other lockout cases.

## Configuration

| Setting | Where | Default |
|---|---|---|
| nova API key | `NOVA_API_KEY` env (alias: `ASTROMETRY_API_KEY`), or `"nova_api_key"` in `data/config.json`, or the config page | unset (solves fail with a hint) |
| Upload limit | `ASTROCAPTION_MAX_UPLOAD_MB` env, or `"max_upload_mb"`, or the config page | 60 (and 300 megapixels) |
| Site title | `ASTROCAPTION_SITE_TITLE` env, or `"site_title"`, or the config page | AstroCaption |
| Public gallery | `ASTROCAPTION_PUBLIC_GALLERY` env (`true`/`false`, also `1`/`0`, `yes`/`no`, `on`/`off`, case-insensitive), or `"public_gallery_enabled"`, or the config page | on |
| Data directory | `ASTROCAPTION_DATA_DIR` env | `/data` in the container |
| Default label style | `"default_style"` object in `data/config.json`, or the config page | built-in defaults (size-relative for the four size fields) |
| Owner password | setup page, or `ASTROCAPTION_PASSWORD` env at first start, or the Config page later | required |
| Reverse proxy | `TRUST_PROXY=1` env: trust `X-Forwarded-*` from the proxy; session cookie `Secure` over https | off |
| Solve timeout | `ASTROCAPTION_SOLVE_TIMEOUT_SECONDS` env | 900 (bounds 1-86400) |
| Solve poll interval | `ASTROCAPTION_SOLVE_POLL_SECONDS` env | 5 (bounds 0.1-3600) |

Public gallery: when on, signed-out visitors see the published images at `/`, each with a
hover-to-reveal annotated preview and a link to the full-resolution annotated export; nothing
else (the editor, the config page, unpublished images) is reachable without signing in. Turning
it off (`ASTROCAPTION_PUBLIC_GALLERY=false` or the config page) serves 404 on every gallery route
and shows only the site title and a plain sentence at `/` (the header's own "Log in" link is
still there). An unrecognised value for `ASTROCAPTION_PUBLIC_GALLERY` is logged and leaves the
gallery on.

Solve timeout and poll interval are not exposed on the config page; they are read once at
process start, so changing one means restarting the app. Unset or blank = the default; a
non-numeric, non-finite or out-of-range value falls back to the default with one log line
naming the variable and the bounds. Under `compose.yml` they have to be added to the service's
`environment:` list (two commented-out lines there show the spelling). The browser test suite
sets them low, in `frontend/e2e/app.env`, so a timed-out solve can be exercised in seconds.

Values set by environment variables win over `data/config.json`; the config page shows
them read-only and names the variable that pinned each one. `max_upload_mb` outside 1-1024 is
clamped when the file is read, with a line in the server log.

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
applies to newly solved images. Only the fields you list are overridden; anything you leave
out keeps its built-in default, and for `font_size`, `halo_width`, `marker_width` and
`marker_min_radius` that default is derived from each image's size. Colours are `#RRGGBB`
(`"#ffd54a"`, not `"yellow"`), sizes are whole numbers within the bounds the API accepts
(font size 6-500, halo and marker width 0-100 and 1-100, marker minimum radius 1-400, max
aliases 0-5) and the font is a bundled file name. The bundled families are listed in
`fonts/README.md`; a `font_file` that is not bundled is ignored with a server-log warning and the default
`Inter-Regular.ttf` is used. A value the page cannot represent — a colour by name, a size out
of range, a field that is not part of the style — is dropped when the file is read, with a
warning in the server log naming the field; the rest of your `default_style` still applies.

`name_preference` picks the label's primary line: `popular`
(Messier, Caldwell, Sharpless and Barnard first, then NGC, then IC, then other catalogues,
then common names) or `ngc_ic` (NGC and IC designations first). Stars show their proper name
first, then the Bayer letter, then the Flamsteed number. The alias line drops the primary
name, prefers common names ("Great Orion Nebula" before "NGC 1976"), leaves out
star-catalogue ids when a better name exists, and shows at most `max_aliases` names (default
2; 0 hides the line). Images solved before this version keep their saved layout, but their
alias lines follow the new rule, so exports made after the upgrade can differ from earlier
ones. The names themselves are attached when an image is solved: a catalogue update (for
example "Running Man Nebula", which used to read "the Running Man Nebula") reaches an image
already solved only after you re-solve it.

The config page edits the same object: blank fields keep the built-in defaults, and saving
stores exactly the fields shown filled in, so clearing one there removes it from the file.

The file is re-read whenever it changes, so every setting in it is live without a restart, and
`/api/health` reports any parse error in the file. The key itself is never logged and never
returned by the API; `GET /api/config` (owner-only) reports only whether one is set.

## Data directory layout

```
data/
  astrocaption.sqlite        images, catalogue objects, annotation layouts
  config.json                optional, see above
  config.json.lock           empty; serialises writers to config.json (safe to leave alone)
  uploads/<id>/original.*    your file, byte-for-byte; never modified
  uploads/<id>/preview.jpg   ≤ 2048 px
  uploads/<id>/thumb.jpg     ≤ 400 px
  uploads/<id>/solve.jpg     ≤ 3000 px copy that is sent to nova
  uploads/<id>/nova_annotations.json, wcs.fits
  renders/<id>/annotated.jpg, annotated_preview.jpg
```

The container runs as uid 1000. If `./data` is owned by another user you will see
`cannot write to /data` on start; fix it with `chown -R 1000:1000 data`.

## Releases, tags and upgrades

Images are published to `ghcr.io/ddovidenko/astrocaption` by the release workflow when a
`vX.Y.Z` tag is pushed:

| Tag | Meaning |
|---|---|
| `X.Y.Z` | that release, never changes |
| `X.Y` | the newest patch of that minor |
| `latest` | the newest stable release (never `main`, never a pre-release) |

Pre-releases (`0.2.0-rc1`) get only their own tag and are marked as such on the GitHub
Releases page, which also carries the release notes and the `compose.yml` of that version.

To upgrade an instance that uses `compose.yml` as shipped (`image: …:latest`):

```sh
docker compose pull && docker compose up -d
```

Back up `./data` first: the database schema is migrated forward on start, and an older image
refuses to start on a database written by a newer one. Pin `image:` to `X.Y` if you would rather
take patches only, or to `X.Y.Z` and upgrade by editing the tag, which is what a server you look
after once a month wants.

The package is public: pulling needs no GitHub account or `docker login`. If you run a fork,
its first release pushes a *private* package (GHCR starts every new package that way); make it
public, or `docker login ghcr.io` on the server, before `docker compose pull` will work.
Maintainers: the release steps are in `RELEASING.md`.

## On a public server

The container is one process on one port and keeps every file under `./data`, so it fits any
Docker host: a VPS, a home server, a NAS. Install Docker Engine and the compose plugin from
[Docker's own instructions](https://docs.docker.com/engine/install/); the rest is the same
everywhere:

- Put TLS in front. The app speaks plain http; a reverse proxy (next section) terminates https,
  and with `TRUST_PROXY=1` the session cookie is `Secure`. Finish setup right after the first
  start: until then anyone who can reach the port can claim the site (or set
  `ASTROCAPTION_PASSWORD` for the first start).
- Firewall: allow 22, 80 and 443 and nothing else. Use the provider's firewall (Hetzner, DigitalOcean,
  …) or `iptables` rules you control: **Docker's published ports bypass `ufw`**, because Docker
  writes its own `iptables` rules. Publishing the app's port on loopback only (below) is the
  other half of the same precaution.
- `./data` must be writable by uid 1000 (`chown -R 1000:1000 data`), see "Data directory layout".
- Back up `./data`, and nothing else; a nightly `tar -czf astrocaption-data-$(date +%F).tgz data`
  is enough. Upgrade by changing the tag (or `docker compose pull` on `latest`) after a backup.
- Restore with the stack stopped: `docker compose down`, unpack the tarball so `data/` sits next
  to `compose.yml` again (not `data/data/`), `chown -R 1000:1000 data`, then `docker compose up -d`.
  A bind mount pins the directory the container was started with, so a `data/` deleted and
  recreated under a running container is invisible to it: the app behaves like a fresh install
  and writes into the deleted directory until the stack is restarted. Do not complete setup in
  that state; restart instead.
- Uploads are large requests: every proxy below raises its body limit, and the app's own upload
  limit (default 60 MB, config page) must fit under whatever sits in front of it.

## Behind a reverse proxy

The app listens on port 8000 inside the container. Two shapes, both exercised:

### A proxy installed on the host

The stock `compose.yml`, with the port published on loopback so only the proxy can reach it:

```yaml
    ports:
      - "127.0.0.1:8080:8000"
    environment:
      - TRUST_PROXY=1
```

Caddy (`/etc/caddy/Caddyfile`; the `{` after `request_body` has to end its line):

```
sky.example.com {
    reverse_proxy localhost:8080
    request_body {
        max_size 100MB
    }
}
```

nginx:

```
server {
    server_name sky.example.com;
    client_max_body_size 100m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_read_timeout 300;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;   # replace, never append: the app reads the first entry
    }
}
```

Caddy sends both forwarded headers by default and replaces any a client supplied; nginx needs
the two `proxy_set_header` lines (upgrading from a release before 0.1.0: add them, or the cookie
stops being `Secure` behind nginx).

### A proxy that is itself a container

One proxy container owns 80/443 for every site on the host and reaches each app over a Docker
network. The app's service then publishes no port at all and joins that network; everything else
in `compose.yml` stays:

```yaml
services:
  app:
    image: ghcr.io/ddovidenko/astrocaption:0.1.0
    # no ports:
    networks: [proxy]
    volumes:
      - ./data:/data
    environment:
      - TRUST_PROXY=1
      - NOVA_API_KEY=${NOVA_API_KEY:-}
    restart: unless-stopped
networks:
  proxy:
    external: true          # docker network create proxy, once; the proxy container joins it too
```

The proxy addresses the app by service name on that network. For Caddy, with the site's stack
directory named `astrophoto`, the upstream is `astrophoto-app-1:8000` (or set
`container_name`), and the block is the one above with that upstream. Reload the proxy after
adding a site; a `docker compose up -d` of the app needs nothing on the proxy side.

### What `TRUST_PROXY=1` does

The app then trusts the proxy's `X-Forwarded-Proto` and `X-Forwarded-For` headers from every
upstream: the session cookie is marked `Secure` when the request came in over https, and the
address the proxy reports is what the access log shows. Signing in over plain http (the LAN
address, or `http://localhost:8080` straight at the container) keeps working with the flag set;
that cookie is simply not `Secure`.

With the flag on, a client that reaches the container directly can set those headers itself.
That changes only the `Secure` attribute of its own cookie and the address in the log line, so
it is harmless, but it is why the host-proxy shape publishes the port on loopback only and the
container-proxy shape publishes none. With the flag off, only uvicorn's default applies:
forwarded headers are honoured from loopback peers (`FORWARDED_ALLOW_IPS`), which is the case
for the `make dev` Vite proxy.

### Behind Cloudflare

A proxied ("orange cloud") record works, with three things to know:

- SSL/TLS mode **Full (strict)**, never Flexible: with Flexible the origin sees plain http and the
  cookie is never `Secure`. The origin certificate can be a Cloudflare Origin CA certificate (15
  years, trusted only by Cloudflare) or Let's Encrypt. For Let's Encrypt via the HTTP-01
  challenge, "Always Use HTTPS" redirects the challenge away: grey-cloud the record until the
  first certificate is issued, then proxy it again.
- Cloudflare's own `X-Forwarded-For` lists its edge; the visitor's address is in
  `CF-Connecting-IP`. Have the proxy forward that one instead, so the access log shows the real
  visitor. Caddy: `header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}` inside the
  `reverse_proxy` block; nginx: `proxy_set_header X-Forwarded-For $http_cf_connecting_ip;`.
- The free plan caps request bodies at **100 MB**. Set the app's upload limit to 100 or below on
  the config page; a larger upload fails at the edge with no useful message. Resumable uploads
  that would lift this are issue #166.

Other setups (a Cloudflare Tunnel, Tailscale, a reverse proxy on another machine) follow the same
two rules: the proxy terminates https and sends the two forwarded headers, and nothing but the
proxy can reach the app's port.

## Getting help

- Questions about installing or running it (Docker, a reverse proxy, the nova key, a lockout) go to
  [Discussions Q&A](https://github.com/ddovidenko/astrocaption/discussions/categories/q-a).
- A solve that failed or came back wrong: the **Solve failure** issue form. Have the failure sentence
  from the image card, the card's nova status link, and the image size to hand; most solve failures are
  about the image (too few stars, an extreme field), so try *Re-solve* with scale hints first.
- Anything else that does not work as this file says: the **Bug report** form. It asks for the version
  (`/api/health`) and the last log lines, `docker compose logs --since 10m app`. The server never logs
  the key, the password or your image, but look the lines over before pasting them.

## Running from source (development)

```sh
make install        # backend venv + frontend packages (needs python3 ≥ 3.13 and node ≥ 22.22)
make dev            # API on :8000, Vite on :5173 with /api and /fonts proxied
make test           # pytest + vitest
make lint           # ruff + mypy + eslint + tsc
make e2e            # browser smoke test, plus the Vite dev server through its /api proxy
```

No local toolchain? The repo carries a devcontainer (`.devcontainer/devcontainer.json`: Python 3.14, Node 24,
`make install` on create). Open it in a GitHub Codespace (*Code → Codespaces → Create*) or in VS Code's
Dev Containers extension, then run `make dev` as above; Codespaces forwards port 5173 and opens it.

| Dev-only setting | Where | Default |
|---|---|---|
| Dev proxy target | `ASTROCAPTION_DEV_PROXY_TARGET` env, read by `frontend/vite.config.ts` | `http://localhost:8000` (the uvicorn `make dev` starts) |

`make e2e` sets `ASTROCAPTION_DEV_PROXY_TARGET` itself, to the app under test; setting it by hand
also moves the Vite dep cache to `node_modules/.vite-e2e`, so a suite run cannot disturb the cache
of a `make dev` server that is already up.

The browser test runs against a fake nova that replays recorded responses, so it never contacts
nova.astrometry.net and never touches `./data`. The first run downloads Chromium (about 170 MB, into
`~/.cache/ms-playwright`); on a fresh host without a desktop, install its libraries once with
`cd frontend && npx playwright install-deps chromium` (needs sudo).

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
