#!/bin/bash
# Start (or restart) the live demo: simulation + frame relay + browser UI.
#
#   producer = the in-process emitter (src/control.c), enabled by FARGO_CONTROL_PORT
#   relay    = tools/live/live_view.py
#   UI       = the bundle in tools/live/web/dist (build once with tools/live/build_web.sh)
#
# Everything is taken from this script's own location, so a fresh clone runs without editing.
# Overrides: FARGO_LIVE_DIR (writable working directory), FARGO_BIN, FARGO_WEB_DIR, FARGO_PAR,
#            NTOT, NINTERM, MAXORBITS, CPORT, PORT, PLANETS
set -u
P="$(cd "$(dirname "$0")/../.." && pwd)"                 # repository root
B="${FARGO_LIVE_DIR:-$HOME/fargo-live}"                  # writable working directory
BIN="${FARGO_BIN:-$P/fargo3d}"
WEB="${FARGO_WEB_DIR:-$P/tools/live/web/dist}"
PAR="${FARGO_PAR:-$P/setups/fargo/fargo_test.par}"
NTOT=${NTOT:-12000}
NINTERM=${NINTERM:-10}
MAXORBITS=${MAXORBITS:-60}
CPORT=${CPORT:-9100}
PORT=${PORT:-8088}
PLANETS=${PLANETS:-}

[ -x "$BIN" ] || { echo "no executable at $BIN - build the code first (see INSTALL.md)" >&2; exit 1; }
[ -f "$PAR" ] || { echo "no parameter file at $PAR" >&2; exit 1; }
[ -f "$WEB/index.html" ] || { echo "no UI bundle at $WEB - run tools/live/build_web.sh" >&2; exit 1; }

mkdir -p "$B"
for f in "$B/live-sim.pid" "$B/live-bridge.pid"; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  kill -CONT "$pid" 2>/dev/null     # a SIGSTOPped simulation ignores TERM until it is continued
  kill "$pid" 2>/dev/null
  rm -f "$f"
done
# a seek relaunches the simulation, so the pid file can be stale: sweep by exact name too
pkill -x "$(basename "$BIN")" 2>/dev/null
sleep 1

rm -rf "$B/live"; mkdir -p "$B/live"
cd "$P" || exit 1
sed -e "s|^Ntot.*|Ntot  $NTOT|" \
    -e "s|^Ninterm.*|Ninterm $NINTERM|" \
    -e "s|^OutputDir.*|OutputDir $B/live|" \
    ${PLANETS:+-e "s|^PlanetConfig.*|PlanetConfig $PLANETS|"} \
    "$PAR" > "$B/live.par"
for k in Ntot Ninterm OutputDir; do
  grep -q "^$k" "$B/live.par" 2>/dev/null || echo "warning: $k is not in $PAR, so it was not overridden" >&2
done

# -k disables output merging, so dumps keep the per-rank suffix RestartSimulation reads
FARGO_CONTROL_PORT=$CPORT "$BIN" -k "$B/live.par" > "$B/live-sim.log" 2>&1 &
echo $! > "$B/live-sim.pid"
sleep 2

# Ninterm, DT and OmegaFrame are read from the par by the relay; no duplicated constants here
python3 "$P/tools/live/live_view.py" --control-port "$CPORT" --port "$PORT" \
      --base-dir "$B" --web-dir "$WEB" --pid "$(cat "$B/live-sim.pid")" \
      --max-orbits "$MAXORBITS" --bin "$BIN" --par "$B/live.par" \
      --dumpdir "$B/live" --workdir "$P" > "$B/live-bridge.log" 2>&1 &
echo $! > "$B/live-bridge.pid"
sleep 3

grep -E "CONTROL" "$B/live-sim.log" | head -1
head -3 "$B/live-bridge.log"
echo "sim=$(cat "$B/live-sim.pid") relay=$(cat "$B/live-bridge.pid") control=$CPORT http=$PORT maxorbits=$MAXORBITS"
echo "open http://localhost:$PORT/   or   http://$(hostname -I | awk '{print $1}'):$PORT/"
