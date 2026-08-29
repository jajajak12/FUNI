#!/usr/bin/env bash
set -euo pipefail
data_dir="${DATA_DIR:?DATA_DIR is required}"
mkdir -p "$data_dir/logs"
chmod 700 "$data_dir" "$data_dir/logs"
exec ./node_modules/.bin/tsx apps/telegram-lp-bot/src/index.ts
