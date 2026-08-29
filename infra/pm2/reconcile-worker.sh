#!/usr/bin/env bash
set -euo pipefail
data_dir="${DATA_DIR:?DATA_DIR is required}"
mkdir -p "$data_dir/logs"
chmod 700 "$data_dir" "$data_dir/logs"
while true; do
  if ./node_modules/.bin/tsx apps/cli/src/index.ts reconcile-all; then
    cycle_status=0
  else
    cycle_status=$?
  fi
  if [[ "$cycle_status" -ne 0 && "$cycle_status" -ne 75 ]]; then
    exit "$cycle_status"
  fi
  sleep 300
done
