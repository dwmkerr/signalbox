#!/usr/bin/env bash
# Seed a synthetic board for screenshots and recordings, using the public
# `signalbox fire` path - the same integration point any script or CI run uses.
# Neutral names, every status colour, across claude/opencode/pi/github.
#
#   components/scripts/demo.sh          seed the board, then press ⌃⌥J
#   components/scripts/demo.sh --clear  take the demo sessions off the board
#
# Every session is tagged `demo` (via its key prefix) so --clear removes only
# these, never real work. Fire captures the pane origin when run inside tmux, so
# run it from your recording pane if you want jump to route back.
set -euo pipefail

sb=${SIGNALBOX:-signalbox}

# session_key -> the demo sessions, so --clear can find them without a tag flag.
keys=(
  "claude:demo-fix-auth-token-expiry"
  "claude:demo-schema-migration"
  "opencode:demo-release-notes"
  "claude:demo-flaky-test-hunt"
  "pi:demo-crash-analysis"
  "github:demo-deploy"
)

if [[ "${1:-}" == "--clear" ]]; then
  for k in "${keys[@]}"; do "$sb" session remove "$k" || true; done
  echo "removed ${#keys[@]} demo session(s)"
  exit 0
fi

# One amber (asking), two done, one working, one failed - the whole grammar.
"$sb" fire --agent claude --event busy --session-key "${keys[0]}" \
  --title fix-auth-token-expiry --prompt "auth tokens seem to expire a second early - take a look?"
"$sb" fire --agent claude --event attention --reason permission_prompt --session-key "${keys[0]}" \
  --title fix-auth-token-expiry \
  --reply "The expiry check uses \`<\` where it should use \`<=\`. Shall I change it and add a regression test?"

"$sb" fire --agent claude --event busy --session-key "${keys[1]}" \
  --title schema-migration --prompt "migrate the users table to add a timezone column"

"$sb" fire --agent opencode --event done --reason stop --session-key "${keys[2]}" \
  --title release-notes --prompt "draft the 0.2.0 release notes from the changelog" \
  --reply "Draft ready in RELEASE_NOTES.md - three sections, sixteen entries, and a short highlights paragraph."

"$sb" fire --agent claude --event error --reason usage_limit --session-key "${keys[3]}" \
  --title flaky-test-hunt --prompt "find and fix the flaky test in the checkout suite" \
  --reply "Usage limit reached - resets in 42 minutes."

"$sb" fire --agent pi --event done --reason idle --session-key "${keys[4]}" \
  --title crash-analysis --prompt "analyse last night's crash dumps" \
  --reply "Found it: an unhandled promise rejection in the upload retry path. Patch proposed in retry.ts."

"$sb" fire --agent github --event done --session-key "${keys[5]}" \
  --title "deploy · ci.yml" --prompt "push to main (b41c2f9) triggered deploy" \
  --reply "Run #9182 succeeded in 4m 12s - site deployed, 2 artifacts." \
  --origin-url "https://github.com/dwmkerr/signalbox/actions/runs/9182"

echo "seeded ${#keys[@]} demo sessions - press ⌃⌥J to see the board"
echo "clear them with: components/scripts/demo.sh --clear"
