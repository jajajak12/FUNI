import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { projectedIdleAlchemyUsage } from '../apps/cli/src/resource-budgets.js';
import { PORTFOLIO_PRICE_TTL_MS } from '../apps/cli/src/portfolio.js';

describe('bounded state cache and adoption owner',()=>{
 it('uses environment-driven cadence and call budgets without full-registry hot refresh',()=>{
  const source=readFileSync('apps/workers/src/state-cache-worker.ts','utf8');
  expect(source).toContain("integer('STATE_CACHE_CADENCE_MS'");
  expect(source).toContain("integer('STATE_CACHE_BATCH_LIMIT'");
  expect(source).toContain("integer('WALLET_ADOPTION_CANDIDATE_LIMIT'");
  expect(source).toContain("integer('ACTIVE_POSITION_RECONCILIATION_LIMIT'");
  expect(source).not.toContain('enqueueHotV4Pools');
  expect(source).not.toContain('enqueueNewV4Pools');
  expect(source).not.toContain('enqueueRecentRequestedV4Pools');
  expect(source).toContain("status IN ('open','partially_closed')");
  expect(source).toContain('fetchV4RegistryPoolBatch');
  expect(source).toContain('persistV4RegistryPoolBatch');
  expect(source).not.toContain('refreshV4RegistryPool(');
  expect(source).toContain("integer('STATE_CACHE_CADENCE_MS',60_000");
  expect(source).toContain("integer('STATE_CACHE_ACTIVE_POOL_TTL_MS',120_000");
  expect(source).toContain("integer('ACTIVE_POSITION_RECONCILIATION_CADENCE_MS',60_000");
  const ecosystem=readFileSync('infra/pm2/ecosystem.config.cjs','utf8');
  expect(ecosystem).toMatch(/ACTIVE_POSITION_RECONCILIATION_CADENCE_MS:\s*value\(\s*["']ACTIVE_POSITION_RECONCILIATION_CADENCE_MS["'],\s*["']60000["'],?\s*\)/);
  expect(PORTFOLIO_PRICE_TTL_MS).toBe(120_000);
  expect(60_000).toBeLessThan(PORTFOLIO_PRICE_TTL_MS);
  expect(source).not.toContain('executeDirectTokenLookup');
  const directLookupWorker=readFileSync('apps/workers/src/direct-lookup-worker.ts','utf8');
  expect(directLookupWorker).toContain('executeDirectTokenLookup');
  expect(directLookupWorker).toContain("integer('DIRECT_LOOKUP_WORKER_IDLE_MS',750");
  expect(source).toContain('overlapPrevented:true');
  expect(source).toContain("busy('adoption_enqueue'");
  expect(source).toContain("if(!adoptionDue)return");
  expect(source).toContain('sqlite_busy_cycle_backoff');
  const registry=readFileSync('apps/workers/src/registry-worker.ts','utf8');
  expect(registry).not.toContain('enqueueV4PoolsDiscoveredBetween');
  expect(registry).toContain('wallet-active-or-recent-request-only');
 });
 it('is signer-free and forces every execution gate closed',()=>{
  const source=readFileSync('apps/workers/src/state-cache-worker.ts','utf8');
  expect(source).toContain("delete process.env.LP_PRIVATE_KEY");
  expect(source).toContain("process.env.EXECUTION_ENABLED='false'");
  expect(source).toContain("process.env.DRY_RUN='true'");
  expect(source).toContain("process.env.EMERGENCY_PAUSE='true'");
  expect(source).toContain("process.env.LIVE_CANARY_ENABLED='false'");
  expect(source).toContain("process.env.V4_LIVE_CANARY_ENABLED='false'");
  expect(source).toContain('process.env.WALLET_ADDRESS');
  const dedicated=readFileSync('apps/workers/src/direct-lookup-worker.ts','utf8'),require=createRequire(import.meta.url),ecosystem=require('../infra/pm2/ecosystem.config.cjs') as {apps:Array<{name:string;env:Record<string,string|undefined>}>},directApp=ecosystem.apps.find(app=>app.name==='funi-v4-direct-lookup-worker');
  expect(dedicated).toContain("delete process.env.LP_PRIVATE_KEY");expect(dedicated).toContain("process.env.EXECUTION_ENABLED='false'");expect(dedicated).not.toMatch(/walletClient|signTransaction|sendTransaction|broadcast/);
  expect(directApp?.env).toMatchObject({DATABASE_PATH:expect.any(String),LP_PRIVATE_KEY:'',EXECUTION_ENABLED:'false'});expect(directApp?.env).toHaveProperty('ALCHEMY_RPC_URL');
 });
 it('projects zero, two, and ten positions as bounded batched method mixes',()=>{
  expect(projectedIdleAlchemyUsage({activePositions:0})).toMatchObject({totalRequests:0,computeUnits:0,monthlyComputeUnits:0});
  expect(projectedIdleAlchemyUsage({activePositions:2})).toMatchObject({blockNumberRequests:1008,ethCallRequests:1008,poolMulticallMembers:2880,ownershipMulticallMembers:2880,totalRequests:2016,computeUnits:36288,monthlyComputeUnits:1088640});
  expect(projectedIdleAlchemyUsage({activePositions:10})).toMatchObject({blockNumberRequests:1008,ethCallRequests:1008,poolMulticallMembers:14400,ownershipMulticallMembers:14400,totalRequests:2016,computeUnits:36288,monthlyComputeUnits:1088640});
 });
});
