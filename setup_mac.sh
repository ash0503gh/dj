#!/usr/bin/env bash
# Setup on a Mac (Apple Silicon), run again after pulling changes: ffmpeg with Rubber Band for keylocked
# stretching, Python 3.12, the server's packages and the prepare stages' models in .venv.
set -e
cd "$(dirname "$0")"

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
brew install ffmpeg rubberband python@3.12

PY="$(brew --prefix python@3.12)/bin/python3.12"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
# The neural beat tracker and the key extractor (prepare runs without them if this fails)
.venv/bin/pip install -r requirements-local.txt || echo "WARNING: model extras not installed: prepare runs without the neural beat tracker and key extractor."

# The keylocked stretch falls back to ffmpeg's atempo (lower quality) without Rubber Band in ffmpeg
if ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' rubberband '; then
  echo "ffmpeg has Rubber Band: keylocked stretching at full quality."
else
  echo "WARNING: this ffmpeg has no Rubber Band filter; keylocked stretching will use atempo (lower quality)."
fi
echo "Done. Start with: ./run_local.sh /path/to/your/music (the first time; ./run_local.sh after that)"
