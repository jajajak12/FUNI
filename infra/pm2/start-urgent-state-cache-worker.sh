#!/usr/bin/env bash
set -euo pipefail
unset LP_PRIVATE_KEY LP_MNEMONIC SEED_PHRASE MNEMONIC
exec ./node_modules/.bin/tsx apps/workers/src/urgent-state-cache-worker.ts
