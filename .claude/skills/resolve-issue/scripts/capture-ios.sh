#!/usr/bin/env bash
# capture-ios.sh <label> <signalbox-cli> <ios-app> <seed-script> <out-dir>
# Isolated hub + seed, then the booted Simulator's app pointed at it.
# Writes <out-dir>/ios-<label>.png. The app's hubURL default is restored after.
set -euo pipefail
label=$1 sb=$2 app=$3 seed=$4 out=$5
here=$(cd "$(dirname "$0")" && pwd)
bundle=com.dwmkerr.signalbox.ios
run="$out/run-ios-$label"; rm -rf "$run"
hub=$("$here/start-hub.sh" "$sb" "$run")
prev=$(xcrun simctl spawn booted defaults read $bundle hubURL 2>/dev/null || true)
restore() {
  kill $hub 2>/dev/null || true
  xcrun simctl terminate booted $bundle 2>/dev/null || true
  xcrun simctl status_bar booted clear 2>/dev/null || true
  if [ -n "$prev" ]; then xcrun simctl spawn booted defaults write $bundle hubURL "$prev"; fi
}
trap restore EXIT
source "$here/isolated-env.sh" "$run"
"$seed" "$SIGNALBOX_URL"
xcrun simctl install booted "$app"
xcrun simctl spawn booted defaults write $bundle hubURL "$SIGNALBOX_URL"
xcrun simctl ui booted appearance dark
xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl terminate booted $bundle 2>/dev/null || true
xcrun simctl launch booted $bundle >/dev/null
python3 -c 'import time; time.sleep(5)'
xcrun simctl io booted screenshot "$out/ios-$label.png" >/dev/null 2>&1
echo "$out/ios-$label.png"
