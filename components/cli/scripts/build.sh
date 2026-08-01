#!/usr/bin/env bash
# Compile the CLI with its build provenance stamped in. A dev binary and a
# released one otherwise print the same version, which made two real
# version-skew hunts blind. SIGNALBOX_BUILD from the environment wins so CI
# can stamp a tag; otherwise git describes the working tree.
set -euo pipefail
cd "$(dirname "$0")/.."

stamp="${SIGNALBOX_BUILD:-}"
if [ -z "$stamp" ]; then
  stamp="$(git describe --always --dirty --tags 2>/dev/null || true)"
fi
[ -n "$stamp" ] || stamp="unknown"
# The stamp becomes a single-quoted JS literal in the define below. Strip
# backslashes too: a trailing one would escape the literal's closing quote.
stamp="${stamp//\\/}"
stamp="${stamp//\'/}"

out="${OUTFILE:-bin/signalbox}"

if [ -n "${BUN_TARGET:-}" ]; then
  BUN_NO_CODESIGN_MACHO_BINARY=1 bun build --compile --minify \
    --target="$BUN_TARGET" \
    --define "process.env.SIGNALBOX_BUILD='$stamp'" \
    src/main.ts --outfile "$out"
else
  BUN_NO_CODESIGN_MACHO_BINARY=1 bun build --compile --minify \
    --define "process.env.SIGNALBOX_BUILD='$stamp'" \
    src/main.ts --outfile "$out"
fi

# Darwin hosts can cross-compile non-Mach-O binaries, which codesign rejects.
if [ "$(uname)" = "Darwin" ] && [[ "${BUN_TARGET:-}" == "" || "${BUN_TARGET:-}" == bun-darwin* ]]; then
  codesign --force --sign - "$out"
fi
