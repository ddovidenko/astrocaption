#!/bin/sh
# Single process: uvicorn runs the API, the static UI and the in-process solve worker.
set -eu
DATA_DIR="${ASTROCAPTION_DATA_DIR:-/data}"
if ! mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/renders" 2>/dev/null; then
  echo "astrocaption: cannot write to $DATA_DIR. The container runs as uid 1000;" >&2
  echo "  chown -R 1000:1000 ./data   (or mount a directory that uid 1000 can write)" >&2
  exit 1
fi
# With arguments, run them instead of the server: `docker compose run --rm app python -m
# app.cli reset-password` must work while the container is stopped (docs/LOCKOUT.md).
[ "$#" -gt 0 ] && exec "$@"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-server-header
