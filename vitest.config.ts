import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ test:{setupFiles:['./tests/runtime-env.setup.ts'],exclude:['**/node_modules/**','**/.git/**','**/.validation-runs/**']}, resolve: { alias: {
  '@funi/core': fileURLToPath(new URL('./packages/robinhood-core/src/index.ts', import.meta.url)),
  '@funi/v3': fileURLToPath(new URL('./packages/uniswap-v3-adapter/src/index.ts', import.meta.url)),
  '@funi/v4': fileURLToPath(new URL('./packages/uniswap-v4-adapter/src/index.ts', import.meta.url)),
  '@funi/ledger': fileURLToPath(new URL('./packages/lp-ledger/src/index.ts', import.meta.url))
}}});
