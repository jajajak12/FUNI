#!/usr/bin/env bash
set -euo pipefail

case "${MULTICHAIN_WORKER_ENTRYPOINT:?MULTICHAIN_WORKER_ENTRYPOINT is required}" in
  bsc-registry)
    entrypoint="apps/workers/src/bsc-registry-worker.ts"
    ;;
  bsc-state-cache)
    entrypoint="apps/workers/src/bsc-state-cache-worker.ts"
    ;;
  ethereum-registry)
    entrypoint="apps/workers/src/ethereum-registry-worker.ts"
    ;;
  ethereum-state-cache)
    entrypoint="apps/workers/src/ethereum-state-cache-worker.ts"
    ;;
  *)
    echo "unknown read-only worker entrypoint" >&2
    exit 64
    ;;
esac

exec env -i \
  PATH="${PATH:-/usr/bin:/bin}" \
  NODE_ENV="${NODE_ENV:-production}" \
  DATA_DIR="${DATA_DIR:-./data}" \
  DATABASE_PATH="${DATABASE_PATH:-./data/robinhood-lp.sqlite}" \
  BSC_ENABLED="${BSC_ENABLED:-false}" \
  BSC_EXECUTION_ENABLED="false" \
  BSC_DRY_RUN="true" \
  BSC_EMERGENCY_PAUSE="true" \
  BSC_RPC_URLS="${BSC_RPC_URLS:-}" \
  BSC_RPC_URL="${BSC_RPC_URL:-}" \
  BSC_CONFIRMATIONS="${BSC_CONFIRMATIONS:-}" \
  ETHEREUM_ENABLED="${ETHEREUM_ENABLED:-false}" \
  ETHEREUM_EXECUTION_ENABLED="false" \
  ETHEREUM_DRY_RUN="true" \
  ETHEREUM_EMERGENCY_PAUSE="true" \
  ETHEREUM_RPC_URLS="${ETHEREUM_RPC_URLS:-}" \
  ETHEREUM_RPC_URL="${ETHEREUM_RPC_URL:-}" \
  ETHEREUM_CONFIRMATIONS="${ETHEREUM_CONFIRMATIONS:-}" \
  MULTICHAIN_READ_ONLY_CADENCE_MS="${MULTICHAIN_READ_ONLY_CADENCE_MS:-60000}" \
  ./node_modules/.bin/tsx "$entrypoint"
