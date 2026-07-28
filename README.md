# FUNI — Robinhood LP Operator

A safety-first TypeScript monorepo for a single-operator Uniswap v3 and v4 LP
operator on Robinhood Chain (chain ID `4663`) plus a reusable read-only
Robinhood infrastructure stack, a Telegram operator bot, registry/state-cache
workers, and an optional alert channel.

> **Status**
>
> Live execution is disabled by default. The shipped `.env.example` values
> keep every transaction path off until a human explicitly flips them after a
> complete preflight, deployment verification, and independent code-hash
> review. This repository is published for source review; it does not
> include any operational state, databases, secrets, or runtime
> identifiers.

## What is FUNI

FUNI is the public name of the Robinhood LP operator repository. The package
namespace, CLI command names, database tables, migrations, and runtime
identifiers are unchanged from the canonical Robin design. The word FUNI
appears only in the public-facing README and the repository name.

## Supported functionality

### Chain

- Robinhood Chain mainnet, chain ID `4663`, ETH gas.
- Public RPC and an Alchemy endpoint pool are both supported. The Alchemy
  pool is hot-swappable per process via the standard `ALCHEMY_RPC_URLS`
  comma list.

### Protocols

- **Uniswap v3** — pool discovery, position inspection, allowance audit,
  read-only fee estimation, and an end-to-end fork-based mint approval
  simulator.
- **Uniswap v4** — pool registry bootstrap and refresh, single-sided
  downside mint previews, persistent position view, operational open
  intents, target/funding swaps, full close, burn, exact-hash
  reconciliation, and rebalance lifecycle (preview → authorize → execute
  → complete).

### Pool registry

- Periodic bootstrap and refresh of a bounded set of pools
  (configurable window size and per-cycle limit) keyed by `poolId`.
- Per-pool validation status (`ELIGIBLE` / `BLOCKED`) and blocker reasons
  for downstream UI.

### Portfolio and external-position visibility

- `BOT_OPERATIONAL` positions opened and managed by this operator.
- `MANUAL_EXTERNAL` positions owned by the configured wallet but
  adopted from on-chain transfer history; visible but excluded from
  BOT-managed exposure accounting.
- `TRACKED` positions held for awareness without committed capital.
- Per-position live state, fee claimable, and historical PnL via a
  bounded two-minute portfolio snapshot, refreshed by a state-cache
  worker.

### Direct open, collect, close, burn, and rebalance lifecycle

- `v4-open-preflight` — read-only preview of a v4 single-sided downside
  mint.
- `v4-position-import` — adopt an on-chain v4 NFT into the local
  positions table and reconciliation queue.
- `v4-position-collect-preflight`, `v4-position-partial-close-preflight`,
  `v4-position-full-close-preflight` — read-only previews of collect,
  partial close, and full close.
- `v4-pnl-audit` — closed-position PnL computed from canonical
  principal-first accounting.
- Rebalance preview, authorization, and rebalance-resume flow with a
  durable SQLite-backed journal, projected funding allocation, and
  state-bound recovery for `FAILED_RECOVERABLE` workflows.
- Exact-hash reconciliation: `rebalance-exact-hash-reconcile` reconciles
  a confirmed on-chain broadcast whose engine journal still shows
  `PREPARED` (e.g. transient RPC error during a prior submit) and is
  the canonical durable fix.

### BOT_OPERATIONAL versus MANUAL_EXTERNAL

- `BOT_OPERATIONAL` positions are opened by the bot and contribute to
  the `BOT_MANAGED_EXPOSURE` aggregate.
- `MANUAL_EXTERNAL` positions are owned by the configured wallet but
  were not opened by the bot. They are visible in the portfolio and
  surface as "External" badges in the Telegram UX, and they are
  excluded from the BOT-managed exposure cap and from the rebalance
  candidate set. They never receive a `BOT_OPERATIONAL` mint in the
  backend.
- `TRACKED` positions are held for awareness without committed capital
  and never enter the rebalance path.

### BOT-managed exposure cap

- `MAX_BOT_MANAGED_EXPOSURE_USD` caps the aggregate of open and pending
  BOT-managed positions, including the projected reopen principal of any
  non-terminal rebalance workflow that lacks a confirmed replacement
  position. Per-position costs are derived from a fresh price reference;
  stale price references fail closed.

### Exact-hash transaction attribution and nonce safety

- Every broadcast is journaled in `rebalance_transactions` with the
  serialized request and the persisted hash.
- The engine re-queries the exact hash across the configured RPC pool
  after every send. A matching on-chain receipt reconciles the row to
  `CONFIRMED` in one transaction; a `PENDING` proof is monitored;
  an `ABSENT` proof fails closed without a blind retry.
- A per-wallet `nonce_mutex` row prevents concurrent broadcasts on the
  same nonce, even across process restarts. External activity on the
  same wallet is detected via `pending != latest` and the engine will
  not blindly rebroadcast.

### Dry-run and emergency safety

- `DRY_RUN=true` is the default. Pre-flight commands are the public
  path; broadcast commands require an explicit `EXECUTION_ENABLED=true`
  flip and a confirmed safety-state pass.
- `EMERGENCY_PAUSE=true` plus the durable `manualPause=true` row in
  `operator_safety_state` form a two-gate close.
- `safety-pause` and `safety-resume` require a literal reason string
  and a confirmation marker; the durable row is the authoritative
  source of truth at boot.

## Local installation

```
git clone <repository>
cd <repository>
npm ci
cp .env.example .env
# Edit .env to set RH_RPC_URL, ALCHEMY_RPC_URLS, and the rest of the
# placeholders. All values must be synthetic at first run; see
# .env.example for warnings.
npm run typecheck
npm test
```

The shipped `.env.example` resolves to:

- `EXECUTION_ENABLED=false`
- `DRY_RUN=true`
- `EMERGENCY_PAUSE=true`
- `LIVE_CANARY_ENABLED=false`
- `V4_LIVE_CANARY_ENABLED=false`
- Conservative limits on per-transaction gas, lifecycle gas, and
  slippage.

A live first run with a real wallet is **not** the documented path.
The canonical onboarding sequence is documented in
`docs/ROBINHOOD_RECON.md` and the deployment audit (`npm run cli --
deployment-audit --live`). Live execution is operator-class and requires
a complete preflight, deployment verification, and independent
code-hash review.

## Database initialization

The canonical database path is `${DATA_DIR}/robinhood-lp.sqlite`. The
migrations are append-only and numbered (`001_initial.sql` through the
highest `infra/migrations/*.sql`). Initialization is automatic on every
CLI invocation that opens the database:

```
npm run cli -- db-migrate   # explicit migrate + status
npm run cli -- db-status     # applied + pending migrations
npm run cli -- db-backup     # timestamped online backup via the SQLite backup API
```

A pre-`db-migrate` directory check is performed at boot; the CLI
will fail closed if the database is missing or unreadable.

## Typecheck and tests

```
npm run typecheck
npm test
```

The test suite is bounded to the canonical `*.test.ts` files in
`tests/`. Tests that require a local Anvil fork are gated on
`ANVIL_BIN`; tests that require a mainnet RPC are gated on the
`ALCHEMY_RPC_URLS` env var and will skip when unset. Live-only tests
are skipped during `npm test` in this public release; they are not
required to validate the public typecheck or the canonical unit
coverage.

## Operator model summary

- One operator, one Telegram bot, one configured wallet.
- `DEDICATED_WALLET_ADDRESS` (or `OPERATOR_WALLET` / `WALLET_ADDRESS`)
  is the only EOA used for both reads and (when execution is enabled)
  writes. The wallet must be a low-balance dedicated signer.
- `LP_PRIVATE_KEY` is the optional EOA private key. Leave empty in
  shared environments; use the platform's secret manager when needed.
- Telegram access is gated on `TELEGRAM_ALLOWED_USER_IDS`; the
  configured chat id is `ROBIN_TELEGRAM_CHAT_ID`.

## Repository layout

```
apps/
  cli/                 # public-safety CLI (db, runtime, wallet, preflight,
                      #   rebalance, exact-hash reconciliation, audit,
                      #   rebalance-commitment-release)
  shared/              # shared cross-app helpers (credential-isolation,
                      #   secret redaction)
  telegram-lp-bot/     # grammy-based operator bot (positions, portfolio,
                      #   range callbacks, persistence-first paint)
  workers/             # state-cache worker, v4 registry worker,
                      #   optional alert channel
packages/
  robinhood-core/      # RPC, health, v3 helpers, ERC-20 utilities
  uniswap-v3-adapter/  # v3 ticks/range/liquidity math, exec gates
  uniswap-v4-adapter/  # v4 poolId, sqrtPriceX, amounts, tick math
  lp-ledger/           # append-only event ledger, PnL accounting
  astra-robinhood-adapter/  # Robinhood-side observability adapter
infra/
  migrations/          # append-only SQL migrations
config/
  robinhood-v3-deployments.<block>.json   # pinned v3 deployment registry
docs/
  ROBINHOOD_RECON.md   # chain and v3 deployment audit (public addresses only)
tests/                 # canonical *.test.ts files
.env.example
.gitignore
package.json
package-lock.json
tsconfig.json
vitest.config.ts
```

## Known limitations

- Uniswap v4 support is gated on the pool's fee semantics and hook
  classification; pools with `dynamicFee` or unsupported hooks are
  reported as `BLOCKED` in the registry and excluded from
  previews.
- The rebalance executor is bounded to a single live execution window
  per workflow. `rebalance-resume` is the canonical recovery path for
  workflows that reach `FAILED_RECOVERABLE`; it never re-creates a
  preview.
- Telegram delivery is bounded to a single chat id per bot and
  requires `TELEGRAM_ALLOWED_USER_IDS` to contain the operator's user
  id. The bot will refuse to start otherwise.
- The state-cache and v4-registry workers use a bounded cadence and
  a bounded per-cycle batch limit. The default cadence is 60s for the
  state cache and 15s for the registry; both are configurable via
  `STATE_CACHE_CADENCE_MS` and `V4_REGISTRY_CADENCE_MS`.
- The exact-hash reconciliation require the RPC pool to return the
  same hash across the configured providers. Provider disagreement
  fails closed and surfaces as `INCONCISE:PROVIDER_DISAGREEMENT` on the
  preview.

## Disclaimers

- This is a personal, single-operator, dry-run-first LP tool. It is
  not a custodial product, not a multi-tenant service, and not a
  general-purpose trading bot. Do not deposit funds you cannot lose.
- Always pair a code update with a deployment audit, a fresh
  preflight, and a manual review of the `rebalance_*,` `v4_lifecycle_*`,
  and `v4_positions` journal for the target workflow.
- Public chain addresses, contract bytecodes, and pool identifiers
  referenced in this repository are recorded for transparency; they are
  not recommendations to interact with any specific contract or pool.

## License

No license is included. The operator has not selected a license for
this public release. All rights reserved by default until a license is
added.
