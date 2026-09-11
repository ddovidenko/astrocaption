# Locked out

Three situations, three fixes. None of them touches your images, exports or the database.

## Wrong password too many times

Five wrong passwords start a 60-second cooldown; the sign-in page says how long to wait.
Wait it out and try again. The counter is in memory, so restarting the container also
clears it.

## Forgot the password

Choose a new one from the shell. With the compose install:

```sh
make reset-password
# or, without make:
docker compose exec app python -m app.cli reset-password
```

Running from source (`make dev`):

```sh
cd backend && .venv/bin/python -m app.cli reset-password
```

Run it as the user that owns `./data` — never with `sudo`. On a source checkout, `sudo`
would run the command as root and leave `config.json` root-owned, which locks the app out
harder than before; inside the container, `make reset-password` already runs as the
container's own user, so there is nothing to elevate. If `config.json` belongs to someone
else, the command refuses before it even asks for a password: it names the uid and points at
`make reset-password`.

It asks for the new password twice, nothing echoed: 8 to 1024 characters, and the two entries
must match. Ctrl-C or Ctrl-D cancels. Any of these — too short, too long, mismatched,
cancelled — exits 1 with "Nothing was changed." and writes nothing.

Once accepted, it rewrites the password hash in `data/config.json` and prints one line. The
running app picks the file up at once: every signed-in browser is logged out, and the new
password works immediately. Your nova key, site title and default style stay as they were.

If a browser still appears signed in after a reset, restart the container: the app notices a
changed `config.json` by its size and timestamp, and a same-second write can be missed on
some filesystems.

Exit codes: 0 done; 1 the password was refused or the prompt was cancelled, nothing written;
2 `config.json` could not be read or written, or belongs to another user (the message says
why).

## Setup never completed, or `config.json` is damaged

If there is no password yet — a fresh install, or a half-written file with only one of the
hash and the session secret — the same command completes setup instead of resetting anything,
and says so. You can also set `ASTROCAPTION_PASSWORD` for one start instead (see
`docs/INSTALL.md`, "First run").

If `config.json` cannot be read at all, the app refuses to sign anyone in and the sign-in page
says so; `reset-password` exits 2 with the same message and how to fix it. Fix the JSON, or
remove the file: removing it reopens setup and forgets the password, the nova key, the site
title and the default style, nothing else. Removing only the `password_hash` line reopens
setup and keeps the rest.

`config.json` is written by the app as uid 1000 with owner-only permissions, so editing it
on the host may need `sudo`.
