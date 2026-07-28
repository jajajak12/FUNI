import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ test:{setupFiles:['./tests/runtime-env.setup.ts']}, resolve: { alias: {
  '@robin/core': fileURLToPath(new URL('./packages/robinhood-core/src/index.ts', import.meta.url)),
  '@robin/v3': fileURLToPath(new URL('./packages/uniswap-v3-adapter/src/index.ts', import.meta.url)),
  '@robin/v4': fileURLToPath(new URL('./packages/uniswap-v4-adapter/src/index.ts', import.meta.url)),
  '@robin/ledger': fileURLToPath(new URL('./packages/lp-ledger/src/index.ts', import.meta.url)),
  '@robin/astra': fileURLToPath(new URL('./packages/astra-robinhood-adapter/src/index.ts', import.meta.url))
}}});
