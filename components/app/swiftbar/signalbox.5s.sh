#!/usr/bin/env bash
# <xbar.title>Signalbox</xbar.title>
# <xbar.desc>Live agent session board - click a row to jump to its tmux pane.</xbar.desc>
# <xbar.dependencies>signalbox,jq,curl</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
set -o pipefail

# SwiftBar's PATH can be minimal: add the usual install locations so both jq
# (/usr/bin on macOS) and the signalbox lookup below resolve.
PATH="/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

SIGNALBOX="${SIGNALBOX_BIN:-$(command -v signalbox || true)}"

URL="${SIGNALBOX_URL:-http://127.0.0.1:8377}"

if [ ! -x "$SIGNALBOX" ]; then
  echo "🚦"
  echo "---"
  echo "signalbox binary not found | color=red"
  echo "Set SIGNALBOX_BIN or build with make build | size=11"
  exit 0
fi

# Probe the hub directly so a dead hub renders as a calm offline state
# rather than an empty or erroring menu.
if ! curl -fsS --max-time 1 "$URL/healthz" >/dev/null 2>&1; then
  echo "🚦"
  echo "---"
  echo "hub offline ($URL) | color=gray"
  echo "Start it: signalbox hub | bash=$SIGNALBOX param0=hub terminal=true refresh=true"
  exit 0
fi

# One /state fetch feeds both the header and the rows so they can't disagree.
state_json="$("$SIGNALBOX" state --json 2>/dev/null)"

# Header: per-glyph counts of *unacked* needs-you rows (e.g. "2🔴 1🟢"), the
# same convention as the menu bar app. Acked rows are dealt-with, so they
# must not pull the eye; nothing waiting → bare icon.
header="$(jq -r '
  def unacked(t): [.sessions[]? | select(.event == t and (.acked != true))] | length;
  [ (unacked("attention") | select(. > 0) | "\(.)🔴"),
    (unacked("error")     | select(. > 0) | "\(.)🟠"),
    (unacked("done")      | select(. > 0) | "\(.)🟢") ]
  | join(" ")
' <<<"$state_json" 2>/dev/null)"
echo "${header:-🚦}"
echo "---"

# Rows arrive already in contract order (needs-you band, then working/seen).
# Status words make rows self-documenting (no legend); acked rows keep their
# word but render dim. detail (the cropped last user prompt) is a dim
# non-clickable second line. "|" is SwiftBar's param separator, so strip it
# from user-controlled text.
rows="$(jq -r --arg bin "$SIGNALBOX" '
  def glyph: {attention: "🔴", error: "🟠", done: "🟢", busy: "⏳", ended: "⚪"}[.event] // "•";
  def word: {attention: "needs you", error: "error", done: "ready", busy: "working"}[.event] // .event;
  def safe: gsub("\\|"; "¦");
  .sessions[]?
  | (if .acked == true then " color=gray" else "" end) as $dim
  | "\(glyph) \(word)  \(.agent)  \(.title // (.cwd // .session_key | split("/") | last) | safe) | bash=\($bin) param0=jump param1=\(.session_key) terminal=false refresh=true\($dim)",
    (.detail // empty | "\(safe) | size=10 color=gray")
' <<<"$state_json" 2>/dev/null)"

if [ -n "$rows" ]; then
  echo "$rows"
else
  echo "no sessions | color=gray"
fi
