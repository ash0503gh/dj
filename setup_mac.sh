#!/usr/bin/env bash
# One-time setup on a Mac (Apple Silicon): ffmpeg with Rubber Band for keylocked stretching, Python 3.12
# and the server's packages in .venv.
set -e
cd "$(dirname "$0")"

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
brew install ffmpeg rubberband python@3.12

PY="$(brew --prefix python@3.12)/bin/python3.12"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# The keylocked stretch falls back to ffmpeg's atempo (lower quality) without Rubber Band in ffmpeg
if ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' rubberband '; then
  echo "ffmpeg has Rubber Band: keylocked stretching at full quality."
else
  echo "WARNING: this ffmpeg has no Rubber Band filter; keylocked stretching will use atempo (lower quality)."
fi
echo "Done. Start with: ./run_local.sh /path/to/your/music"
