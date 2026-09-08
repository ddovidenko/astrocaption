#!/bin/sh
# Single process: uvicorn runs the API, the static UI and the in-process solve worker.
set -eu
DATA_DIR="${ASTROCAPTION_DATA_DIR:-/data}"
if ! mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/renders" 2>/dev/null; then
  echo "astrocaption: cannot write to $DATA_DIR. The container runs as uid 1000;" >&2
  echo "  chown -R 1000:1000 ./data   (or mount a directory that uid 1000 can write)" >&2
  exit 1
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --no-server-header
