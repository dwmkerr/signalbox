#!/usr/bin/env bash
# capture-mac.sh <label> <signalbox-cli> <app-bundle> <seed-script> <out-dir>
# Isolated hub + seed + a background app instance; captures only that
# instance's jumplist window to <out-dir>/mac-<label>.png. Never captures the
# screen or a region: those include the operator's real windows.
set -euo pipefail
label=$1 sb=$2 app=$3 seed=$4 out=$5
here=$(cd "$(dirname "$0")" && pwd)
run="$out/run-mac-$label"; rm -rf "$run"
hub=$("$here/start-hub.sh" "$sb" "$run")
trap 'kill $hub 2>/dev/null || true' EXIT
source "$here/isolated-env.sh" "$run"
"$seed" "$SIGNALBOX_URL"
curl -s "$SIGNALBOX_URL/state" > "$run/state.json"
existing=$(pgrep -f "$app/Contents/MacOS/Signalbox" || true)
open -g -n --env SIGNALBOX_URL="$SIGNALBOX_URL" --env SIGNALBOX_DATA_DIR="$SIGNALBOX_DATA_DIR" \
  --env SIGNALBOX_CONFIG="$SIGNALBOX_CONFIG" "$app" --args --show-jumplist --config-parameter ui.foreground=false
pid=""
for _ in $(seq 50); do
  pid=$(pgrep -f "$app/Contents/MacOS/Signalbox" | grep -vxF "${existing:-none}" | head -1 || true)
  [ -n "$pid" ] && break; python3 -c 'import time; time.sleep(0.2)'
done
[ -n "$pid" ] || { echo "app did not start" >&2; exit 1; }
# The panel draws grey until its first /state round trip renders.
python3 -c 'import time; time.sleep(6)'
wid=$(swift -e '
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
let w = list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowIsOnscreen as String] as? Bool ?? false) }
  .filter { let b = $0[kCGWindowBounds as String] as! [String: Double]; return b["Width"]! > 300 && b["Height"]! > 200 }
print(w.first?[kCGWindowNumber as String] as? Int ?? 0)' "$pid")
[ "$wid" != 0 ] || { kill "$pid"; echo "no jumplist window found" >&2; exit 1; }
screencapture -x -o -l "$wid" "$out/mac-$label.png"
kill "$pid" 2>/dev/null || true
echo "$out/mac-$label.png"
