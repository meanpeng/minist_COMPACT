#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
PYTHON_BIN="${PYTHON_BIN:-python}"

if [[ ! -f "$ROOT_DIR/dist/index.html" ]]; then
  echo "dist/index.html not found; building frontend first."
  npm run build
fi

echo "Starting production app on http://${BACKEND_HOST}:${BACKEND_PORT}"
exec "$PYTHON_BIN" -m uvicorn backend.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT"
