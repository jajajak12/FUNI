const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");

const rootDir = path.resolve(__dirname, "../..");
const envPath = process.env.FUNI_ENV_FILE
  ? path.resolve(process.env.FUNI_ENV_FILE)
  : path.join(rootDir, ".env");
const configured = fs.existsSync(envPath)
  ? dotenv.parse(fs.readFileSync(envPath))
  : {};
const value = (name, fallback = "") =>
  configured[name] ?? process.env[name] ?? fallback;
const enabled = (name) => /^(true|1|yes|on)$/i.test(value(name, "false"));
const dataDir = path.resolve(value("DATA_DIR", path.join(rootDir, "data")));
const databasePath = path.resolve(
  value("DATABASE_PATH", path.join(dataDir, "funi.sqlite")),
);

const readOnlyEnv = {
  NODE_ENV: "production",
  DATA_DIR: dataDir,
  DATABASE_PATH: databasePath,
  ALCHEMY_RPC_URL: value("ALCHEMY_RPC_URL"),
  ALCHEMY_RPC_URLS: value("ALCHEMY_RPC_URLS"),
  RH_LOGS_RPC_URL: value(
    "RH_LOGS_RPC_URL",
    "https://rpc.mainnet.chain.robinhood.com",
  ),
  WALLET_ADDRESS: value("WALLET_ADDRESS"),
  OPERATOR_WALLET: value("OPERATOR_WALLET"),
  DEDICATED_WALLET_ADDRESS: value("DEDICATED_WALLET_ADDRESS"),
  LP_PRIVATE_KEY: "",
  LP_MNEMONIC: "",
  SEED_PHRASE: "",
  MNEMONIC: "",
  EXECUTION_ENABLED: "false",
  DRY_RUN: "true",
  EMERGENCY_PAUSE: "true",
  LIVE_CANARY_ENABLED: "false",
  V4_LIVE_CANARY_ENABLED: "false",
};

function app(name, script, env, memory = "250M") {
  return {
    name,
    cwd: rootDir,
    script,
    interpreter: "/bin/bash",
    instances: 1,
    autorestart: true,
    restart_delay: 3000,
    max_restarts: 20,
    max_memory_restart: memory,
    kill_timeout: 15000,
    env,
    out_file: path.join(dataDir, `logs/${name}.out.json`),
    error_file: path.join(dataDir, `logs/${name}.error.json`),
    merge_logs: true,
    time: true,
    filter_env: ["NOVA_", "GMGN_API_KEY"],
  };
}

const apps = [
  app(
    "funi-telegram",
    "infra/pm2/start-telegram.sh",
    {
      NODE_ENV: "production",
      DATA_DIR: dataDir,
      DATABASE_PATH: databasePath,
      FUNI_TELEGRAM_BOT_TOKEN: value("FUNI_TELEGRAM_BOT_TOKEN"),
      FUNI_TELEGRAM_CHAT_ID: value("FUNI_TELEGRAM_CHAT_ID"),
      TELEGRAM_ALLOWED_USER_IDS: value("TELEGRAM_ALLOWED_USER_IDS"),
      ALCHEMY_RPC_URL: value("ALCHEMY_RPC_URL"),
      ALCHEMY_RPC_URLS: value("ALCHEMY_RPC_URLS"),
      RH_LOGS_RPC_URL: value(
        "RH_LOGS_RPC_URL",
        "https://rpc.mainnet.chain.robinhood.com",
      ),
      WALLET_ADDRESS: value("WALLET_ADDRESS"),
      OPERATOR_WALLET: value("OPERATOR_WALLET"),
      DEDICATED_WALLET_ADDRESS: value("DEDICATED_WALLET_ADDRESS"),
      LP_PRIVATE_KEY: value("LP_PRIVATE_KEY"),
      GMGN_API_KEY: value("GMGN_API_KEY"),
      EXECUTION_ENABLED: value("EXECUTION_ENABLED", "false"),
      DRY_RUN: value("DRY_RUN", "true"),
      EMERGENCY_PAUSE: value("EMERGENCY_PAUSE", "true"),
      LIVE_CANARY_ENABLED: value("LIVE_CANARY_ENABLED", "false"),
      V4_LIVE_CANARY_ENABLED: value("V4_LIVE_CANARY_ENABLED", "false"),
      MAX_POSITION_VALUE_USD: value("MAX_POSITION_VALUE_USD", "1000"),
      MAX_APPROVAL_VALUE_USD: value("MAX_APPROVAL_VALUE_USD", "1000"),
      MAX_GAS_COST_USD: value("MAX_GAS_COST_USD", "0.50"),
      MAX_LIFECYCLE_GAS_USD: value("MAX_LIFECYCLE_GAS_USD", "1"),
      MAX_SLIPPAGE_BPS: value("MAX_SLIPPAGE_BPS", "50"),
    },
    "300M",
  ),
  app("funi-reconcile", "infra/pm2/reconcile-worker.sh", readOnlyEnv),
  app("funi-v4-registry-worker", "infra/pm2/start-registry-worker.sh", {
    ...readOnlyEnv,
    V4_REGISTRY_CADENCE_MS: value("V4_REGISTRY_CADENCE_MS", "15000"),
  }),
  app("funi-v4-state-cache-worker", "infra/pm2/start-state-cache-worker.sh", {
    ...readOnlyEnv,
    DIRECT_LOOKUP_WORKER_IDLE_MS: value("DIRECT_LOOKUP_WORKER_IDLE_MS", "750"),
    STATE_CACHE_CADENCE_MS: value("STATE_CACHE_CADENCE_MS", "60000"),
    STATE_CACHE_BATCH_LIMIT: value("STATE_CACHE_BATCH_LIMIT", "16"),
    STATE_CACHE_ACTIVE_POOL_TTL_MS: value("STATE_CACHE_ACTIVE_POOL_TTL_MS", "120000"),
    ACTIVE_POSITION_RECONCILIATION_CADENCE_MS: value("ACTIVE_POSITION_RECONCILIATION_CADENCE_MS", "60000"),
    ACTIVE_POSITION_RECONCILIATION_TTL_MS: value("ACTIVE_POSITION_RECONCILIATION_TTL_MS", "300000"),
    ACTIVE_POSITION_RECONCILIATION_LIMIT: value("ACTIVE_POSITION_RECONCILIATION_LIMIT", "16"),
  }),
  app("funi-v4-state-cache-urgent", "infra/pm2/start-urgent-state-cache-worker.sh", {
    ...readOnlyEnv,
    URGENT_STATE_IDLE_MS: value("URGENT_STATE_IDLE_MS", "250"),
    ACTIVE_POSITION_RECONCILIATION_TTL_MS: value("ACTIVE_POSITION_RECONCILIATION_TTL_MS", "300000"),
    STATE_CACHE_ACTIVE_POOL_TTL_MS: value("STATE_CACHE_ACTIVE_POOL_TTL_MS", "120000"),
  }),
  app("funi-v4-direct-lookup-worker", "infra/pm2/start-direct-lookup-worker.sh", {
    ...readOnlyEnv,
    DIRECT_LOOKUP_WORKER_IDLE_MS: value("DIRECT_LOOKUP_WORKER_IDLE_MS", "750"),
    DIRECT_LOOKUP_CANDIDATE_BUDGET: value("DIRECT_LOOKUP_CANDIDATE_BUDGET", "12"),
    DIRECT_LOOKUP_MAX_RPC_BATCHES: value("DIRECT_LOOKUP_MAX_RPC_BATCHES", "1"),
    DIRECT_LOOKUP_ETH_CALL_BUDGET: value("DIRECT_LOOKUP_ETH_CALL_BUDGET", "24"),
  }),
];

function readOnlyChainApp(name, entrypoint, prefix) {
  if (!enabled(`${prefix}_ENABLED`)) return;
  apps.push(
    app(name, "infra/pm2/start-multichain-readonly-worker.sh", {
      ...readOnlyEnv,
      MULTICHAIN_WORKER_ENTRYPOINT: entrypoint,
      MULTICHAIN_READ_ONLY_CADENCE_MS: value(
        "MULTICHAIN_READ_ONLY_CADENCE_MS",
        "60000",
      ),
      [`${prefix}_ENABLED`]: "true",
      [`${prefix}_EXECUTION_ENABLED`]: "false",
      [`${prefix}_DRY_RUN`]: "true",
      [`${prefix}_EMERGENCY_PAUSE`]: "true",
      [`${prefix}_RPC_URLS`]: value(`${prefix}_RPC_URLS`),
      [`${prefix}_RPC_URL`]: value(`${prefix}_RPC_URL`),
      [`${prefix}_CONFIRMATIONS`]: value(`${prefix}_CONFIRMATIONS`),
    }),
  );
}

readOnlyChainApp("funi-bsc-registry-worker", "bsc-registry", "BSC");
readOnlyChainApp("funi-bsc-state-cache-worker", "bsc-state-cache", "BSC");
readOnlyChainApp("funi-ethereum-registry-worker", "ethereum-registry", "ETHEREUM");
readOnlyChainApp("funi-ethereum-state-cache-worker", "ethereum-state-cache", "ETHEREUM");

module.exports = { apps };
