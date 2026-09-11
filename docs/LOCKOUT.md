# Locked out

Four situations, four fixes. None of them touches your images, exports or the database.

## Wrong password too many times

Five wrong passwords start a 60-second cooldown; the sign-in page says how long to wait.
Wait it out and try again. The counter is in memory, so restarting the container also
clears it.

## Forgot the password

Choose a new one from the shell. With the compose install, while the container is running
(`docker compose up -d` first if it is not — `exec` needs a running container):

```sh
make reset-password
# or, without make:
docker compose exec app python -m app.cli reset-password
```

With the container stopped, or when it refuses to start, run a throwaway one instead:

```sh
docker compose run --rm app python -m app.cli reset-password
```

Running from source (`make dev`):

```sh
make reset-password-dev
# or, without make:
cd backend && .venv/bin/python -m app.cli reset-password
```

Run it as the user that owns `./data` — never with `sudo`. `sudo` on an editor, to fix
`config.json` by hand, is fine; `sudo` on this command is not: on a source checkout it would
leave `config.json` root-owned, which locks the app out harder than before. Inside the
container there is nothing to elevate — `make reset-password` already runs as the container's
own user. If `config.json` is root-owned already, the command refuses before it asks for
anything and prints the `sudo chown` that hands it back; if it belongs to some other user, it
names the uid and the command to use instead.

It asks for the new password twice, nothing echoed: 8 to 1024 characters, and the two entries
must match. Ctrl-C or Ctrl-D cancels. Any of these — too short, too long, mismatched,
cancelled — exits 1 with "Nothing was changed." and writes nothing.

Once accepted, it stores a new password hash and session secret in `data/config.json` and prints one line. The
running app picks the file up at once: every signed-in browser is logged out, and the new
password works immediately. Your nova key, site title and default style stay as they were.

Exit codes: 0 done; 1 the password was refused or the prompt was cancelled, nothing written;
3 `config.json` could not be read or written, or belongs to another user (the message says
which). 2 means the command line itself was wrong, before anything was read.

## Setup never completed

If there is no password yet — a fresh install, or a half-written file with only one of the
hash and the session secret — the same command completes setup instead of resetting anything,
and says so. You can also set `ASTROCAPTION_PASSWORD` for one start instead (see
`docs/INSTALL.md`, "First run").

## `config.json` is damaged

Stop the container first (`docker compose stop`), so the app is not reading the file while you
change it, and start it again afterwards.

**The file is still valid JSON** (you have it, you just cannot sign in): remove the
`password_hash` line. That reopens setup and keeps the nova key, the site title and the
default style. The next start asks you to choose a password again.

**The file cannot be read at all** (not valid JSON, not an object, unreadable): the app refuses
to sign anyone in and the sign-in page says so; `reset-password` exits 3 with the same message
and leaves the file exactly as it is — a damaged file is never overwritten. Fix the JSON, or
remove the file. Removing it reopens setup and forgets the password, the nova key, the site
title and the default style, nothing else.

Either way setup is open until you complete it, and while it is open anyone who can reach the
port can claim the site (`docs/INSTALL.md`, "First run"): finish it right away, or keep the
port unreachable until you do.

`config.json` is written by the app as uid 1000 with owner-only permissions, so editing it
on the host may need `sudo`.
