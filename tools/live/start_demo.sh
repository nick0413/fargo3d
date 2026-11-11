#!/bin/bash
# Start (or restart) the live demo. Producer = the simulation itself (src/control.c emitter),
# relay = tools/live/live_view.py (socket -> HTTP + RAM ring), UI = the React build in
# /home/nick/fargo-bench/web.
set -u
B=/home/nick/fargo-bench
P="$(cd "$(dirname "$0")/../.." && pwd)"
NTOT=${NTOT:-12000}
NINTERM=${NINTERM:-10}
MAXORBITS=${MAXORBITS:-60}
CPORT=${CPORT:-9100}
PORT=${PORT:-8088}
PLANETS=${PLANETS:-}

for f in "$B/live-sim.pid" "$B/live-bridge.pid"; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  kill -CONT "$pid" 2>/dev/null
  kill "$pid" 2>/dev/null
done
# a seek relaunches the sim, so the pid file can be stale: sweep by exact name too
pkill -x fargo3d-f64 2>/dev/null
sleep 1

rm -rf "$B/live"; mkdir -p "$B/live"
cd "$P" || exit 1
sed -e "s|^Ntot.*|Ntot  $NTOT|" \
    -e "s|^Ninterm.*|Ninterm $NINTERM|" \
    -e "s|^OutputDir.*|OutputDir $B/live|" \
    ${PLANETS:+-e "s|^PlanetConfig.*|PlanetConfig $PLANETS|"} \
    setups/fargo/fargo_test.par > "$B/live.par"

# -k disables output merging, so dumps keep the per-rank suffix that RestartSimulation reads
FARGO_CONTROL_PORT=$CPORT nohup "$B/fargo3d-f64" -k "$B/live.par" > "$B/live-sim.log" 2>&1 &
echo $! > "$B/live-sim.pid"
sleep 2

nohup python3 "$P/tools/live/live_view.py" --control-port "$CPORT" --port "$PORT" \
      --pid "$(cat "$B/live-sim.pid")" --max-orbits "$MAXORBITS" \
      --bin "$B/fargo3d-f64" --par "$B/live.par" --dumpdir "$B/live" --workdir "$P" \
      --ninterm "$NINTERM" --dt 0.314159265359 > "$B/live-bridge.log" 2>&1 &
echo $! > "$B/live-bridge.pid"
sleep 3

grep -E "CONTROL" "$B/live-sim.log" | head -1
head -2 "$B/live-bridge.log"
echo "sim=$(cat "$B/live-sim.pid") relay=$(cat "$B/live-bridge.pid") control=$CPORT http=$PORT maxorbits=$MAXORBITS"
echo "open http://localhost:$PORT/   or   http://$(hostname -I | awk '{print $1}'):$PORT/"
