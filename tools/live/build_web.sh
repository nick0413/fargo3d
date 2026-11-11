#!/bin/bash
# Build the browser UI into tools/live/web/dist, which live_view.py serves by default.
# Needs node and npm; nothing else. Run once after cloning, and again after editing the UI.
set -eu
P="$(cd "$(dirname "$0")/../.." && pwd)"
W="$P/tools/live/web"

command -v npm >/dev/null 2>&1 || { echo "npm not found - install node and npm" >&2; exit 1; }
cd "$W"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build

[ -f "$W/dist/index.html" ] || { echo "build finished but $W/dist/index.html is missing" >&2; exit 1; }
echo "UI bundle: $W/dist"
