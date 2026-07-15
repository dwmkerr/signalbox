#!/usr/bin/env bash
# Link the signalbox pi extension into pi's global auto-discovery directory.
# Safe to re-run: ln -sf replaces any existing link.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signalbox.ts"
DEST_DIR="$HOME/.pi/agent/extensions"
DEST="$DEST_DIR/signalbox.ts"

mkdir -p "$DEST_DIR"
ln -sf "$SRC" "$DEST"

echo "Linked $DEST -> $SRC"
echo "Reload pi with /reload (or restart) to pick it up."
