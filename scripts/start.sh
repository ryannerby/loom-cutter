#!/bin/bash
# Boot the Loom Cutter server.
#
#   ./scripts/start.sh           # dev: FastAPI :8000 + Vite :5173 (hot reload)
#   ./scripts/start.sh --prod    # prod: FastAPI :8000 serves built UI from ui/dist/
#
# Ctrl-C kills child processes.

set -e

cd "$(dirname "$0")/.."

MODE="dev"
if [ "$1" = "--prod" ] || [ "$1" = "-p" ]; then
  MODE="prod"
fi

# Pick up ANTHROPIC_API_KEY from ~/.zshrc if the parent shell doesn't have it.
if [ -z "$ANTHROPIC_API_KEY" ] && [ -f ~/.zshrc ]; then
  ANTHROPIC_API_KEY=$(grep '^export ANTHROPIC_API_KEY=' ~/.zshrc 2>/dev/null | sed -E 's/.*"(.*)".*/\1/')
  export ANTHROPIC_API_KEY
fi

VENV_PY="$PWD/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "error: $VENV_PY not found"
  echo "run: python3.12 -m venv .venv && .venv/bin/pip install -e '.[server]'"
  exit 1
fi

if [ "$MODE" = "prod" ]; then
  # In prod, expect the UI to be pre-built.
  if [ ! -d "ui/dist" ]; then
    echo "warning: ui/dist not found — building it now"
    (cd ui && npm run build)
  fi
  echo "[boot] prod: FastAPI on :8000 serving ui/dist/"
  "$VENV_PY" -m uvicorn server.main:app --port 8000 --log-level warning &
  BACK_PID=$!
  URL="http://localhost:8000"
else
  echo "[boot] dev: FastAPI on :8000 + Vite on :5173"
  "$VENV_PY" -m uvicorn server.main:app --reload --port 8000 --log-level info &
  BACK_PID=$!
  (cd ui && npm run dev) &
  FRONT_PID=$!
  URL="http://localhost:5173"
fi

trap "echo; echo '[stop] killing children…'; kill $BACK_PID ${FRONT_PID:-} 2>/dev/null; exit 0" INT TERM

# Wait for the relevant port to come up, then open the browser.
for i in $(seq 1 30); do
  if curl -s "$URL" > /dev/null 2>&1; then
    echo "[boot] up — opening $URL"
    open "$URL"
    break
  fi
  sleep 0.5
done

wait
