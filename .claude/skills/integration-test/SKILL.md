---
name: integration-test
description: >
  Run the signalbox end-to-end integration evidence run: build the CLI, drive
  the hub / LAN mode / remote mode / forwarder / hooks / app through real
  commands with shellwright, screenshot every step, and assemble a
  self-contained HTML report. Use when the user says "run the integration
  test", "/integration-test", or wants an evidence run with a report.
---

# signalbox integration evidence run

This is an evidence-gathering run, not a strict test suite. Every step runs
best-effort: if a step fails or times out, record what happened (output +
screenshot + verdict `fail` or `warn`) and move on. Never abort the run.
The deliverable is a single self-contained HTML report with screenshots.

Expect the full run to take a long time - that is fine, it is designed as an
overnight run.

## Conventions (read first)

**Paths and environment.** All commands run from the repo root. One evidence
dir per run:

```bash
EVIDENCE="$PWD/scratch/integration/run-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE"
SB="$PWD/components/cli/bin/signalbox"
```

Every shell (shellwright sessions included) exports the test environment so
the run never touches the real board:

```bash
export SIGNALBOX_DATA_DIR="$EVIDENCE/state"
export SIGNALBOX_CONFIG="$EVIDENCE/settings.json"
export SIGNALBOX_URL="http://127.0.0.1:8399"
```

`SIGNALBOX_CONFIG` matters as much as the data dir: without it the hub reads
the user's real `~/.config/signalbox/settings.json`, and a real
`hub.upstream`/`hub.token` will leak into the test (the first hub start comes
up as a forwarder to their remote). Pointing it at a non-existent file in the
evidence dir means pure defaults.

Ports for this run: `8399` local hub, `8410` remote/upstream hub, `8420`
forwarder. Space them out: LAN mode opens a second TLS listener on **port+1**
(8399 -> https on 8400, pinned self-signed cert), so adjacent ports collide.
Token for authenticated scenarios: `itest-token`.

**Evidence per step.** Each step gets a directory `$EVIDENCE/NN-slug/`
containing:

- `meta.json` - `{"title": "...", "verdict": "pass|warn|fail", "commands": ["..."], "notes": "one or two sentences: what was checked, what the evidence shows"}`
- `output.txt` - captured command output (optional but preferred)
- `*.png` - screenshots, in the order they should appear

Screenshots of shell sessions come from shellwright's `shell_screenshot`;
save or copy the PNG into the step dir. Screenshots of the app come from
`screencapture` (see the app step).

**Timing.** Best effort. When waiting for output (hub startup, event
propagation), poll `shell_read` every 1-2s up to ~15s rather than sleeping a
fixed time. On timeout: screenshot anyway, verdict `warn`, continue.

**Run metadata.** At setup, write `$EVIDENCE/run.json`:

```bash
printf '{"started":"%s","commit":"%s","branch":"%s"}\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "$(git rev-parse --short HEAD)" \
  "$(git rev-parse --abbrev-ref HEAD)" > "$EVIDENCE/run.json"
```

## Step 01 - build

```bash
make build
```

Evidence: build output tail, `$SB --version` (or `$SB help | head -3`) showing
the fresh binary. Also build the app bundle now so step 10 can use it (do not
launch it yet):

```bash
make -C components/app app
```

Use the `app` target, NOT `build`: `build` only compiles Swift, while `app`
rebuilds the bundle and embeds the fresh CLI at Contents/Resources/signalbox -
a stale embed means the app-spawned hub reports the wrong version. App build
failure is a `warn` on this step (the CLI scenarios still run) and turns
step 10 into a `fail`.

## Step 02 - local hub starts

Start a shellwright shell ("hub") with the test env exported, then:

```bash
$SB hub --port 8399
```

Poll until the startup banner appears. Screenshot the hub shell. In a second
shellwright shell ("client", same env):

```bash
curl -s http://127.0.0.1:8399/healthz
$SB state
```

Evidence: healthz response, empty board, both screenshots.

## Step 03 - seed the board

In the client shell:

```bash
SIGNALBOX="$SB" components/scripts/demo.sh
$SB state
```

Evidence: the seeded board showing every status colour (busy / attention /
done / error). Screenshot `$SB state` output. Also capture `$SB state --json`
head into `output.txt` as machine-readable evidence.

## Step 04 - session operations

In the client shell, exercise the session verbs against a seeded session key
(e.g. `claude:demo-schema-migration`):

```bash
$SB session pin claude:demo-schema-migration
$SB session rename claude:demo-schema-migration "renamed by itest"
$SB session ack claude:demo-fix-auth-token-expiry
$SB session hide pi:demo-crash-analysis
$SB state
$SB session show pi:demo-crash-analysis
$SB state
```

Evidence: board screenshots showing the pin at top, the rename, the hidden
row gone then back.

## Step 05 - claude hook path

In the client shell, feed canned Claude Code hook payloads through the real
adapter entry point (fields per `components/cli/src/claude.ts`: ClaudeHook):

```bash
echo '{"hook_event_name":"SessionStart","session_id":"itest-hook","cwd":"'"$PWD"'"}' | $SB hook claude
$SB state
echo '{"hook_event_name":"Stop","session_id":"itest-hook","cwd":"'"$PWD"'"}' | $SB hook claude
$SB state
```

Evidence: session appears busy after SessionStart, done after Stop.
Hook commands must exit 0 even on failure - note the exit codes.

## Step 06 - real agent via shellwright (optional, long)

Only if Claude Code hooks are installed for signalbox (check
`~/.claude/settings.json` for `signalbox hook claude`). Start a shellwright
shell with the test env, run `claude`, send a trivial prompt ("say hi and
stop"), wait for the turn to end, then check `$SB state` shows the session
go busy then done. Screenshot the agent mid-turn and the board after.

If hooks are not installed, record the step as `warn` with a note and move on.

## Step 07 - LAN mode (bind + token)

Stop the hub (Ctrl-C in the hub shell), restart it bound wide with a token:

```bash
SIGNALBOX_TOKEN=itest-token $SB hub --port 8399 --bind 0.0.0.0
```

This keeps loopback plain-http on 8399 and opens the TLS LAN listener on
port+1 (https on 8400, pinned self-signed - hence `curl -k`). From the client
shell, find the LAN IP (`ipconfig getifaddr en0` or equivalent), then gather:

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://<lan-ip>:8400/state          # expect 401
curl -sk -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer itest-token' https://<lan-ip>:8400/state   # expect 200
curl -s http://127.0.0.1:8399/healthz                   # loopback still fine, mode:lan
```

Then pairing: in the client shell run

```bash
SIGNALBOX_TOKEN=itest-token $SB pair
```

and screenshot the QR screen (Ctrl-C out of it after the screenshot).

Evidence: the 401/200 pair proves token enforcement; the QR screenshot proves
pairing renders.

## Step 08 - remote mode

In a third shellwright shell ("remote", same env). Give it its own data dir
so its board is not shared with the local hub's:

```bash
SIGNALBOX_DATA_DIR="$EVIDENCE/state-remote" \
  SIGNALBOX_TOKEN=itest-token $SB hub --remote --port 8410
```

From the client shell:

```bash
curl -s http://127.0.0.1:8410/healthz                                   # open
curl -si http://127.0.0.1:8410/state | head -5                          # 401 - remote authenticates everything
SIGNALBOX_URL=http://127.0.0.1:8410 SIGNALBOX_TOKEN=itest-token \
  $SB fire --agent claude --event busy --session-key itest:remote --title remote-check
SIGNALBOX_URL=http://127.0.0.1:8410 SIGNALBOX_TOKEN=itest-token $SB state
```

Evidence: healthz open, state 401 without token, fired event visible with
token.

## Step 09 - forwarder and spool replay

Keep the remote hub (8410) running as upstream. Restart the hub shell as a
forwarder with its own data dir (spool + read replica live there):

```bash
SIGNALBOX_DATA_DIR="$EVIDENCE/state-fwd" \
  SIGNALBOX_TOKEN=itest-token $SB hub --port 8420 --upstream http://127.0.0.1:8410
```

From the client shell:

```bash
SIGNALBOX_URL=http://127.0.0.1:8420 $SB fire --agent claude --event busy --session-key itest:fwd --title fwd-check
SIGNALBOX_URL=http://127.0.0.1:8420 $SB state                                        # read replica shows it
SIGNALBOX_URL=http://127.0.0.1:8410 SIGNALBOX_TOKEN=itest-token $SB state            # upstream shows it
```

Then the spool: Ctrl-C the remote hub (8410), fire again at the forwarder
(must still succeed and exit 0 - it spools to `state-fwd/forward-spool.jsonl`;
`ls` it as evidence). Note the spooled event does NOT appear on the read
replica while the upstream is down - the replica mirrors upstream. Screenshot
the forwarder shell log (drain retry errors are good evidence), restart the
remote hub, and poll upstream state until the spooled event appears.

Evidence: event at both layers, fire-while-upstream-down succeeding, the spool
file, replay arriving after restart. This is the core remote-hub story -
screenshot generously.

## Step 10 - the app

Note: the app spawns its own hub on the default port with the default state
dir - this scenario touches the real board, which is acceptable.

```bash
open components/app/build/Signalbox.app
sleep 5
```

If the app was already running (the user's real instance), quit it first with
`osascript -e 'quit app "Signalbox"'` so the relaunch picks up the fresh
bundle - and note in the report that the user's app was restarted. Verify the
embedded CLI is fresh: `curl -s http://127.0.0.1:8377/healthz` must report the
version just built, not an older one.

Screenshots via `screencapture` (needs Screen Recording permission for this
terminal; the jumplist hotkey needs Accessibility - if either is missing,
verdict `warn` with a note, do not block):

```bash
screencapture -x "$EVIDENCE/10-app/menubar.png"        # full screen incl. menu bar icon
osascript -e 'tell application "System Events" to key code 38 using {control down, option down}'  # ⌃⌥J jumplist
sleep 1
screencapture -x "$EVIDENCE/10-app/jumplist.png"
```

Evidence: menu bar icon present, jumplist rendering the board.

## Step 10b - the iOS app (Simulator)

Prove phone-to-hub end to end: the iOS app in the Simulator connecting to the
test hub and rendering the seeded board. Simulator loopback IS the Mac's
loopback, so the app reaches the test hub with no pairing.

Note: `xcrun simctl` talks to the CoreSimulator service and typically needs
the sandbox disabled on these Bash calls. No booted simulator / no iOS
runtime installed = verdict `warn` with a note, move on.

```bash
# a booted device, or boot one
xcrun simctl list devices booted
xcrun simctl boot "iPhone 17 Pro"   # if none booted (any available iPhone works)

# build for the Simulator - do NOT pipe xcodebuild straight into tail/grep and
# move on: the pipe swallows a failure and you install a stale app. Check for
# BUILD SUCCEEDED explicitly.
cd components/ios && xcodebuild -project Signalbox.xcodeproj -scheme Signalbox \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath ../../scratch/ios-dd build

# the local hub (8399) was repurposed as a forwarder in step 09 - restart it
# in the hub shell with the test env; the seeded board replays from events.jsonl
$SB hub --port 8399

# install, point at the test hub, launch
APP=scratch/ios-dd/Build/Products/Debug-iphonesimulator/Signalbox.app
xcrun simctl install booted "$APP"
xcrun simctl spawn booted defaults write com.dwmkerr.signalbox.ios hubURL "http://127.0.0.1:8399"
xcrun simctl terminate booted com.dwmkerr.signalbox.ios 2>/dev/null
xcrun simctl launch booted com.dwmkerr.signalbox.ios
sleep 3
xcrun simctl io booted screenshot "$EVIDENCE/10b-ios/sessions.png"
```

After install, verify the sim runs the build you just made (the stale-install
trap): `md5 -q "$(xcrun simctl get_app_container booted com.dwmkerr.signalbox.ios)/Signalbox" "$APP/Signalbox"`
must match.

Evidence: the sessions page showing the green "Connected to 127.0.0.1" line
and the seeded board rows. A screenshot right after launch (before the 3s
sleep) additionally captures the quiet "Connecting..." state.

## Step 10c - dropdown overflow

Seed at least 12 sessions against the app's own hub on port 8377. The demo
seed provides six sessions; add distinct sessions so the overflow cap engages:

```bash
mkdir -p "$EVIDENCE/10c-dropdown-overflow" || true
SIGNALBOX_URL=http://127.0.0.1:8377 components/scripts/demo.sh || true
for session_number in 01 02 03 04 05 06 07; do
  SIGNALBOX_URL=http://127.0.0.1:8377 $SB fire --agent claude --event busy \
    --session-key "itest:overflow-$session_number" --title "overflow-$session_number" || true
done

osascript -e 'tell application "System Events" to tell process "Signalbox" to click menu bar item 1 of menu bar 2' || true
sleep 1
screencapture -x "$EVIDENCE/10c-dropdown-overflow/dropdown.png" || true

osascript -e 'tell application "System Events" to tell process "Signalbox" to perform action "AXShowMenu" of first menu item of menu 1 of first menu bar item of menu bar 2 whose name starts with "Show More"' || true
sleep 1
screencapture -x "$EVIDENCE/10c-dropdown-overflow/show-more.png" || true
```

If Accessibility or Screen Recording permission is missing, or the menu bar
script cannot open the menu or submenu, record a `warn` with a note and move
on. Evidence: the first screenshot shows exactly 10 inline rows in board order,
followed by `Show More (N)` before the separator; the second shows the
remainder in the opened submenu.

## Step 10d - logs pane

Open Settings, select Logs, and capture the pane as soon as it opens. Use
Accessibility scripting for the toolbar click; if it proves unreliable, select
Logs manually and record that in the step note:

```bash
mkdir -p "$EVIDENCE/10d-logs-pane" || true
# The keystroke goes to the frontmost app, so bring Signalbox forward first.
osascript -e 'tell application "Signalbox" to activate' || true
sleep 1
osascript -e 'tell application "System Events" to key code 43 using {command down}' || true
sleep 1
osascript -e 'tell application "System Events" to tell process "Signalbox" to click button "Logs" of toolbar 1 of window 1' || true
sleep 1
screencapture -x "$EVIDENCE/10d-logs-pane/logs-current.png" || true

# Only toggle when the original appearance is known - toggling blind would
# leave the user's system flipped with nothing to restore to.
ORIGINAL_DARK_MODE="$(osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode' 2>/dev/null || true)"
printf 'original dark mode: %s\n' "${ORIGINAL_DARK_MODE:-unknown}" > "$EVIDENCE/10d-logs-pane/appearance.txt"
case "$ORIGINAL_DARK_MODE" in
  true|false)
    osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode' || true
    sleep 1
    screencapture -x "$EVIDENCE/10d-logs-pane/logs-opposite-appearance.png" || true
    osascript -e "tell application \"System Events\" to tell appearance preferences to set dark mode to $ORIGINAL_DARK_MODE" || true
    ;;
  *) printf 'appearance state unreadable; opposite-appearance capture skipped (warn)\n' >> "$EVIDENCE/10d-logs-pane/appearance.txt" ;;
esac
```

If Settings, appearance scripting, or screen capture fails, record a `warn`
with a note and continue. Evidence: the Logs tail shows the newest lines, the
timestamp column is visible, and the horizontal scroller is at the left, not
mid-line. Both screenshots must be readable with no grey-on-white or
black-on-black rendering. Restore the original system appearance.

## Step 10e - shortcut recorder and migration

Capture Settings -> General with the recorder idle and the current shortcut's
glyphs visible. Try the UI route first:

```bash
mkdir -p "$EVIDENCE/10e-shortcut-recorder" || true
# Snapshot the whole defaults domain before touching anything. The recorded
# shortcut is stored as Data, which per-key defaults read/write cannot
# round-trip - export/import round-trips every type.
defaults export com.dwmkerr.signalbox "$EVIDENCE/10e-shortcut-recorder/signalbox-defaults-backup.plist" || true

# The keystroke goes to the frontmost app, so bring Signalbox forward first.
osascript -e 'tell application "Signalbox" to activate' || true
sleep 1
osascript -e 'tell application "System Events" to key code 43 using {command down}' || true
sleep 1
osascript -e 'tell application "System Events" to tell process "Signalbox" to click button "General" of toolbar 1 of window 1' || true
sleep 1
screencapture -x "$EVIDENCE/10e-shortcut-recorder/recorder-idle.png" || true
```

Setting a combination through the recorder needs real keystrokes into the
focused field; if that proves unreliable under `osascript`, record it as a
manual step in the report rather than simulating it another way.

Test migration with the app quit. The domain snapshot above is the restore
mechanism:

```bash
osascript -e 'tell application "Signalbox" to quit' || true
sleep 1
defaults delete com.dwmkerr.signalbox KeyboardShortcuts_openJumplist 2>/dev/null || true
defaults write com.dwmkerr.signalbox hotkey "cmd+shift+space" || true
open components/app/build/Signalbox.app || true
sleep 3
# The migrated value is Data holding JSON; defaults read prints a hex dump, so
# decode it back to text before asserting on the JSON keys.
defaults read com.dwmkerr.signalbox KeyboardShortcuts_openJumplist 2>/dev/null \
  | tr -d ' <>\n' | xxd -r -p \
  | tee "$EVIDENCE/10e-shortcut-recorder/migration-readback.txt" || true

osascript -e 'tell application "Signalbox" to activate' || true
sleep 1
osascript -e 'tell application "System Events" to key code 43 using {command down}' || true
sleep 1
osascript -e 'tell application "System Events" to tell process "Signalbox" to click button "General" of toolbar 1 of window 1' || true
sleep 1
screencapture -x "$EVIDENCE/10e-shortcut-recorder/migration-recorder.png" || true

# Restore the user's real preferences from the snapshot, whatever their types.
osascript -e 'tell application "Signalbox" to quit' || true
sleep 1
defaults import com.dwmkerr.signalbox "$EVIDENCE/10e-shortcut-recorder/signalbox-defaults-backup.plist" || true
open components/app/build/Signalbox.app || true
```

Evidence: the idle recorder screenshot shows the shortcut glyphs; the decoded
migration readback contains `carbonKeyCode` 49 and `carbonModifiers` 768,
which decode to ⌘⇧Space, and the migration screenshot shows the same. If the
key, permissions, or any recorder operation fails, record a `warn` with a
note and continue to the `defaults import` restoration. Note that the user's
defaults domain was restored from the snapshot.

## Step 11 - teardown

Best effort: restore the original system appearance (10d) and the user's
defaults domain via `defaults import` from the 10e snapshot if those steps
changed them, then Ctrl-C / `shell_stop` every
shellwright session, quit the app (`osascript -e 'quit app "signalbox"'` -
adjust to the real app name), terminate the Simulator app (`xcrun simctl terminate booted
com.dwmkerr.signalbox.ios`), and note anything left running. When killing a
hub by pattern, use `kill $(lsof -ti :PORT)` - a `pkill -f` whose pattern
appears in your own command line kills your own shell.

## Step 12 - report

```bash
python3 .claude/skills/integration-test/build-report.py "$EVIDENCE"
open "$EVIDENCE/report.html"
```

The report is fully self-contained (screenshots base64-inlined) - safe to
copy anywhere. Finish by telling the user the pass/warn/fail counts and the
report path.
