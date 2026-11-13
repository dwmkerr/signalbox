#!/usr/bin/env bash
# start-hub.sh <signalbox-cli> <run-dir>: start an isolated hub on 8399 and
# print its pid. Refuses to run if the hub is not a fresh local one.
set -euo pipefail
sb=$1 run=$2
source "$(dirname "$0")/isolated-env.sh" "$run"
if curl -sf "$SIGNALBOX_URL/healthz" >/dev/null; then echo "port 8399 already in use" >&2; exit 1; fi
"$sb" hub --port 8399 >"$run/hub.log" 2>&1 &
pid=$!
for _ in $(seq 50); do curl -sf "$SIGNALBOX_URL/healthz" >/dev/null && break; python3 -c 'import time; time.sleep(0.2)'; done
curl -s "$SIGNALBOX_URL/healthz" > "$run/healthz.json"
grep -q '"mode":"local"' "$run/healthz.json" || { kill $pid; echo "hub is not local: $(cat "$run/healthz.json")" >&2; exit 1; }
echo $pid
