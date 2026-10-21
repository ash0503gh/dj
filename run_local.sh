#!/usr/bin/env bash
# Local mode: prepare any new or changed tracks in the music folder, then start the console and open it
# in Chrome (Web MIDI for the controller needs Chrome or Edge, not Safari).
#
#   ./run_local.sh ~/Music/DJ        the first time (the folder is remembered)
#   ./run_local.sh                   after that
#   SKIP_PREPARE=1 ./run_local.sh    start without preparing (new tracks stay unlisted until prepared)
set -e
cd "$(dirname "$0")"

LIB="${1:-${PULSE_LIBRARY:-$(cat .pulse_library 2>/dev/null || true)}}"
if [ -z "$LIB" ]; then
  echo "Usage: ./run_local.sh /path/to/your/music"
  exit 1
fi
LIB="$(cd "$LIB" && pwd)"
echo "$LIB" > .pulse_library
export PULSE_LIBRARY="$LIB"

[ -f .venv/bin/activate ] && source .venv/bin/activate

if [ -z "$SKIP_PREPARE" ]; then
  python3 -m backend.library prepare
fi

PORT="${PORT:-8000}"
URL="http://localhost:$PORT"
( sleep 2; open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL" 2>/dev/null || true ) &
echo "Pulse Pro: $URL (library: $LIB)"
exec python3 -m uvicorn backend.server:app --host 127.0.0.1 --port "$PORT"
