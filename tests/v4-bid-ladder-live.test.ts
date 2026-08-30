import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FallbackRpc, robinhoodMainnet } from "@funi/core";
import {
  migrateSqlite,
  SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
  SqliteLedgerRepository,
} from "@funi/ledger";
import {
  amountsForLiquidity,
  buildV4BatchFullDecrease,
  buildV4BatchCollect,
  buildV4BatchMint,
  poolId,
  sqrtPriceAtTick,
  V4_ROBINHOOD_DEPLOYMENTS,
  type V4PoolState,
} from "@funi/v4";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  createV4BidLadderDryRun,
  displayV4BidLadderMarketCapEvidence,
  previewV4BidLadder,
} from "../apps/cli/src/v4-bid-ladder-operator.js";
import {
  captureV4BidLadderCollectValuation,
  captureV4BidLadderCloseFeeAttribution,
  exactV4BidLadderClosePrincipalFeeDecomposition,
  executeV4BidLadderLiveOpen,
  executeV4BidLadderManualClose,
  formatV4BidLadderLivePreview,
  formatV4BidLadderClosePreview,
  previewV4BidLadderLive,
  reconcileConfirmedV4BidLadderJournal,
  reconcileTerminalV4BidLadderParent,
  v4BidLadderFeeUsdFromPrice,
  v4BidLadderCollectStage,
  v4BidLadderNativeUsd,
} from "../apps/cli/src/v4-bid-ladder-live.js";
import { reconcileDurableV4Journals } from "../apps/cli/src/v4-durable-journal-reconcile.js";
import { durableTransactionReconciliationPending } from "../apps/cli/src/transaction-boundary.js";
import { persistedPositionDisplayItems, persistedPositionViews } from "../apps/telegram-lp-bot/src/persisted-portfolio.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const c0 = "0x0000000000000000000000000000000000000001" as const,
  c1 = robinhoodMainnet.assets.USDG,
  owner = "0x0000000000000000000000000000000000000003" as const,
  hook = "0x0000000000000000000000000000000000000000" as const;
function fixture(totalFundingAmount = 10_000_000n) {
  const root = mkdtempSync(join(tmpdir(), "v4-bid-live-"));
  roots.push(root);
  const path = join(root, "db.sqlite");
  migrateSqlite(path, "infra/migrations");
  const repo = new SqliteLedgerRepository(path, {
      busyTimeoutMs: SQLITE_RUNTIME_BUSY_TIMEOUT_MS,
    }),
    key = {
      currency0: c0,
      currency1: c1,
      fee: 3000,
      tickSpacing: 10,
      hooks: hook,
    } as const,
    pool: V4PoolState = {
      id: poolId(key),
      key,
      sqrtPriceX96: sqrtPriceAtTick(0),
      tick: 0,
      liquidity: 1_000_000_000_000n,
      initialized: true,
      blockNumber: 123n,
    },
    preview = previewV4BidLadder({
      pool,
      funding: { address: c1, symbol: "USDG", decimals: 6 },
      target: { address: c0, symbol: "TOKEN", decimals: 18 },
      totalFundingAmount,
      owner,
      deadline: 999999n,
      nowMs: 1000,
    });
  repo.upsertTokenMetadata({address:c0,symbol:"TOKEN",name:"Token",decimals:18});
  repo.upsertTokenMetadata({address:c1,symbol:"USDG",name:"USDG",decimals:totalFundingAmount===10_000_000n?18:6});
  createV4BidLadderDryRun(repo, preview);
  const now = Date.now();
  repo.db
    .prepare(
      "INSERT INTO portfolio_persisted_snapshot(snapshot_key,payload_json,content_hash,refreshed_at_ms,last_reconciliation_at_ms) VALUES('current',?,?,?,?)",
    )
    .run(
      JSON.stringify({
        positions: [],
        lastReconciliationAt: new Date(now).toISOString(),
      }),
      "test",
      now,
      now,
    );
  let positionsClosed = false,currentTick=0,erc20Allowance=1_000_000_000n,permitAllowance=1_000_000_000n,balance=1_000_000_000n,laterPoolSwap=false,historicalStateUnavailable=false,failedFinalRead:string|null=null,estimateGasFailureAt=Number.POSITIVE_INFINITY,afterInitialEstimate:(()=>void)|undefined,blockSequence=[123n];
  const blockValues=new Map<bigint,{tick?:number;liquidity?:bigint;balance?:bigint;erc20Allowance?:bigint;permitAllowance?:bigint}>(),multicallBlocks:bigint[]=[],calls={getBlockNumber:0,getSlot0:0,getLiquidity:0,balanceOf:0,erc20Allowance:0,permit2Allowance:0,estimateGas:0,multicall:0,transportRpc:0,tokenMetadata:0};
  const client = {
      getBlockNumber: async () => {calls.getBlockNumber++;calls.transportRpc++;return blockSequence.length>1?blockSequence.shift()!:blockSequence[0]!;},
      getBlock: async () => ({ timestamp: 123n }),
      getGasPrice: async () => 1n,
      getTransactionCount: async () => 0,
      getLogs: async () => laterPoolSwap?[{transactionIndex:1}]:[],
      getBytecode: async () => "0x01",
      readContract: async (input: any) => {
        calls.transportRpc++;
        const at=blockValues.get(BigInt(input.blockNumber??-1));
        if (input.functionName === "decimals") {calls.tokenMetadata++;
          return input.address.toLowerCase() === c1.toLowerCase() ? 6 : 18;
        }
        if (input.functionName === "symbol") {calls.tokenMetadata++;
          return input.address.toLowerCase() === c1.toLowerCase()
            ? "USDG"
            : "TOKEN";
        }
        if (input.functionName === "name") {calls.tokenMetadata++;
          return input.address.toLowerCase() === c1.toLowerCase()
            ? "USDG"
            : "Token";
        }
        if (input.functionName === "getSlot0") {calls.getSlot0++;if(historicalStateUnavailable&&input.blockNumber!==undefined)throw new Error("archival state unavailable");const tick=at?.tick??currentTick;return [sqrtPriceAtTick(tick), tick, 0, 3000];}
        if (input.functionName === "getLiquidity") {calls.getLiquidity++;return at?.liquidity??1_000_000_000_000n;}
        if (input.functionName === "balanceOf") {calls.balanceOf++;return at?.balance??balance;}
        if (input.functionName === "allowance") {
          if(input.args?.length===3){calls.permit2Allowance++;return [at?.permitAllowance??permitAllowance,Math.floor(Date.now()/1000)+3600,0];}
          calls.erc20Allowance++;return at?.erc20Allowance??erc20Allowance;
        }
        if (
          [
            "ownerOf",
            "getPoolAndPositionInfo",
            "getPositionLiquidity",
          ].includes(input.functionName)
        ) {
          const index = Number(BigInt(input.args[0]) - 101n),
            leg = preview.plan.legs[index]!;
          if (input.functionName === "ownerOf") return owner;
          if (input.functionName === "getPositionLiquidity")
            return positionsClosed ? 0n : leg.mint.liquidity;
          const signed = (value: number) =>
            BigInt(value < 0 ? value + 0x1000000 : value);
          return [
            key,
            (signed(leg.tickLower) << 8n) | (signed(leg.tickUpper) << 32n),
          ];
        }
        throw new Error(`unexpected read ${input.functionName}`);
      },
      estimateGas: async () => {calls.estimateGas++;calls.transportRpc++;if(calls.estimateGas>=estimateGasFailureAt)throw new Error('estimate unavailable');if(calls.estimateGas===1){const mutate=afterInitialEstimate;afterInitialEstimate=undefined;mutate?.();}return 1_000_000n;},
      multicall: async (input: any) => {
        calls.multicall++;calls.transportRpc++;if(input.blockNumber!==undefined)multicallBlocks.push(BigInt(input.blockNumber));
        const at=blockValues.get(BigInt(input.blockNumber??-1));
        return input.contracts.map((contract: any) => {
          if(failedFinalRead===contract.functionName)return {status:'failure',error:new Error('unavailable')};
          if (contract.functionName === "getSlot0") {calls.getSlot0++;const tick=at?.tick??currentTick;
            return { status: "success", result: [sqrtPriceAtTick(tick), tick, 0, 3000] };}
          if (contract.functionName === "getLiquidity") {calls.getLiquidity++;
            return { status: "success", result: at?.liquidity??1_000_000_000_000n };}
          if (contract.functionName === "balanceOf") {calls.balanceOf++;return {status:"success",result:at?.balance??balance};}
          if (contract.functionName === "allowance"&&contract.args?.length===3) {calls.permit2Allowance++;return {status:"success",result:[at?.permitAllowance??permitAllowance,Math.floor(Date.now()/1000)+3600,0]};}
          if (contract.functionName === "allowance") {calls.erc20Allowance++;return {status:"success",result:at?.erc20Allowance??erc20Allowance};}
          if (contract.functionName === "getPoolAndPositionInfo") {
            const tokenId = contract.args[0] as bigint,
              leg = fPreviewLeg(preview, Number(tokenId - 101n)),
              signed = (value: number) =>
                BigInt(value < 0 ? value + 0x1000000 : value);
            return {
              status: "success",
              result: [
                key,
                (signed(leg.tickLower) << 8n) | (signed(leg.tickUpper) << 32n),
              ],
            };
          }
          if (contract.functionName === "getPositionInfo") {
            const salt = BigInt(contract.args[4]);
            const positionLeg = fPreviewLeg(preview, Number(salt - 101n));
            return {
              status: "success",
              result: [positionLeg.mint.liquidity, 0n, 0n],
            };
          }
          if (contract.functionName === "getFeeGrowthInside")
            return { status: "success", result: [0n, 0n] };
          throw new Error(`unexpected multicall ${contract.functionName}`);
        });
      },
    } as any,
    rpc = new FallbackRpc(
      { ...robinhoodMainnet, rpcUrls: ["https://example.invalid"] },
      undefined,
      { clients: [client] },
    );
  return {
    repo,
    rpc,
    ladderId: preview.plan.ladderId,
    preview,
    key,
    closePositions: () => {
      positionsClosed = true;
    },
    setPoolTick:(tick:number)=>{currentTick=tick;},
    setLaterPoolSwap:(present:boolean)=>{laterPoolSwap=present;},
    setHistoricalStateUnavailable:(present:boolean)=>{historicalStateUnavailable=present;},
    setFinalReadFailure:(functionName:string|null)=>{failedFinalRead=functionName;},
    setEstimateGasFailureAt:(attempt:number)=>{estimateGasFailureAt=attempt;},
    afterInitialEstimate:(mutate:()=>void)=>{afterInitialEstimate=mutate;},
    requireApprovals:()=>{erc20Allowance=0n;permitAllowance=0n;},
    setApprovals:(erc20:bigint,permit2:bigint)=>{erc20Allowance=erc20;permitAllowance=permit2;},
    setBalance:(value:bigint)=>{balance=value;},
    setBlockSequence:(...values:bigint[])=>{blockSequence=[...values];},
    setBlockValues:(block:bigint,values:{tick?:number;liquidity?:bigint;balance?:bigint;erc20Allowance?:bigint;permitAllowance?:bigint})=>{blockValues.set(block,values);},
    multicallBlocks,
    calls,
  };
}
function fPreviewLeg(
  preview: ReturnType<typeof previewV4BidLadder>,
  index: number,
) {
  const leg = preview.plan.legs[index];
  if (!leg) throw new Error("test token id out of range");
  return leg;
}
const runtime = {
  executionEnabled: true,
  dryRun: false,
  emergencyPause: false,
  signerConfigured: true,
  allowlisted: true,
  maxPositionUsd: 100,
  maxApprovalUsd: 100,
  maxGasUsd: 100,
  slippageBps: 100,
};

function seedConfirmedOpenApproval(
  f: ReturnType<typeof fixture>,
  stage: "OPEN_ERC20_APPROVAL" | "OPEN_PERMIT2_APPROVAL",
  blockNumber: bigint,
  nonce: number,
) {
  const hash = `0x${nonce.toString(16).padStart(2, "0").repeat(32)}` as Hex,
    journalId = `${f.ladderId}:${stage}:0`,
    receipt = {
      status: "success" as const,
      transactionHash: hash,
      blockNumber,
      blockHash: `0x${"aa".repeat(32)}` as Hex,
      transactionIndex: 0,
      from: owner,
      to: stage === "OPEN_ERC20_APPROVAL" ? c1 : V4_ROBINHOOD_DEPLOYMENTS.permit2,
      contractAddress: null,
      cumulativeGasUsed: 1n,
      effectiveGasPrice: 1n,
      gasUsed: 1n,
      logs: [],
      logsBloom: `0x${"00".repeat(256)}` as Hex,
      type: "legacy" as const,
    };
  f.repo.persistChainPreparedTransaction({
    chainId: 4663,
    chainKey: "robinhood",
    protocol: "uniswap_v4",
    journalId,
    wallet: owner,
    workflowIdentity: f.ladderId,
    semanticStage: stage,
    attempt: 0,
    nonce,
    transactionType: stage,
    expectedHash: hash,
    to: receipt.to,
    requestFingerprint: journalId,
    feeModel: "legacy",
  });
  f.repo.transitionChainTransaction({chainId:4663,journalId,from:"PREPARED",to:"SUBMITTED"});
  f.repo.transitionChainTransaction({chainId:4663,journalId,from:"SUBMITTED",to:"CONFIRMED",receipt});
}

function freshEntryEvidence(target: Address) {
  const fetchedAtMs = Date.now();
  return {
    token: target,
    priceUsd: "1",
    source: "gmgn-token-info-price.price" as const,
    fetchedAtMs,
    freshUntilMs: fetchedAtMs + 30_000,
  };
}

describe("V4 BID ladder Phase 2B operator boundary", () => {
  it("rejects a non-funding-only live state before any approval or OPEN signing",async()=>{const f=fixture();f.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(f.ladderId);f.requireApprovals();const leg=f.preview.plan.legs[0]!,inside=Math.trunc((leg.tickLower+leg.tickUpper)/2);f.setPoolTick(inside);let walletCalls=0;const walletClient=new Proxy({} as any,{get(){walletCalls++;throw new Error('wallet boundary reached');}});await expect(executeV4BidLadderLiveOpen({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async()=>({priceUsd:1,source:'fixture',observedAtMs:Date.now()}),walletClient} as any)).rejects.toThrow('V4_BID_LADDER_LEG_NOT_FUNDING_ONLY');expect(walletCalls).toBe(0);expect(f.repo.db.prepare('SELECT COUNT(*) count FROM chain_transaction_journal').get()).toEqual({count:0});});
  it("forbids approval transactions on the post-Confirm replacement OPEN boundary",async()=>{const f=fixture();try{f.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(f.ladderId);f.requireApprovals();let walletCalls=0;const walletClient=new Proxy({} as any,{get(){walletCalls++;throw new Error('wallet boundary reached');}});await expect(executeV4BidLadderLiveOpen({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async()=>({priceUsd:1,source:'fixture',observedAtMs:Date.now()}),walletClient,requirePreapprovedFunding:true} as any)).rejects.toThrow('REPOSITION_POST_CONFIRM_APPROVAL_REQUIRED');expect(walletCalls).toBe(0);expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage IN ('OPEN_ERC20_APPROVAL','OPEN_PERMIT2_APPROVAL')").get()).toEqual({count:0});}finally{f.repo.close();}});
  it("uses one initial full state, receipt-scoped approval deltas, and a dedicated minimal final validator",()=>{const source=readFileSync('apps/cli/src/v4-bid-ladder-live.ts','utf8'),body=source.slice(source.indexOf('export async function executeV4BidLadderLiveOpen'),source.indexOf('async function closeState')),validator=source.slice(source.indexOf('async function validateFinalOpenAuthority'),source.indexOf('export async function v4BidLadderFundingAllowanceReadiness'));expect(body.match(/await openState\(input, true, priceMemo\)/g)).toHaveLength(1);expect(body.match(/await refreshOpenApprovalDelta\(/g)).toHaveLength(2);expect(body.match(/await validateFinalOpenAuthority\(input, preview, priceMemo\)/g)).toHaveLength(1);expect(validator).not.toContain('readOpenChainState(');expect(validator).not.toContain('materializeOpenState(');expect(validator).not.toContain('tokenDecimals(');expect(validator).not.toContain('multicallAddress');expect(robinhoodMainnet.contracts?.multicall3?.address).toBeDefined();expect(body.indexOf('await validateFinalOpenAuthority')).toBeLessThan(body.indexOf('stage: "OPEN_BATCH"'));});
  it.each([
    ["no approval", false, false, {balanceOf:2,erc20Allowance:2,permit2Allowance:2,estimateGas:2}],
    ["ERC20 approval", true, false, {balanceOf:3,erc20Allowance:3,permit2Allowance:3,estimateGas:3}],
    ["Permit2 approval", false, true, {balanceOf:3,erc20Allowance:2,permit2Allowance:3,estimateGas:3}],
    ["both approvals", true, true, {balanceOf:4,erc20Allowance:3,permit2Allowance:4,estimateGas:4}],
  ] as const)("%s uses one full initial state and one pinned minimal final economic refresh",async(_label,erc20Required,permitRequired,expected)=>{
    const f=fixture();
    try{
      f.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(f.ladderId);
      const high=1_000_000_000n;
      f.setApprovals(erc20Required?0n:high,permitRequired?0n:high);
      const finalBlock=erc20Required&&permitRequired?126n:erc20Required||permitRequired?125n:124n;
      f.setBlockSequence(123n,finalBlock);
      if(erc20Required){seedConfirmedOpenApproval(f,"OPEN_ERC20_APPROVAL",124n,11);f.setBlockValues(124n,{erc20Allowance:high,permitAllowance:permitRequired?0n:high});}
      if(permitRequired){seedConfirmedOpenApproval(f,"OPEN_PERMIT2_APPROVAL",erc20Required?125n:124n,12);f.setBlockValues(erc20Required?125n:124n,{balance:high,permitAllowance:high});}
      f.setBlockValues(finalBlock,{balance:high,erc20Allowance:high,permitAllowance:high});
      const gmgn=vi.fn(async(target:Address)=>freshEntryEvidence(target)),walletClient={account:{}} as any;
      await expect(executeV4BidLadderLiveOpen({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:gmgn,walletClient})).rejects.toThrow("LOCAL_SIGNER_REQUIRED");
      expect(gmgn).toHaveBeenCalledTimes(1);
      const expectedTransport=erc20Required&&permitRequired?17:erc20Required?14:permitRequired?13:10;
      expect(f.calls).toMatchObject({getBlockNumber:2,getSlot0:2,getLiquidity:2,multicall:1,transportRpc:expectedTransport,tokenMetadata:0,...expected});
      expect(f.multicallBlocks).toEqual([finalBlock]);
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='OPEN_BATCH'").get()).toEqual({count:0});
    }finally{f.repo.close();}
  });
  it("refreshes stale GMGN evidence and never shares memoized evidence across OPEN attempts",async()=>{
    const f=fixture();
    try{
      f.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(f.ladderId);
      let staleCalls=0;
      const stale=vi.fn(async(target:Address)=>{staleCalls++;const evidence=freshEntryEvidence(target);return staleCalls===1?{...evidence,freshUntilMs:evidence.fetchedAtMs}:evidence;}),walletClient={account:{}} as any,context={repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,walletClient};
      await expect(executeV4BidLadderLiveOpen({...context,entryPriceFetch:stale})).rejects.toThrow("LOCAL_SIGNER_REQUIRED");
      expect(stale).toHaveBeenCalledTimes(2);
      const distinct=vi.fn(async(target:Address)=>freshEntryEvidence(target));
      await expect(executeV4BidLadderLiveOpen({...context,entryPriceFetch:distinct})).rejects.toThrow("LOCAL_SIGNER_REQUIRED");
      await expect(executeV4BidLadderLiveOpen({...context,entryPriceFetch:distinct})).rejects.toThrow("LOCAL_SIGNER_REQUIRED");
      expect(distinct).toHaveBeenCalledTimes(2);
    }finally{f.repo.close();}
  });
  it("fails closed when approval-time balance changes or final JIT pool drift breaks funding-only",async()=>{
    const balanceFixture=fixture();
    try{
      balanceFixture.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(balanceFixture.ladderId);
      balanceFixture.setApprovals(0n,1_000_000_000n);seedConfirmedOpenApproval(balanceFixture,"OPEN_ERC20_APPROVAL",124n,13);balanceFixture.setBlockValues(124n,{balance:0n,erc20Allowance:1_000_000_000n,permitAllowance:1_000_000_000n});
      await expect(executeV4BidLadderLiveOpen({repo:balanceFixture.repo,rpc:balanceFixture.rpc,ladderId:balanceFixture.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async(target)=>freshEntryEvidence(target as typeof c0),walletClient:{account:{}} as any})).rejects.toThrow("V4_BID_LADDER_FUNDING_BALANCE_INSUFFICIENT");
    }finally{balanceFixture.repo.close();}
    const driftFixture=fixture();
    try{
      driftFixture.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(driftFixture.ladderId);driftFixture.setBlockSequence(123n,124n);const leg=driftFixture.preview.plan.legs[0]!;driftFixture.setBlockValues(124n,{tick:Math.trunc((leg.tickLower+leg.tickUpper)/2)});
      await expect(executeV4BidLadderLiveOpen({repo:driftFixture.repo,rpc:driftFixture.rpc,ladderId:driftFixture.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async(target)=>freshEntryEvidence(target as typeof c0),walletClient:{account:{}} as any})).rejects.toThrow("V4_BID_LADDER_LEG_NOT_FUNDING_ONLY");
    }finally{driftFixture.repo.close();}
  });
  it("fails closed when the persisted pool/token identity changes before the final pinned snapshot",async()=>{const f=fixture();try{f.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(f.ladderId);f.setBlockSequence(123n,124n);f.afterInitialEstimate(()=>f.repo.db.prepare("UPDATE v4_bid_ladders SET funding_token=?,target_token=? WHERE ladder_id=?").run(c0,c1,f.ladderId));let walletCalls=0;await expect(executeV4BidLadderLiveOpen({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async target=>freshEntryEvidence(target),walletClient:new Proxy({} as any,{get(){walletCalls++;throw new Error('wallet boundary reached');}})})).rejects.toThrow('V4_BID_LADDER_OPEN_IDENTITY_CHANGED');expect(walletCalls).toBe(0);expect(f.multicallBlocks).toEqual([124n]);expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='OPEN_BATCH'").get()).toEqual({count:0});}finally{f.repo.close();}});
  it.each([
    ["balance",{balance:0n},"V4_BID_LADDER_FUNDING_BALANCE_INSUFFICIENT"],
    ["ERC20 allowance",{erc20Allowance:0n},"V4_BID_LADDER_ERC20_ALLOWANCE_INSUFFICIENT"],
    ["Permit2 allowance",{permitAllowance:0n},"V4_BID_LADDER_PERMIT2_ALLOWANCE_INSUFFICIENT"],
    ["active liquidity",{liquidity:0n},"V4_BID_LADDER_POOL_UNINITIALIZED"],
  ] as const)("blocks final %s drift from the pinned multicall before signing",async(label,values,blocker)=>{const f=fixture();try{f.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(f.ladderId);f.setBlockSequence(123n,124n);f.setBlockValues(124n,values);let walletCalls=0;const telemetry:any[]=[];await expect(executeV4BidLadderLiveOpen({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async target=>freshEntryEvidence(target),walletClient:new Proxy({} as any,{get(){walletCalls++;throw new Error('wallet boundary reached');}}),telemetry:(event,data)=>telemetry.push({event,...data})})).rejects.toThrow(blocker);expect(walletCalls).toBe(0);expect(f.multicallBlocks).toEqual([124n]);const finalValidation=telemetry.find(item=>item.event==='v4_bid_ladder_open_final_validation');expect(finalValidation).toMatchObject({outcome:'BLOCKED',transportRpcCount:3,multicallMembers:5,genericMaterialization:false});console.log(JSON.stringify({event:'public_v4_final_validation_performance',case:label,durationMs:finalValidation.durationMs,transportRpcCount:finalValidation.transportRpcCount,multicallMembers:finalValidation.multicallMembers,genericMaterialization:finalValidation.genericMaterialization}));expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='OPEN_BATCH'").get()).toEqual({count:0});}finally{f.repo.close();}});
  it("fails closed on unavailable final liquidity or the one exact final calldata estimate",async()=>{const unavailable=fixture();try{unavailable.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(unavailable.ladderId);unavailable.setBlockSequence(123n,124n);unavailable.setFinalReadFailure('getLiquidity');await expect(executeV4BidLadderLiveOpen({repo:unavailable.repo,rpc:unavailable.rpc,ladderId:unavailable.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async target=>freshEntryEvidence(target),walletClient:{account:{}} as any})).rejects.toThrow('V4_BID_LADDER_FINAL_LIQUIDITY_UNAVAILABLE');expect(unavailable.calls.estimateGas).toBe(1);expect(unavailable.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='OPEN_BATCH'").get()).toEqual({count:0});}finally{unavailable.repo.close();}const gas=fixture();try{gas.repo.db.prepare("UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?").run(gas.ladderId);gas.setBlockSequence(123n,124n);gas.setEstimateGasFailureAt(2);await expect(executeV4BidLadderLiveOpen({repo:gas.repo,rpc:gas.rpc,ladderId:gas.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime,nowMs:()=>1_000,entryPriceFetch:async target=>freshEntryEvidence(target),walletClient:{account:{}} as any})).rejects.toThrow('V4_BID_LADDER_MINT_ESTIMATE_FAILED');expect(gas.calls.estimateGas).toBe(2);expect(gas.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE semantic_stage='OPEN_BATCH'").get()).toEqual({count:0});}finally{gas.repo.close();}});
  it("values recurring claim fees with canonical token orientation and decimals", () => {
    expect(
      v4BidLadderFeeUsdFromPrice({
        token0Raw: 56_893n * 10n ** 18n,
        token1Raw: 72_597_311n,
        token0Decimals: 18,
        token1Decimals: 6,
        token1PerToken0: 0.0015,
        fundingIndex: 1,
        fundingUsd: 1,
      }),
    ).toBeCloseTo(157.936811, 6);
    expect(
      v4BidLadderFeeUsdFromPrice({
        token0Raw: 13_928_341n,
        token1Raw: 9_198_025_175_000_000_000_000n,
        token0Decimals: 6,
        token1Decimals: 18,
        token1PerToken0: 666.6666666667,
        fundingIndex: 0,
        fundingUsd: 1,
      }),
    ).toBeCloseTo(27.7253787625, 6);
    expect(
      v4BidLadderFeeUsdFromPrice({
        token0Raw: 43_452n * 10n ** 18n,
        token1Raw: 55_768_720n,
        token0Decimals: 18,
        token1Decimals: 6,
        token1PerToken0: 0.0015,
        fundingIndex: 1,
        fundingUsd: 1,
      }),
    ).toBeLessThan(200);
    expect(
      v4BidLadderFeeUsdFromPrice({
        token0Raw: 1n,
        token1Raw: 1n,
        token0Decimals: 18,
        token1Decimals: 6,
        token1PerToken0: Number.NaN,
        fundingIndex: 1,
        fundingUsd: 1,
      }),
    ).toBeNull();
  });
  it("decomposes all five CLOSE principals and both raw fee sides without rounding drift",()=>{const f=fixture(10_000_001n),legs=f.preview.plan.legs.map((leg,index)=>({tokenId:101n+BigInt(index),liquidity:leg.mint.liquidity,tickLower:leg.tickLower,tickUpper:leg.tickUpper})),principal=legs.map(leg=>amountsForLiquidity(f.preview.plan.pool.sqrtPriceX96,leg.tickLower,leg.tickUpper,leg.liquidity)).reduce((sum,value)=>({token0:sum.token0+value.token0,token1:sum.token1+value.token1}),{token0:0n,token1:0n}),split=exactV4BidLadderClosePrincipalFeeDecomposition({sqrtPriceX96:f.preview.plan.pool.sqrtPriceX96,aggregateReturned0Raw:principal.token0+123n,aggregateReturned1Raw:principal.token1+456n,legs});expect(split.status).toBe("AVAILABLE");if(split.status!=="AVAILABLE")return;expect(split.perNft).toHaveLength(5);expect(split.principal).toEqual(principal);expect(split.fees).toEqual({token0:123n,token1:456n});expect(split.principal.token0+split.fees.token0).toBe(principal.token0+123n);expect(split.principal.token1+split.fees.token1).toBe(principal.token1+456n);expect(exactV4BidLadderClosePrincipalFeeDecomposition({sqrtPriceX96:f.preview.plan.pool.sqrtPriceX96,aggregateReturned0Raw:principal.token0-1n,aggregateReturned1Raw:principal.token1,legs})).toMatchObject({status:"INCOMPLETE",reason:"INCOMPLETE_CLOSE_PRINCIPAL_EXCEEDS_RETURN"});f.repo.close();});
  it("binds CLAIM valuation to the receipt block and fails closed for unavailable or same-block-ambiguous price",async()=>{const run=async(mode:"AVAILABLE"|"UNAVAILABLE"|"AMBIGUOUS")=>{const f=fixture(10_000_001n),authorization=(mode==="AVAILABLE"?"a":mode==="UNAVAILABLE"?"b":"c").repeat(18),stage=`COLLECT_BATCH:${authorization}` as `COLLECT_BATCH:${string}`,hash=`0x${(mode==="AVAILABLE"?"61":mode==="UNAVAILABLE"?"62":"63").repeat(32)}` as Hex,confirmed={status:"success" as const,transactionHash:hash,blockNumber:123n,blockHash:`0x${"71".repeat(32)}` as Hex,transactionIndex:0,from:owner,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,contractAddress:null,cumulativeGasUsed:1n,effectiveGasPrice:1n,gasUsed:1n,logs:[],logsBloom:`0x${"00".repeat(256)}` as Hex,type:"legacy" as const};f.repo.persistChainPreparedTransaction({chainId:4663,chainKey:"robinhood",protocol:"uniswap_v4",journalId:`${f.ladderId}:${mode}`,wallet:owner,workflowIdentity:f.ladderId,semanticStage:stage,attempt:0,nonce:1,transactionType:stage,expectedHash:hash,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,requestFingerprint:mode,feeModel:"legacy"});f.repo.transitionChainTransaction({chainId:4663,journalId:`${f.ladderId}:${mode}`,from:"PREPARED",to:"SUBMITTED"});f.repo.transitionChainTransaction({chainId:4663,journalId:`${f.ladderId}:${mode}`,from:"SUBMITTED",to:"CONFIRMED",receipt:confirmed});f.setLaterPoolSwap(mode==="AMBIGUOUS");f.setHistoricalStateUnavailable(mode==="UNAVAILABLE");const value=await captureV4BidLadderCollectValuation({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime},confirmed as any,stage);f.repo.close();return value;};await expect(run("AVAILABLE")).resolves.toMatchObject({status:"AVAILABLE",observationBlock:"123",sqrtPriceX96:sqrtPriceAtTick(0).toString(),sameBlockLaterPoolSwaps:0,evidenceSource:"ARCHIVAL_STATEVIEW_BLOCK_END_NO_LATER_POOL_SWAP"});await expect(run("UNAVAILABLE")).resolves.toMatchObject({status:"INCOMPLETE",sqrtPriceX96:null,reason:"INCOMPLETE_HISTORICAL_POOL_STATE_UNAVAILABLE"});await expect(run("AMBIGUOUS")).resolves.toMatchObject({status:"INCOMPLETE",sqrtPriceX96:null,reason:"INCOMPLETE_SAME_BLOCK_PRICE_AMBIGUITY",sameBlockLaterPoolSwaps:1});});
  it("binds CLOSE fee attribution to receipt order and fails closed on a later same-pool swap",async()=>{const run=async(ambiguous:boolean)=>{const f=fixture(10_000_001n),hash=`0x${(ambiguous?"65":"64").repeat(32)}` as Hex,receipt={status:"success" as const,transactionHash:hash,blockNumber:123n,blockHash:`0x${"72".repeat(32)}` as Hex,transactionIndex:0,from:owner,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,contractAddress:null,cumulativeGasUsed:1n,effectiveGasPrice:1n,gasUsed:1n,logs:[],logsBloom:`0x${"00".repeat(256)}` as Hex,type:"legacy" as const},legs=f.preview.plan.legs.map((leg,index)=>({tokenId:101n+BigInt(index),liquidity:leg.mint.liquidity,tickLower:leg.tickLower,tickUpper:leg.tickUpper})),principal=legs.map(leg=>amountsForLiquidity(sqrtPriceAtTick(0),leg.tickLower,leg.tickUpper,leg.liquidity)).reduce((sum,value)=>({token0:sum.token0+value.token0,token1:sum.token1+value.token1}),{token0:0n,token1:0n}),journalId=`${f.ladderId}:close:${ambiguous}`;f.repo.persistChainPreparedTransaction({chainId:4663,chainKey:"robinhood",protocol:"uniswap_v4",journalId,wallet:owner,workflowIdentity:f.ladderId,semanticStage:"CLOSE_BATCH",attempt:0,nonce:1,transactionType:"CLOSE_BATCH",expectedHash:hash,to:V4_ROBINHOOD_DEPLOYMENTS.positionManager,requestFingerprint:journalId,feeModel:"legacy"});f.repo.transitionChainTransaction({chainId:4663,journalId,from:"PREPARED",to:"SUBMITTED"});f.repo.transitionChainTransaction({chainId:4663,journalId,from:"SUBMITTED",to:"CONFIRMED",receipt});f.setLaterPoolSwap(ambiguous);const value=await captureV4BidLadderCloseFeeAttribution({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime},receipt as any,legs,{token0:principal.token0+123n,token1:principal.token1+456n}),replayed=await captureV4BidLadderCloseFeeAttribution({repo:f.repo,rpc:f.rpc,ladderId:f.ladderId,wallet:owner,fundingUsd:1,nativeUsd:1,runtime},receipt as any,legs,{token0:principal.token0+123n,token1:principal.token1+456n});expect(replayed).toEqual(value);f.repo.close();return value;};await expect(run(false)).resolves.toMatchObject({status:"AVAILABLE",receiptTransactionIndex:0,sameBlockLaterPoolSwaps:0,closeFee0Raw:"123",closeFee1Raw:"456",rawInvariantExact:true,perNft:expect.arrayContaining([expect.objectContaining({tokenId:"101"})])});await expect(run(true)).resolves.toMatchObject({status:"INCOMPLETE",reason:"INCOMPLETE_SAME_BLOCK_PRICE_AMBIGUITY",closeFee0Raw:null,closeFee1Raw:null,rawInvariantExact:false,sameBlockLaterPoolSwaps:1});});
  it("gives every collect authorization a distinct durable stage while replaying the same authorization", () => {
    const first = "a".repeat(18),
      second = "b".repeat(18);
    expect(v4BidLadderCollectStage(first)).toBe(v4BidLadderCollectStage(first));
    expect(v4BidLadderCollectStage(second)).not.toBe(
      v4BidLadderCollectStage(first),
    );
    expect(v4BidLadderCollectStage(first)).toBe(`COLLECT_BATCH:${first}`);
    expect(() => v4BidLadderCollectStage("stale")).toThrow(
      "V4_BID_LADDER_COLLECT_AUTHORIZATION_INVALID",
    );
  });
  it("terminalizes five externally closed legs with explicit provenance and keeps four-of-five open", () => {
    const f = fixture();
    try {
      f.repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET execution_mode='LIVE',status='OPEN' WHERE ladder_id=?",
        )
        .run(f.ladderId);
      for (let index = 0; index < 5; index++) {
        const tokenId = String(201 + index),
          leg = f.repo.listBidLadderLegs(f.ladderId)[index]!;
        f.repo.db
          .prepare(
            "UPDATE v4_bid_ladder_legs SET status='OPEN',token_id=? WHERE ladder_id=? AND leg_index=?",
          )
          .run(tokenId, f.ladderId, index);
        f.repo.ensurePosition(`v4:${tokenId}`, tokenId, poolId(f.key));
        f.repo.upsertV4Position({
          tokenId: BigInt(tokenId),
          owner,
          poolId: poolId(f.key),
          poolKey: f.key,
          currency0: c0,
          currency1: c1,
          fee: f.key.fee,
          tickSpacing: f.key.tickSpacing,
          hooks: f.key.hooks,
          tickLower: Number(leg.tick_lower),
          tickUpper: Number(leg.tick_upper),
          liquidity: 0n,
          initialAmount0: 0n,
          initialAmount1: 1n,
          mintHash: `0x${String(index + 1).padStart(64, "0")}`,
          status: "closed",
          openIntentId: f.ladderId,
        });
        f.repo.db
          .prepare(
            "INSERT INTO active_position_reconciliations(position_id,protocol_version,token_id,manager_address,owner_status,liquidity_raw,claimable0_raw,claimable1_raw,terminal_reason,confirmed_active,contributes_equity,checked_at_ms,fresh_until_ms,retry_count,details_json) VALUES(?,'v4',?,?,'VERIFIED_OWNED','0','0','0',?,0,0,1,9223372036854775807,0,'{}')",
          )
          .run(
            `v4:${tokenId}`,
            tokenId,
            V4_ROBINHOOD_DEPLOYMENTS.positionManager,
            index < 4 ? "CLOSED_EMPTY" : null,
          );
      }
      expect(() =>
        reconcileTerminalV4BidLadderParent({
          repo: f.repo,
          ladderId: f.ladderId,
          provenance: "EXTERNAL_OPERATOR_CLOSE",
        }),
      ).toThrow("V4_BID_LADDER_TERMINAL_EVIDENCE_INCOMPLETE_OR_STALE");
      expect(f.repo.loadBidLadder(f.ladderId)?.status).toBe("OPEN");
      f.repo.db
        .prepare(
          "UPDATE active_position_reconciliations SET terminal_reason='CLOSED_EMPTY' WHERE position_id='v4:205'",
        )
        .run();
      expect(
        reconcileTerminalV4BidLadderParent({
          repo: f.repo,
          ladderId: f.ladderId,
          provenance: "EXTERNAL_OPERATOR_CLOSE",
        }),
      ).toMatchObject({
        status: "CONVERGED",
        provenance: "EXTERNAL_OR_UNKNOWN_TERMINAL",
      });
      expect(f.repo.loadBidLadder(f.ladderId)).toMatchObject({
        status: "CLOSED",
        close_provenance: "UNKNOWN_EXTERNAL",
      });
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_bid_ladder_legs WHERE close_batch_id IS NOT NULL",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      f.repo.close();
    }
  });
  it("uses only an injected V4 native reference and fails closed when it is unavailable", async () => {
    const f = fixture();
    try {
      const value = await v4BidLadderNativeUsd({
        repo: f.repo,
        rpc: f.rpc,
        reference: async () => ({
          status: "available" as const,
          value: 1,
          blockNumber: 123n,
          source: "V4 test reference",
          sourceTimestamp: new Date(1_000).toISOString(),
          observedAt: new Date(1_000).toISOString(),
        }),
        nowMs: () => 2_000,
      });
      expect(value).toMatchObject({
        nativeUsd: 1,
        nativeUsdSource: "V4 test reference",
      });
      await expect(
        v4BidLadderNativeUsd({
          repo: f.repo,
          rpc: f.rpc,
          reference: async () => ({
            status: "unavailable" as const,
            reason: "V4_REFERENCE_UNAVAILABLE",
          }),
        }),
      ).rejects.toThrow(
        "V4_NATIVE_USD_PRICE_UNAVAILABLE:V4_REFERENCE_UNAVAILABLE",
      );
    } finally {
      f.repo.close();
    }
  });
  it("renders a fresh live preview without mutating ladder, journals, nonce, bindings, or canonical positions", async () => {
    const f = fixture();
    try {
      const before = {
          parent: f.repo.loadBidLadder(f.ladderId),
          legs: f.repo.listBidLadderLegs(f.ladderId),
          journals: f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
            .get(),
          nonces: f.repo.db
            .prepare("SELECT COUNT(*) count FROM chain_nonce_mutex")
            .get(),
        },
        preview = await previewV4BidLadderLive({
          repo: f.repo,
          rpc: f.rpc,
          ladderId: f.ladderId,
          wallet: owner,
          fundingUsd: 1,
          nativeUsd: 1,
          runtime,
          entryPriceFetch: async (token) => ({
            token,
            priceUsd: "1",
            source: "gmgn-token-info-price.price",
            fetchedAtMs: Date.now(),
            freshUntilMs: Date.now() + 30_000,
          }),
        });
      expect(preview.priceGuard).toMatchObject({
        status: "PASS",
        deviationBps: 0n,
      });
      expect(preview.plan.legs).toHaveLength(5);
      expect(preview.blockers).toEqual([]);
      expect(f.repo.loadBidLadder(f.ladderId)).toEqual(before.parent);
      expect(f.repo.listBidLadderLegs(f.ladderId)).toEqual(before.legs);
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual(before.journals);
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM chain_nonce_mutex").get(),
      ).toEqual(before.nonces);
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM v4_positions").get(),
      ).toEqual({ count: 0 });
    } finally {
      f.repo.close();
    }
  });
  it("renders informational current and aligned targeted MC in the readable live layout", async () => {
    const f = fixture(20_000_000n);
    try {
      const preview = await previewV4BidLadderLive({
        repo: f.repo,
        rpc: f.rpc,
        ladderId: f.ladderId,
        wallet: owner,
        fundingUsd: 1,
        nativeUsd: 1,
        runtime,
        marketCapEvidence: { marketCapUsd: 1_000_000, tokenPriceUsd: 1 },
        entryPriceFetch: async (token) => ({
          token,
          priceUsd: "1",
          source: "gmgn-token-info-price.price",
          fetchedAtMs: Date.now(),
          freshUntilMs: Date.now() + 30_000,
        }),
      });
      const text = formatV4BidLadderLivePreview(preview, {
        poolLiquidityLine: "Pool liquidity: $12.3M",
      });
      expect(text).toContain("Current MC: $1M");
      expect(text).toMatch(/Targeted MC range: \$[^\n]+ → \$[^\n]+/);
      expect(text).toContain("Pool liquidity: $12.3M");
      expect(text).toContain("Market\n");
      expect(text).toContain("Ladder\n");
      expect(text).toContain("Capital\n");
      expect(text).toContain("Execution\n");
      expect(text).toMatch(/ticks -\d+ \/ -\d+/);
      expect(text).not.toMatch(/FDV|ATH|liquidity.*MC/i);
      expect(text.indexOf("\nMarket\n")).toBeLessThan(
        text.indexOf("\nLadder\n"),
      );
      expect(text.indexOf("\nLadder\n")).toBeLessThan(
        text.indexOf("\nCapital\n"),
      );
      expect(text.indexOf("\nCapital\n")).toBeLessThan(
        text.indexOf("\nExecution\n"),
      );
    } finally {
      f.repo.close();
    }
  });
  it("keeps MC display fail-soft without changing price safety", () => {
    const target = "0x0000000000000000000000000000000000000011" as const,
      raw = {
        address: target,
        price: { price: "2", volume_1h: "1" },
        circulating_supply: "1000",
        fdv: 999_999_999,
        liquidity: 888_888_888,
        ath_market_cap: 777_777_777,
      };
    expect(
      displayV4BidLadderMarketCapEvidence({
        raw,
        observation: { tokenAddress: target },
        targetAddress: target,
      }),
    ).toEqual({ marketCapUsd: 2_000, tokenPriceUsd: 2 });
    expect(
      displayV4BidLadderMarketCapEvidence({
        raw: { ...raw, circulating_supply: undefined, total_supply: "500" },
        observation: { tokenAddress: target },
        targetAddress: target,
      }),
    ).toEqual({ marketCapUsd: 1_000, tokenPriceUsd: 2 });
    expect(
      displayV4BidLadderMarketCapEvidence({
        raw: { ...raw, circulating_supply: undefined },
        observation: { tokenAddress: target },
        targetAddress: target,
      }),
    ).toBeUndefined();
  });
  it.each([2_000, 20_000])(
    "does not admit or reject from aggregate exposure when OPEN equity is $%s and PLANNED commitments total $50,000",
    async (existingOpenUsd) => {
      const f = fixture(2_000_000_000n);
      try {
        const now = Date.now();
        f.repo.db
          .prepare(
            "UPDATE portfolio_persisted_snapshot SET payload_json=?,refreshed_at_ms=?,last_reconciliation_at_ms=? WHERE snapshot_key='current'",
          )
          .run(
            JSON.stringify({
              positions: [
                {
                  positionId: "existing",
                  status: "open",
                  lifecycle: "CONFIRMED_ACTIVE_FRESH",
                  liquidityRaw: "1",
                  source: "BOT_OPERATIONAL",
                  openIntentId: "existing-open",
                  accounting: { currentEquityUsd: existingOpenUsd },
                },
              ],
              lastReconciliationAt: new Date(now).toISOString(),
            }),
            now,
            now,
          );
        const clone = f.repo.db.prepare(
          "INSERT INTO v4_bid_ladders(ladder_id,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_index,target_index,reference_tick,reference_block,reference_block_hash,total_funding_amount_raw,entry_usd_snapshot,status,created_at_ms,updated_at_ms,revision) SELECT ?,strategy_version,execution_mode,pool_id,currency0,currency1,fee,tick_spacing,hooks,funding_token,target_token,funding_index,target_index,reference_tick,reference_block,reference_block_hash,'2000000000',2000,'PLANNED',?,?,0 FROM v4_bid_ladders WHERE ladder_id=?",
        );
        for (let index = 0; index < 25; index++)
          clone.run(`planned-${index}`, now, now, f.ladderId);
        expect(
          (
            f.repo.db
              .prepare(
                "SELECT SUM(entry_usd_snapshot) total FROM v4_bid_ladders WHERE status='PLANNED' AND ladder_id<>?",
              )
              .get(f.ladderId) as { total: number }
          ).total,
        ).toBe(50_000);
        const preview = await previewV4BidLadderLive({
          repo: f.repo,
          rpc: f.rpc,
          ladderId: f.ladderId,
          wallet: owner,
          fundingUsd: 1,
          nativeUsd: 1,
          runtime: { ...runtime, maxPositionUsd: 2050, maxApprovalUsd: 2050 },
          entryPriceFetch: async (token) => ({
            token,
            priceUsd: "1",
            source: "gmgn-token-info-price.price",
            fetchedAtMs: Date.now(),
            freshUntilMs: Date.now() + 30_000,
          }),
        });
        expect(
          preview.blockers.every((code) => !code.includes("EXPOSURE")),
        ).toBe(true);
        expect(formatV4BidLadderLivePreview(preview)).not.toMatch(
          /Projected exposure/,
        );
      } finally {
        f.repo.close();
      }
    },
  );
  it.each([
    ["position exact", 2_050_000_000n, 2050, 10_000, false],
    ["position over", 2_050_010_000n, 2050, 10_000, true],
    ["approval exact", 2_050_000_000n, 10_000, 2050, false],
    ["approval over", 2_050_010_000n, 10_000, 2050, true],
  ] as const)(
    "preserves strict greater-than cap semantics: %s",
    async (_caseName, amount, maxPositionUsd, maxApprovalUsd, blocked) => {
      const f = fixture(amount);
      try {
        const preview = await previewV4BidLadderLive({
          repo: f.repo,
          rpc: f.rpc,
          ladderId: f.ladderId,
          wallet: owner,
          fundingUsd: 1,
          nativeUsd: 1,
          runtime: { ...runtime, maxPositionUsd, maxApprovalUsd },
          entryPriceFetch: async (token) => ({
            token,
            priceUsd: "1",
            source: "gmgn-token-info-price.price",
            fetchedAtMs: Date.now(),
            freshUntilMs: Date.now() + 30_000,
          }),
        });
        expect(
          preview.blockers.includes(
            "V4_BID_LADDER_POSITION_OR_APPROVAL_CAP_EXCEEDED",
          ),
        ).toBe(blocked);
      } finally {
        f.repo.close();
      }
    },
  );
  it("keeps CLOSE independent from price, swap, router, burn, and cleanup paths", () => {
    const source = readFileSync("apps/cli/src/v4-bid-ladder-live.ts", "utf8"),
      close = source.slice(source.indexOf("async function closeState"));
    expect(close).not.toMatch(/freshLpEntryPriceGuard|BURN_POSITION|cleanup/i);
    const text = formatV4BidLadderClosePreview({
      state: { parent: { ladder_id: "x" } } as any,
      active: [],
      inspected: [],
      composition: [],
      aggregateExpected: { token0: 0n, token1: 0n },
      estimatedGas: null,
      blockers: [],
    } as any);
    expect(text).toContain("Estimated aggregate token0/token1");
    expect(text).toContain("ALL RESULTING ASSETS REMAIN IN WALLET");
  });
  it("requires separate explicit Telegram callbacks for preview and confirmation", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8");
    expect(source).toContain('bidLadderCallback("livePreview", ladderId)');
    expect(source).toContain('bidLadderCallback("liveOpen", ladderId)');
    expect(source).toContain('bidLadderCallback("closePreview", ladderId)');
    expect(source).toContain('bidLadderCallback("closeConfirm", ladderId)');
  });
  it("renders post-broadcast ambiguity as reconciliation pending across OPEN, CLOSE, and manual Reposition", () => {
    const source = readFileSync("apps/telegram-lp-bot/src/index.ts", "utf8"),
      pending = source.slice(
        source.indexOf("function durableReconciliationPendingText"),
        source.indexOf("const amount ="),
      );
    for (const title of [
      "V4_BID_LADDER_OPEN_RECONCILIATION_PENDING",
      "V4_BID_LADDER_CLOSE_RECONCILIATION_PENDING",
      "V4_BID_LADDER_REPOSITION_RECONCILIATION_PENDING",
      "V4_ACTION_RECONCILIATION_PENDING",
    ])
      expect(source).toContain(title);
    expect(pending).toContain("Transaction status is being reconciled.");
    expect(pending).toContain("Do not retry this transaction.");
    expect(pending).toContain("Expected tx:");
    expect(pending).toContain("Nonce:");
    expect(pending).not.toContain("No transaction was sent");
  });
  it("recovers confirmed open and close receipts without invoking the wallet or sending again", async () => {
    const f = fixture(),
      transfer = parseAbiItem(
        "event Transfer(address indexed from,address indexed to,uint256 indexed id)",
      ),
      erc20Transfer = parseAbiItem(
        "event Transfer(address indexed from,address indexed to,uint256 value)",
      ),
      modify = parseAbiItem(
        "event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)",
      ),
      openHash = `0x${"11".repeat(32)}` as Hex,
      closeHash = `0x${"22".repeat(32)}` as Hex,
      receipt = (hash: Hex, logs: any[]) => ({
        status: "success" as const,
        transactionHash: hash,
        blockNumber: 123n,
        blockHash: `0x${"33".repeat(32)}` as Hex,
        transactionIndex: 0,
        from: owner,
        to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
        contractAddress: null,
        cumulativeGasUsed: 1n,
        effectiveGasPrice: 1n,
        gasUsed: 1n,
        logs,
        logsBloom: `0x${"00".repeat(256)}` as Hex,
        type: "legacy" as const,
      });
    try {
      const persist = (
        id: string,
        stage: string,
        nonce: number,
        hash: Hex,
        confirmed: any,
        preparedData?: Hex,
        terminalize = true,
        closeValuation?:Record<string,unknown>,
      ) => {
        f.repo.persistChainPreparedTransaction({
          chainId: 4663,
          chainKey: "robinhood",
          protocol: "uniswap_v4",
          journalId: id,
          wallet: owner,
          workflowIdentity: f.ladderId,
          semanticStage: stage,
          attempt: 0,
          nonce,
          transactionType: stage,
          expectedHash: hash,
          to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          requestFingerprint: id,
          feeModel: "legacy",
        });
        if (preparedData)
          f.repo.db
            .prepare(
              "UPDATE chain_transaction_journal SET provider_evidence_json=? WHERE chain_id=4663 AND journal_id=?",
            )
            .run(
              JSON.stringify({
                ...(closeValuation?{closeValuation}:{}),
                prepared: {
                  expectedHash: hash,
                  requestFingerprint: id,
                  request: {
                    account: owner,
                    chainId: 4663,
                    to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
                    data: preparedData,
                    value: "0",
                    gas: "1",
                    gasPrice: "1",
                    nonce,
                  },
                },
              }),
              id,
            );
        if (terminalize) {
          f.repo.transitionChainTransaction({
            chainId: 4663,
            journalId: id,
            from: "PREPARED",
            to: "SUBMITTED",
          });
          f.repo.transitionChainTransaction({
            chainId: 4663,
            journalId: id,
            from: "SUBMITTED",
            to: "CONFIRMED",
            receipt: confirmed,
          });
        }
      };
      const persistedLegs = f.repo.listBidLadderLegs(f.ladderId),
        openPlan = buildV4BatchMint({
          deadline: 999999n,
          legs: persistedLegs.map((leg) => ({
            key: f.key,
            tickLower: Number(leg.tick_lower),
            tickUpper: Number(leg.tick_upper),
            liquidity: BigInt(String(leg.planned_liquidity_raw)),
            amount0Max: 0n,
            amount1Max: BigInt(String(leg.funding_amount_raw)),
            owner,
            hookData: "0x" as Hex,
            fundingIndex: 1 as const,
          })),
        }),
        openLogs = [
          ...f.preview.plan.legs.map((_, index) => ({
            address: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
            data: "0x" as Hex,
            topics: encodeEventTopics({
              abi: [transfer],
              eventName: "Transfer",
              args: { from: zeroAddress, to: owner, id: 101n + BigInt(index) },
            }) as Hex[],
            logIndex: index,
            transactionHash: openHash,
          })),
          {
            address: c1,
            topics: encodeEventTopics({
              abi: [erc20Transfer],
              eventName: "Transfer",
              args: {
                from: owner,
                to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
              },
            }) as Hex[],
            data: encodeAbiParameters([{ type: "uint256" }], [10_000_000n]),
            logIndex: 5,
            transactionHash: openHash,
          },
        ];
      persist(
        `${f.ladderId}:OPEN_BATCH:0`,
        "OPEN_BATCH",
        7,
        openHash,
        receipt(openHash, openLogs),
        openPlan.calldata,
        false,
      );
      f.repo.db
        .prepare(
          "UPDATE v4_bid_ladders SET execution_mode='LIVE',entry_usd_snapshot=10 WHERE ladder_id=?",
        )
        .run(f.ladderId);
      f.repo.db
        .prepare(
          "INSERT INTO v4_bid_ladder_usdg_reset_v1(ladder_id,root_ladder_id,generation,policy,creation_reason,phase,created_at_ms,updated_at_ms) VALUES(?,?,0,'USDG_RESET_REPOSITION_V1','INITIAL_OPEN','OPEN_PENDING',1000,1000)",
        )
        .run(f.ladderId, f.ladderId);
      f.repo.upsertV4RegistryPool({poolId:poolId(f.key),currency0:f.key.currency0,currency1:f.key.currency1,initializeFeeRaw:f.key.fee,tickSpacing:f.key.tickSpacing,hooks:f.key.hooks,initializationBlock:1n,dynamicFee:false,staticFeePips:f.key.fee,hookClassification:'ZERO_HOOK'});
      f.repo.refreshV4RegistryPool({poolId:poolId(f.key),sqrtPriceX96:f.preview.plan.pool.sqrtPriceX96,tick:f.preview.plan.pool.tick,liquidity:f.preview.plan.pool.liquidity,protocolFee:0,lpFeePips:f.key.fee,initialized:true,refreshBlock:123n,validationStatus:'ELIGIBLE',blockers:[]});
      f.repo.db
        .prepare(
          "UPDATE v4_bid_ladder_legs SET open_batch_id=? WHERE ladder_id=?",
        )
        .run(`${f.ladderId}:OPEN_BATCH:0`, f.ladderId);
      let walletCalls = 0;
      const openTelemetry: Array<{ event: string; data: Record<string, unknown> }> = [];
      const context = {
        repo: f.repo,
        rpc: f.rpc,
        ladderId: f.ladderId,
        wallet: owner,
        fundingUsd: 1,
        nativeUsd: 1,
        runtime,
        telemetry: (event: string, data: Record<string, unknown>) =>
          openTelemetry.push({ event, data }),
        entryPriceFetch: async () => {
          throw new Error("confirmed recovery must not fetch entry price");
        },
        walletClient: new Proxy({} as any, {
          get() {
            walletCalls++;
            throw new Error("wallet must not be invoked");
          },
        }),
      };
      const propagationMiss = await reconcileDurableV4Journals({
        repo: f.repo,
        rpc: f.rpc,
        wallet: owner,
        observe: async () => ({
          kind: "ABSENT",
          latestNonce: 7,
          pendingNonce: 7,
        }),
      });
      expect(propagationMiss).toMatchObject({
        scanned: 1,
        broadcasts: 0,
        signingAttempts: 0,
        mainnetTransactionsSent: 0,
        results: [{ outcome: "UNRESOLVED", evidence: "ABSENT" }],
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT status FROM chain_transaction_journal WHERE journal_id=?",
          )
          .get(`${f.ladderId}:OPEN_BATCH:0`),
      ).toEqual({ status: "PREPARED" });
      const openReceipt = receipt(openHash, openLogs),
        recoveredOpen = await reconcileDurableV4Journals({
          repo: f.repo,
          rpc: f.rpc,
          wallet: owner,
          observe: async () => ({ kind: "RECEIPT", receipt: openReceipt }),
        });
      expect(recoveredOpen.results[0]?.error).toBeUndefined();
      expect(recoveredOpen).toMatchObject({
        scanned: 1,
        broadcasts: 0,
        signingAttempts: 0,
        mainnetTransactionsSent: 0,
        results: [
          { outcome: "CONFIRMED_RECONCILED", semanticStage: "OPEN_BATCH" },
        ],
      });
      expect(
        f.repo
          .listBidLadderLegs(f.ladderId)
          .every((leg) => leg.status === "OPEN" && leg.token_id),
      ).toBe(true);
      expect(
        (recoveredOpen.results[0] as any).reconciliation.canonicalMirror.writes,
      ).toMatchObject({
        positions: 5,
        v4Positions: 5,
        deposits: 5,
        reconciliationMarkers: 5,
      });
      const projected = persistedPositionDisplayItems(f.repo, persistedPositionViews(f.repo));
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({kind:"bid_ladder",ladderId:f.ladderId,lifecycle:"OPEN_CONFIRMING",tokenIds:["101","102","103","104","105"]});
      expect(f.repo.loadBidLadderUsdReset(f.ladderId)?.phase).toBe("OPEN_PENDING");
      expect(f.repo.db.prepare("SELECT lane,priority,reason,attempts,leased_at_ms,lease_owner,leased_until_ms FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?)").get(poolId(f.key))).toEqual({lane:'urgent',priority:900,reason:"OPERATIONAL_OPEN_POOL_FRESHNESS",attempts:0,leased_at_ms:null,lease_owner:null,leased_until_ms:null});
      expect(f.repo.db.prepare("SELECT COUNT(*) count,SUM(CASE WHEN lane='urgent' AND reason='OPERATIONAL_MINT_CONFIRMED' AND priority=1000 AND leased_at_ms IS NULL AND lease_owner IS NULL THEN 1 ELSE 0 END) exact_count FROM targeted_position_reconciliation_requests").get()).toEqual({count:5,exact_count:5});
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_open_freshness_handoffs WHERE ladder_id=? AND lower(transaction_hash)=lower(?)").get(f.ladderId,openHash)).toEqual({count:1});
      const freshnessRequestedAt=Number((f.repo.db.prepare("SELECT requested_at_ms FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?)").get(poolId(f.key)) as {requested_at_ms:number}).requested_at_ms);
      expect(
        f.repo.db
          .prepare(
            "SELECT COUNT(*) count, SUM(CAST(token1_raw AS INTEGER)) total FROM position_deposits",
          )
          .get(),
      ).toEqual({ count: 5, total: 10_000_000 });
      const replayedOpen = await executeV4BidLadderLiveOpen(context);
      expect(replayedOpen.reconciliation!.canonicalMirror.writes).toEqual({
        positions: 0,
        v4Positions: 0,
        deposits: 0,
        reconciliationMarkers: 0,
        legs: 0,
        parent: 0,
      });
      expect(f.repo.db.prepare("SELECT COUNT(*) count,MIN(requested_at_ms) requested_at_ms FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?)").get(poolId(f.key))).toEqual({count:1,requested_at_ms:freshnessRequestedAt});
      expect(replayedOpen).toMatchObject({
        status: "OPEN",
        openDisposition: "ALREADY_OPEN_CONFIRMED",
        receiptConfirmed: true,
        priorReceiptReuse: true,
        postReceiptRecoveryRequired: false,
        userFacingClassification: "OPEN",
        mainnetTransactionsSent: 0,
      });
      const openBusy = Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        }),
        openLockedTransaction = () => {
          const fail = () => {
            throw openBusy;
          };
          return Object.assign(fail, {
            default: fail,
            deferred: fail,
            immediate: fail,
            exclusive: fail,
          });
        };
      f.repo.db
        .prepare("DELETE FROM v4_bid_ladder_open_freshness_handoffs WHERE ladder_id=?")
        .run(f.ladderId);
      f.repo.db
        .prepare("DELETE FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?)")
        .run(poolId(f.key));
      const lockHolder = spawn(
          process.execPath,
          [
            "-e",
            `const Database=require('better-sqlite3'),db=new Database(${JSON.stringify(f.repo.path)});db.pragma('busy_timeout=1');db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);db.exec('COMMIT');db.close();`,
          ],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        ),
        holderReady = new Promise<void>((resolve, reject) => {
          lockHolder.once("error", reject);
          lockHolder.stdout.once("data", (data) =>
            String(data).includes("locked")
              ? resolve()
              : reject(new Error(`lock holder readiness failed: ${String(data)}`)),
          );
        }),
        holderExit = new Promise<number | null>((resolve) =>
          lockHolder.once("exit", resolve),
        );
      await holderReady;
      const contendedReplay = await executeV4BidLadderLiveOpen(context);
      expect(await holderExit).toBe(0);
      expect(contendedReplay).toMatchObject({
        status: "OPEN",
        openDisposition: "ALREADY_OPEN_CONFIRMED",
        receiptConfirmed: true,
        postReceiptRecoveryRequired: false,
        mainnetTransactionsSent: 0,
      });
      expect(openTelemetry).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "v4_bid_ladder_open_receipt_boundary",
            data: expect.objectContaining({
              receiptConfirmed: true,
              executionPhase: "POST_RECEIPT_LOCAL_CONVERGENCE",
              sqliteOperation: "v4_bid_ladder_open_freshness_handoff",
              retryAttempt: 1,
              retryable: true,
              priorReceiptReuse: true,
              postReceiptRecoveryRequired: false,
              userFacingClassification: "OPEN",
              duplicateConfirmSuppressed: true,
            }),
          }),
        ]),
      );
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_bid_ladder_open_freshness_handoffs WHERE ladder_id=?").get(f.ladderId)).toEqual({count:1});
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?)").get(poolId(f.key))).toEqual({count:1});
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM economic_reconciliation_work WHERE workflow_kind='V4_BID_LADDER_OPEN' AND workflow_identity=?").get(f.ladderId)).toEqual({count:1});
      f.repo.db
        .prepare("DELETE FROM v4_bid_ladder_open_freshness_handoffs WHERE ladder_id=?")
        .run(f.ladderId);
      f.repo.db
        .prepare("DELETE FROM v4_state_refresh_queue WHERE lower(pool_id)=lower(?)")
        .run(poolId(f.key));
      const persistentLock = vi
        .spyOn(f.repo.db, "transaction")
        .mockImplementation(openLockedTransaction as any),
        deferredReplay = await executeV4BidLadderLiveOpen(context);
      persistentLock.mockRestore();
      expect(deferredReplay).toMatchObject({
        status: "OPEN",
        openDisposition: "ALREADY_OPEN_CONFIRMED",
        receiptConfirmed: true,
        postReceiptRecoveryRequired: true,
        durableHandoff: true,
        executionPhase: "POST_RECEIPT_RECOVERY_REQUIRED",
        userFacingClassification: "OPEN_REFRESHING",
        mainnetTransactionsSent: 0,
      });
      const convergedAfterDeferral = await executeV4BidLadderLiveOpen(context);
      expect(convergedAfterDeferral).toMatchObject({
        status: "OPEN",
        postReceiptRecoveryRequired: false,
        mainnetTransactionsSent: 0,
      });
      const noWriteReplay = vi
        .spyOn(f.repo.db, "transaction")
        .mockImplementation(() => {
          throw new Error("already-converged duplicate attempted a write transaction");
        });
      const alreadyConverged = await executeV4BidLadderLiveOpen(context);
      noWriteReplay.mockRestore();
      expect(alreadyConverged).toMatchObject({
        status: "OPEN",
        openDisposition: "ALREADY_OPEN_CONFIRMED",
        postReceiptRecoveryRequired: false,
        mainnetTransactionsSent: 0,
      });
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM positions WHERE id IN ('v4:101','v4:102','v4:103','v4:104','v4:105')").get()).toEqual({count:5});
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM v4_positions WHERE open_intent_id=?").get(f.ladderId)).toEqual({count:5});
      expect(f.repo.db.prepare("SELECT COUNT(*) count FROM position_deposits").get()).toEqual({count:5});
      f.repo.db
        .prepare(
          "DELETE FROM targeted_position_reconciliation_requests WHERE position_id='v4:105'",
        )
        .run();
      f.repo.db
        .prepare(
          "DELETE FROM active_position_reconciliations WHERE position_id='v4:105'",
        )
        .run();
      f.repo.db
        .prepare("DELETE FROM position_deposits WHERE position_id='v4:105'")
        .run();
      f.repo.db.prepare("DELETE FROM v4_positions WHERE token_id='105'").run();
      f.repo.db.prepare("DELETE FROM positions WHERE id='v4:105'").run();
      const repairedPartialCycle = await reconcileDurableV4Journals({
          repo: f.repo,
          rpc: f.rpc,
          wallet: owner,
          observe: async () => {
            throw new Error(
              "confirmed continuation must not query transaction evidence again",
            );
          },
        }),
        repairedPartial = repairedPartialCycle.results[0] as any;
      expect(repairedPartial).toMatchObject({
        outcome: "CONFIRMED_RECONCILED",
      });
      expect(
        repairedPartial.reconciliation.canonicalMirror.writes,
      ).toMatchObject({
        positions: 1,
        v4Positions: 1,
        deposits: 1,
        reconciliationMarkers: 1,
      });
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM v4_positions").get(),
      ).toEqual({ count: 5 });
      const collectLegs = f.preview.plan.legs.map((_, index) => ({
          key: f.key,
          tokenId: 101n + BigInt(index),
          hookData: "0x" as Hex,
        })),
        collectPlan = buildV4BatchCollect({
          legs: collectLegs,
          recipient: owner,
          deadline: 999999n,
        });
      const collectReplays:Array<{stage:`COLLECT_BATCH:${string}`;receipt:any}>=[];
      for (const [generation, amounts] of [
        { token0: 100n, token1: 200n },
        { token0: 30n, token1: 40n },
      ].entries()) {
        const authorization =
            generation === 0 ? "a".repeat(18) : "b".repeat(18),
          stage = `COLLECT_BATCH:${authorization}`,
          hash = `0x${(generation === 0 ? "44" : "55").repeat(32)}` as Hex,
          logs = [
            {
              address: c0,
              topics: encodeEventTopics({
                abi: [erc20Transfer],
                eventName: "Transfer",
                args: { from: V4_ROBINHOOD_DEPLOYMENTS.poolManager, to: owner },
              }) as Hex[],
              data: encodeAbiParameters(
                [{ type: "uint256" }],
                [amounts.token0],
              ),
              logIndex: 0,
              transactionHash: hash,
            },
            {
              address: c1,
              topics: encodeEventTopics({
                abi: [erc20Transfer],
                eventName: "Transfer",
                args: { from: V4_ROBINHOOD_DEPLOYMENTS.poolManager, to: owner },
              }) as Hex[],
              data: encodeAbiParameters(
                [{ type: "uint256" }],
                [amounts.token1],
              ),
              logIndex: 1,
              transactionHash: hash,
            },
          ];
        persist(
          `${f.ladderId}:${stage}:0`,
          stage,
          8 + generation,
          hash,
          receipt(hash, logs),
          collectPlan.calldata,
          false,
        );
        const recovered = await reconcileDurableV4Journals({
          repo: f.repo,
          rpc: f.rpc,
          wallet: owner,
          observe: async () => ({
            kind: "RECEIPT",
            receipt: receipt(hash, logs),
          }),
        });
        expect(recovered.results[0]?.error).toBeUndefined();
        expect(recovered.results[0]).toMatchObject({
          outcome: "CONFIRMED_RECONCILED",
          semanticStage: stage,
        });
        collectReplays.push({stage:stage as `COLLECT_BATCH:${string}`,receipt:receipt(hash,logs)});
      }
      const cumulative = f.repo.db
        .prepare(
          "SELECT token0_raw,token1_raw,principal0_raw,principal1_raw FROM collections WHERE tx_hash IN (?,?)",
        )
        .all(`0x${"44".repeat(32)}`, `0x${"55".repeat(32)}`) as Array<
        Record<string, string>
      >;
      expect(
        cumulative.reduce(
          (sum, row) => ({
            token0: sum.token0 + BigInt(row.token0_raw),
            token1: sum.token1 + BigInt(row.token1_raw),
            principal0: sum.principal0 + BigInt(row.principal0_raw),
            principal1: sum.principal1 + BigInt(row.principal1_raw),
          }),
          { token0: 0n, token1: 0n, principal0: 0n, principal1: 0n },
        ),
      ).toEqual({ token0: 130n, token1: 240n, principal0: 0n, principal1: 0n });
      const claimEvents=f.repo.db.prepare("SELECT valuation_status,realized_pnl_usd,newly_realized_fees_usd,valuation_evidence_json FROM realized_pnl_events WHERE event_kind='CLAIM' ORDER BY economic_final_at_ms,event_id").all() as Record<string,unknown>[];
      expect(claimEvents).toHaveLength(2);expect(claimEvents.every(row=>row.valuation_status==="AVAILABLE"&&row.realized_pnl_usd===row.newly_realized_fees_usd)).toBe(true);expect(claimEvents.map(row=>JSON.parse(String(row.valuation_evidence_json)))).toEqual(expect.arrayContaining([expect.objectContaining({contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V2",sanityStatus:"AVAILABLE",sameBlockLaterPoolSwaps:0,evidenceSource:"ARCHIVAL_STATEVIEW_BLOCK_END_NO_LATER_POOL_SWAP"})]));
      const economicSnapshot=()=>({collections:f.repo.db.prepare("SELECT COUNT(*) count,SUM(CAST(fee0_raw AS INTEGER)) fee0,SUM(CAST(fee1_raw AS INTEGER)) fee1 FROM collections").get(),feeClaims:f.repo.db.prepare("SELECT COUNT(*) count,SUM(CAST(token0_raw AS INTEGER)) token0,SUM(CAST(token1_raw AS INTEGER)) token1 FROM fee_claims").get(),positions:f.repo.db.prepare("SELECT SUM(CAST(claimed_fee0_raw AS INTEGER)) fee0,SUM(CAST(claimed_fee1_raw AS INTEGER)) fee1 FROM v4_positions").get(),events:f.repo.db.prepare("SELECT COUNT(*) count,SUM(CAST(realized_pnl_usd AS REAL)) pnl FROM realized_pnl_events WHERE event_kind='CLAIM'").get()}),beforeReplay=economicSnapshot();
      await reconcileConfirmedV4BidLadderJournal({...context,semanticStage:collectReplays[0]!.stage,receipt:collectReplays[0]!.receipt});
      expect(economicSnapshot()).toEqual(beforeReplay);
      expect(
        f.repo
          .listV4Positions()
          .every((position) => BigInt(String(position.liquidity_raw)) > 0n),
      ).toBe(true);
      const closeLegs = f.preview.plan.legs.map((leg, index) => ({
          key: f.key,
          tokenId: 101n + BigInt(index),
          liquidity: leg.mint.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          hookData: "0x" as Hex,
        })),
        plan = buildV4BatchFullDecrease({
          legs: closeLegs,
          recipient: owner,
          deadline: 999999n,
        }),
        closeLogs = closeLegs.map((leg, index) => ({
          address: V4_ROBINHOOD_DEPLOYMENTS.poolManager,
          topics: encodeEventTopics({
            abi: [modify],
            eventName: "ModifyLiquidity",
            args: {
              id: poolId(f.key),
              sender: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
            },
          }) as Hex[],
          data: encodeAbiParameters(
            [
              { type: "int24" },
              { type: "int24" },
              { type: "int256" },
              { type: "bytes32" },
            ],
            [
              f.preview.plan.legs[index]!.tickLower,
              f.preview.plan.legs[index]!.tickUpper,
              -leg.liquidity,
              toHex(leg.tokenId, { size: 32 }),
            ],
          ),
          logIndex: index,
          transactionHash: closeHash,
        }));
      persist(
        `${f.ladderId}:CLOSE_BATCH:0`,
        "CLOSE_BATCH",
        10,
        closeHash,
        receipt(closeHash, closeLogs),
        plan.calldata,
        false,
        {contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V1",poolId:poolId(f.key),poolKey:f.key,sqrtPriceX96:f.preview.plan.pool.sqrtPriceX96.toString(),tick:f.preview.plan.pool.tick,activeLiquidity:f.preview.plan.pool.liquidity.toString(),initialized:f.preview.plan.pool.initialized,observationBlock:f.preview.plan.pool.blockNumber.toString(),observedAtMs:1_000,token0Decimals:18,token1Decimals:6},
      );
      f.repo.db
        .prepare(
          "UPDATE v4_bid_ladder_legs SET close_batch_id=? WHERE ladder_id=? AND status='OPEN'",
        )
        .run(`${f.ladderId}:CLOSE_BATCH:0`, f.ladderId);
      f.closePositions();
      const recoveredClose = await reconcileDurableV4Journals({
        repo: f.repo,
        rpc: f.rpc,
        wallet: owner,
        observe: async () => ({
          kind: "RECEIPT",
          receipt: receipt(closeHash, closeLogs),
        }),
      });
      expect(recoveredClose).toMatchObject({
        scanned: 1,
        broadcasts: 0,
        signingAttempts: 0,
        mainnetTransactionsSent: 0,
        results: [
          { outcome: "CONFIRMED_RECONCILED", semanticStage: "CLOSE_BATCH" },
        ],
      });
      const closed = await executeV4BidLadderManualClose(context);
      expect(closed).toMatchObject({
        status: "CLOSED",
        mainnetTransactionsSent: 0,
      });
      expect(f.repo.loadBidLadder(f.ladderId)).toMatchObject({
        status: "CLOSED",
        close_provenance: "FUNI_EXECUTED",
      });
      expect(f.repo.loadBidLadderUsdReset(f.ladderId)).toMatchObject({
        phase: "OPERATOR_CLOSED",
        close_reason: "NORMAL_OPERATOR_CLOSE",
        next_ladder_id: null,
      });
      expect(
        f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM v4_positions WHERE status='closed' AND liquidity_raw='0'",
          )
          .get(),
      ).toEqual({ count: 5 });
      expect(
        f.repo.db.prepare("SELECT COUNT(*) count FROM position_deposits").get(),
      ).toEqual({ count: 5 });
      const realized=f.repo.db.prepare("SELECT valuation_status,realized_pnl_usd,valuation_evidence_json,presentation_metadata_json FROM realized_pnl_events WHERE event_kind='CLOSE'").get() as Record<string,unknown>;
      expect(realized.valuation_status).toBe("AVAILABLE");expect(realized.realized_pnl_usd).toBe("-10");expect(JSON.parse(String(realized.valuation_evidence_json))).toMatchObject({contract:"DIRECT_V4_POOL_SQRT_PRICE_CAPTURE_V2",sanityStatus:"AVAILABLE",poolId:poolId(f.key)});expect(JSON.parse(String(realized.presentation_metadata_json))).toMatchObject({pair:"TOKEN/USDG",openedAtSource:"OPEN_RECEIPT_BLOCK_TIMESTAMP"});
      const busy = Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        }),
        lockedTransaction = () => {
          const fail = () => {
            throw busy;
          };
          return Object.assign(fail, {
            default: fail,
            deferred: fail,
            immediate: fail,
            exclusive: fail,
          });
        },
        transactionSpy = vi
          .spyOn(f.repo.db, "transaction")
          .mockImplementation(lockedTransaction as any);
      let postBroadcastError: unknown;
      try {
        await executeV4BidLadderManualClose(context);
      } catch (error) {
        postBroadcastError = error;
      } finally {
        transactionSpy.mockRestore();
      }
      expect(postBroadcastError).toBeUndefined();
      expect(durableTransactionReconciliationPending(postBroadcastError)).toBeUndefined();
      const replayedClose = await executeV4BidLadderManualClose(context);
      expect(replayedClose.reconciliation.canonicalMirror.writes).toEqual({
        positions: 0,
        v4Positions: 0,
        legs: 0,
        parent: 0,
      });
      expect(f.repo.db.prepare("SELECT status FROM economic_reconciliation_work WHERE workflow_kind='V4_BID_LADDER_CLOSE'").get()).toEqual({status:'PENDING'});
      expect(walletCalls).toBe(0);
      expect(
        f.repo.db
          .prepare("SELECT COUNT(*) count FROM chain_transaction_journal")
          .get(),
      ).toEqual({ count: 4 });
    } finally {
      f.repo.close();
    }
  });
  it("applies exact-receipt, latest-nonce, and inconclusive durable truth without a broadcast path", async () => {
    const source = readFileSync(
      "apps/cli/src/v4-durable-journal-reconcile.ts",
      "utf8",
    );
    expect(source).not.toMatch(
      /eth_sendRawTransaction|broadcastSignedTransaction|signWithConfiguredAccount|walletClient|acquireNonceMutex/,
    );
    for (const scenario of [
      "revert",
      "consumed",
      "available",
      "inconclusive",
      "wrong-target",
    ] as const) {
      const f = fixture(),
        hash =
          `0x${scenario.length.toString(16).padStart(2, "0").repeat(32)}` as Hex;
      try {
        f.repo.db
          .prepare(
            "UPDATE v4_bid_ladders SET execution_mode='LIVE' WHERE ladder_id=?",
          )
          .run(f.ladderId);
        f.repo.persistChainPreparedTransaction({
          chainId: 4663,
          chainKey: "robinhood",
          protocol: "uniswap_v4",
          journalId: `${f.ladderId}:OPEN_BATCH:0`,
          wallet: owner,
          workflowIdentity: f.ladderId,
          semanticStage: "OPEN_BATCH",
          attempt: 0,
          nonce: 9,
          transactionType: "OPEN_BATCH",
          expectedHash: hash,
          to: V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          requestFingerprint: scenario,
          feeModel: "legacy",
        });
        const unresolvedBefore = f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=4663 AND wallet_address=? AND status IN ('PREPARED','SUBMITTED')",
          )
          .get(owner);
        expect(unresolvedBefore).toEqual({ count: 1 });
        const reverted = {
          status: "reverted" as const,
          transactionHash: hash,
          blockNumber: 10n,
          blockHash: `0x${"44".repeat(32)}` as Hex,
          transactionIndex: 0,
          from: owner,
          to:
            scenario === "wrong-target"
              ? c0
              : V4_ROBINHOOD_DEPLOYMENTS.positionManager,
          contractAddress: null,
          cumulativeGasUsed: 1n,
          effectiveGasPrice: 1n,
          gasUsed: 1n,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}` as Hex,
          type: "legacy" as const,
        };
        const observed =
          scenario === "revert" || scenario === "wrong-target"
            ? { kind: "RECEIPT" as const, receipt: reverted }
            : scenario === "consumed"
              ? { kind: "ABSENT" as const, latestNonce: 10, pendingNonce: 10 }
              : scenario === "available"
                ? { kind: "ABSENT" as const, latestNonce: 9, pendingNonce: 10 }
                : {
                    kind: "INCONCLUSIVE" as const,
                    reason: "PROVIDER_ERROR" as const,
                  };
        const result = await reconcileDurableV4Journals({
          repo: f.repo,
          rpc: f.rpc,
          wallet: owner,
          observe: async () => observed,
        });
        const journal = f.repo.db
          .prepare(
            "SELECT status,failure_reason FROM chain_transaction_journal WHERE journal_id=?",
          )
          .get(`${f.ladderId}:OPEN_BATCH:0`);
        if (scenario === "revert") {
          expect(journal).toEqual({
            status: "FAILED",
            failure_reason: "TRANSACTION_REVERTED",
          });
          expect(result.results[0]).toMatchObject({
            outcome: "FAILED",
            failureReason: "TRANSACTION_REVERTED",
          });
        } else if (scenario === "consumed") {
          expect(journal).toEqual({
            status: "FAILED",
            failure_reason: "NONCE_NO_LONGER_AVAILABLE",
          });
          expect(result.results[0]).toMatchObject({
            outcome: "FAILED",
            failureReason: "NONCE_NO_LONGER_AVAILABLE",
          });
        } else if (scenario === "wrong-target") {
          expect(journal).toEqual({ status: "PREPARED", failure_reason: null });
          expect(result.results[0]).toMatchObject({
            outcome: "FINALIZATION_FAILED",
            error: "V4_DURABLE_RECOVERY_RECEIPT_IDENTITY_MISMATCH",
          });
        } else {
          expect(journal).toEqual({ status: "PREPARED", failure_reason: null });
          expect(result.results[0]).toMatchObject({ outcome: "UNRESOLVED" });
        }
        expect(
          f.repo.db.prepare("SELECT COUNT(*) count FROM v4_positions").get(),
        ).toEqual({ count: 0 });
        expect(result).toMatchObject({
          broadcasts: 0,
          signingAttempts: 0,
          mainnetTransactionsSent: 0,
        });
        const unresolvedAfter = f.repo.db
          .prepare(
            "SELECT COUNT(*) count FROM chain_transaction_journal WHERE chain_id=4663 AND wallet_address=? AND status IN ('PREPARED','SUBMITTED')",
          )
          .get(owner);
        expect(unresolvedAfter).toEqual({
          count: ["revert", "consumed"].includes(scenario) ? 0 : 1,
        });
      } finally {
        f.repo.close();
      }
    }
  });
});
