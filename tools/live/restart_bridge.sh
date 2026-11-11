#!/bin/bash
# Restart only the frame bridge, leaving the simulation untouched.
set -u
B=/home/nick/fargo-bench
P="$(cd "$(dirname "$0")/../.." && pwd)"
MAXORBITS=${MAXORBITS:-100}
NINTERM=${NINTERM:-8}

[ -f "$B/live-bridge.pid" ] && kill "$(cat "$B/live-bridge.pid")" 2>/dev/null
sleep 1

nohup python3 "$P/tools/live/live_view.py" --outdir "$B/live" --nx 384 --ny 128 \
      --dt 0.314159265359 --port 8088 --pid "$(cat "$B/live-sim.pid")" \
      --max-orbits "$MAXORBITS" --ninterm "$NINTERM" > "$B/live-bridge.log" 2>&1 &
echo $! > "$B/live-bridge.pid"
sleep 3
cat "$B/live-bridge.log"
curl -s -m 5 http://127.0.0.1:8088/meta
echo
echo "bridge=$(cat "$B/live-bridge.pid") sim=$(cat "$B/live-sim.pid")"
