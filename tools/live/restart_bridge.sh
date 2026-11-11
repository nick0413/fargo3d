#!/bin/bash
# Restart only the frame relay, leaving the simulation untouched.
# Same path rules as start_demo.sh: nothing outside this clone is assumed to exist.
set -u
P="$(cd "$(dirname "$0")/../.." && pwd)"
B="${FARGO_LIVE_DIR:-$HOME/fargo-live}"
WEB="${FARGO_WEB_DIR:-$P/tools/live/web/dist}"
MAXORBITS=${MAXORBITS:-100}
PORT=${PORT:-8088}

[ -f "$B/live-sim.pid" ] || { echo "no simulation pid at $B/live-sim.pid - run start_demo.sh first" >&2; exit 1; }
[ -f "$B/live.par" ]     || { echo "no $B/live.par - run start_demo.sh first" >&2; exit 1; }

[ -f "$B/live-bridge.pid" ] && kill "$(cat "$B/live-bridge.pid")" 2>/dev/null
sleep 1

python3 "$P/tools/live/live_view.py" --base-dir "$B" --web-dir "$WEB" \
      --port "$PORT" --pid "$(cat "$B/live-sim.pid")" --max-orbits "$MAXORBITS" \
      --par "$B/live.par" --dumpdir "$B/live" --workdir "$P" > "$B/live-bridge.log" 2>&1 &
echo $! > "$B/live-bridge.pid"
sleep 3
cat "$B/live-bridge.log"
curl -s -m 5 "http://127.0.0.1:$PORT/meta"
echo
echo "bridge=$(cat "$B/live-bridge.pid") sim=$(cat "$B/live-sim.pid")"
