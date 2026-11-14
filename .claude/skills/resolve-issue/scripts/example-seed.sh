#!/usr/bin/env bash
# Seed sample data only: an exited owner with unread subagents, plus a live
# demo session for context. Usage: seed.sh <hub-url>
set -euo pipefail
url=${1:?hub url}
owner="claude:demo-refactor-parser"
now() { date -u -v-"$((120-$1))"S +%Y-%m-%dT%H:%M:%SZ; }
post() { curl -sf -X POST "$url/events" -H 'Content-Type: application/json' -d "$1" >/dev/null; }
ev() { # key event reason ts extra-json
  post "{\"v\":1,\"id\":\"$(uuidgen)\",\"ts\":\"$4\",\"host\":\"demo-mac\",\"agent\":\"claude\",\"event\":\"$2\",\"reason\":\"$3\",\"session_key\":\"$1\"${5:+,$5}}"
}
ev "$owner" busy "" "$(now 0)" '"title":"refactor-parser","cwd":"/work/parser","prompt":"split the tokenizer out of parser.ts and add tests"'
i=1
for a in "Explore:Mapped every call site of tokenize() - 14 across 6 files." \
         "general-purpose:Moved the tokenizer to tokenizer.ts and updated imports." \
         "test-runner:Added 22 tokenizer tests; all pass."; do
  type=${a%%:*}; reply=${a#*:}
  ev "$owner:agent:demo$i" busy session_start "$(now $((i*10)))" "\"title\":\"$type\",\"parent_session_key\":\"$owner\",\"parent_relation\":\"owned\""
  ev "$owner:agent:demo$i" done stop "$(now $((i*10+5)))" "\"title\":\"$type\",\"parent_session_key\":\"$owner\",\"parent_relation\":\"owned\",\"reply\":\"$reply\""
  i=$((i+1))
done
ev "$owner" done stop "$(now 50)" '"title":"refactor-parser","reply":"Tokenizer split out with tests. You can close this session."'
ev "claude:demo-schema-migration" busy "" "$(now 55)" '"title":"schema-migration","cwd":"/work/api","prompt":"migrate the users table to add a timezone column"'
# The user types /exit: Claude fires SessionEnd, the adapter maps it to hide.
ev "$owner" hide session_end "$(now 60)"
