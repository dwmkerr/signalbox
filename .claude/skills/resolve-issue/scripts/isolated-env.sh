#!/usr/bin/env bash
# Source this: points every signalbox process at a throwaway hub that cannot
# see the operator's board, config, upstream token or transcripts.
#   source isolated-env.sh <run-dir>
run=${1:?run dir}
mkdir -p "$run/home" "$run/state"
export HOME="$run/home"                   # hub scans ~/.claude and ~/.codex via homedir()
export SIGNALBOX_DATA_DIR="$run/state"
export SIGNALBOX_CONFIG="$run/none.json"  # missing file = defaults, so no upstream/token
export SIGNALBOX_URL="http://127.0.0.1:8399"
export SIGNALBOX_SEARCH=0
