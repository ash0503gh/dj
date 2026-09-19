#!/usr/bin/env bash
set -e

# Try activating Render's virtual environment if present
if [ -f "/opt/render/project/src/.venv/bin/activate" ]; then
    source /opt/render/project/src/.venv/bin/activate
elif [ -f "./.venv/bin/activate" ]; then
    source ./.venv/bin/activate
fi

# Fallback to direct venv binary or system uvicorn
if [ -x "/opt/render/project/src/.venv/bin/uvicorn" ]; then
    exec /opt/render/project/src/.venv/bin/uvicorn backend.server:app --host 0.0.0.0 --port "${PORT:-8000}"
elif command -v uvicorn >/dev/null 2>&1; then
    exec uvicorn backend.server:app --host 0.0.0.0 --port "${PORT:-8000}"
else
    exec python3 -m uvicorn backend.server:app --host 0.0.0.0 --port "${PORT:-8000}"
fi
