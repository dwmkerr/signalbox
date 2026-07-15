#!/usr/bin/env bash
# Link the signalbox opencode plugin into the global plugin directory.
# Safe to re-run: ln -sf replaces any existing link.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/signalbox.js"
DEST_DIR="$HOME/.config/opencode/plugin"
DEST="$DEST_DIR/signalbox.js"

mkdir -p "$DEST_DIR"
ln -sf "$SRC" "$DEST"

echo "Linked $DEST -> $SRC"
echo "Note: this replaces the tmux side-effects of tmux-notify.js - remove"
echo "that plugin once signalbox is working to avoid double notifications."
