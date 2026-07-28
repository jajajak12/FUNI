import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWalletClient,
  decodeEventLog,
  http,
  parseEther,
  type Address,
  type Hash,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  auditRobinhoodV3PinnedTestSnapshot,
  discoverV3Pools,
  erc20Abi,
  FallbackRpc,
  inspectV3Pool,
  PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT,
  robinhoodMainnet,
} from '@robin/core';
import { buildApproval, presentPool } from '@robin/v3';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import {
  executeGuardedSingleSidedCanary,
  ReceiptWaitInterrupted,
  recoverGuardedSingleSidedCanary,
  type GuardedCanaryInput,
} from './guarded-canary.js';
import { executePreparedCanaryRoute } from './live-canary-route.js';
import { startPinnedFork } from './fork-fixture.js';
import { dedicatedWallet, runtimeEnv, runtimePaths, runtimeRpc } from './runtime.js';

const chain = {
  id: 4663,
  name: 'fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
} as const;
const wethAbi = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;
const routerAbi = [{
  type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
  inputs: [{ type: 'tuple', components: [
    { type: 'address', name: 'tokenIn' }, { type: 'address', name: 'tokenOut' },
    { type: 'uint24', name: 'fee' }, { type: 'address', name: 'recipient' },
    { type: 'uint256', name: 'amountIn' }, { type: 'uint256', name: 'amountOutMinimum' },
    { type: 'uint160', name: 'sqrtPriceLimitX96' },
  ] }], outputs: [{ type: 'uint256' }],
}] as const;
const quoterAbi = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ type: 'tuple', components: [
    { type: 'address', name: 'tokenIn' }, { type: 'address', name: 'tokenOut' },
    { type: 'uint256', name: 'amountIn' }, { type: 'uint24', name: 'fee' },
    { type: 'uint160', name: 'sqrtPriceLimitX96' },
  ] }], outputs: [{ type: 'uint256' }],
}] as const;
const transferEvent = [{
  type: 'event', name: 'Transfer', inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
}] as const;
const WRITE_METHODS = new Set(['eth_sendTransaction', 'eth_sendRawTransaction']);
const EXPECTED_STATES = [
  'PREVIEWED', 'FINAL_SIMULATION_PASSED', 'APPROVAL_REQUIRED', 'APPROVAL_SUBMITTED',
  'APPROVAL_CONFIRMED', 'RANGE_REFRESHED', 'MINT_SIMULATION_PASSED', 'MINT_SUBMITTED',
  'MINT_CONFIRMED', 'POSITION_RECONCILED',
];
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`ASSERTION_FAILED: ${message}`);
};

export async function awaitGuardedHookOrEarlyExit<T extends { status?:string;reason?:unknown }>(hook:Promise<void>,execution:Promise<T>,phase:string,timeoutMs=60_000):Promise<void>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<{kind:'timeout'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),timeoutMs);});
 const outcome=await Promise.race([
  hook.then(()=>({kind:'hook'} as const)),
  execution.then(value=>({kind:'execution' as const,value}),error=>({kind:'execution-error' as const,error})),
  timeout,
 ]);
 if(timer)clearTimeout(timer);
 if(outcome.kind==='hook')return;
 if(outcome.kind==='execution')throw new Error(`${phase}_NOT_REACHED: executor terminated with ${outcome.value.status??'unknown'}: ${String(outcome.value.reason??'no reason')}`);
 if(outcome.kind==='execution-error')throw outcome.error;
 throw new Error(`${phase}_TIMEOUT_AFTER_${timeoutMs}MS`);
}

function isLoopback(url: string) {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function guardWriteTarget(url: string, method: string) {
  if (WRITE_METHODS.has(method) && !isLoopback(url)) {
    throw new Error(`NON_LOCAL_RPC_WRITE_BLOCKED: ${method} ${url}`);
  }
}

function guardedHttp(url: string, writes: Array<{ method: string; url: string }>): Transport {
  const base = http(url);
  return ((options: any) => {
    const transport = base(options);
    return {
      ...transport,
      request: async (request: any) => {
        guardWriteTarget(url, request.method);
        if (WRITE_METHODS.has(request.method)) writes.push({ method: request.method, url });
        return transport.request(request);
      },
    };
  }) as Transport;
}

function fileProof(path: string) {
  if (!existsSync(path)) return { exists: false, sha256: null, mtimeMs: null, size: null };
  const stat = statSync(path);
  return {
    exists: true,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

async function productionNonce() {
  const address = dedicatedWallet().address;
  if (!address) return null;
  return runtimeRpc.withClient(client => client.getTransactionCount({ address, blockTag: 'pending' }));
}

async function mainnetHasReceipt(hash: Hash) {
  try {
    await runtimeRpc.withClient(client => client.getTransactionReceipt({ hash }));
    return true;
  } catch {
    return false;
  }
}

function counts(repo: SqliteLedgerRepository, intentId: string) {
  const scalar = (sql: string, ...args: unknown[]) => Number((repo.db.prepare(sql).get(...args) as { count: number }).count);
  return {
    approvalSubmissions: scalar("SELECT COUNT(*) count FROM canary_execution_transitions WHERE intent_id=? AND state='APPROVAL_SUBMITTED'", intentId),
    mintSubmissions: scalar("SELECT COUNT(*) count FROM canary_execution_transitions WHERE intent_id=? AND state='MINT_SUBMITTED'", intentId),
    receipts: scalar('SELECT COUNT(*) count FROM transaction_receipts WHERE intent_id=?', intentId),
    positions: scalar("SELECT COUNT(*) count FROM positions WHERE id IN (SELECT 'live:' || token_id FROM canary_execution_intents WHERE id=?)", intentId),
    deposits: scalar("SELECT COUNT(*) count FROM position_deposits WHERE position_id IN (SELECT 'live:' || token_id FROM canary_execution_intents WHERE id=?)", intentId),
  };
}

export async function runGuardedCanaryE2E() {
  const fork = await startPinnedFork();
  const artifactPath = join(fork.dir, 'guarded-canary-e2e.json');
  const artifact: Record<string, unknown> = { artifactPath, localRpcUrl: fork.url, anvilLog: fork.logPath };
  const writes: Array<{ method: string; url: string }> = [];
  const productionBefore = {
    nonce: await productionNonce(),
    database: fileProof(runtimePaths.databasePath),
    flags: {
      EXECUTION_ENABLED: runtimeEnv.EXECUTION_ENABLED,
      DRY_RUN: runtimeEnv.DRY_RUN,
      EMERGENCY_PAUSE: runtimeEnv.EMERGENCY_PAUSE,
      LIVE_CANARY_ENABLED: runtimeEnv.LIVE_CANARY_ENABLED,
    },
  };
  artifact.productionBefore = productionBefore;

  try {
    const blockedMethods: string[] = [];
    for (const method of WRITE_METHODS) {
      try { guardWriteTarget(runtimeEnv.RH_RPC_URL, method); } catch { blockedMethods.push(method); }
    }
    assert(blockedMethods.length === WRITE_METHODS.size, 'non-local write guard did not block both send methods');
    const rpc = new FallbackRpc({ ...robinhoodMainnet, rpcUrls: [fork.url] });
    const snapshotVerification={mode:PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT,rpcUrl:fork.url,productionExecutionEnabled:false} as const;
    const registry = await auditRobinhoodV3PinnedTestSnapshot(rpc,snapshotVerification);
    if (registry.status === 'unavailable') throw new Error(registry.reason);
    artifact.deploymentVerification={mode:snapshotVerification.mode,provenance:registry.provenance,verificationBlock:registry.value.verificationBlock,codeHashes:Object.fromEntries(Object.entries(registry.value.records).map(([name,record])=>[name,record.runtimeCodeHash]))};

    const operator = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const trader = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cda8d0cc');
    const operatorWallet = createWalletClient({ account: operator, chain, transport: guardedHttp(fork.url, writes) });
    const traderWallet = createWalletClient({ account: trader, chain, transport: guardedHttp(fork.url, writes) });
    for (const account of [operator, trader]) {
      await (fork.client as any).request({ method: 'anvil_setBalance', params: [account.address, '0x3635C9ADC5DEA00000'] });
    }
    const weth = robinhoodMainnet.assets.WETH;
    await fork.client.waitForTransactionReceipt({ hash: await operatorWallet.writeContract({ address: weth, abi: wethAbi, functionName: 'deposit', value: parseEther('12') }) });
    await fork.client.waitForTransactionReceipt({ hash: await traderWallet.writeContract({ address: weth, abi: wethAbi, functionName: 'deposit', value: parseEther('6') }) });
    const pools = await discoverV3Pools(rpc, registry, weth);
    if (pools.status === 'unavailable') throw new Error(pools.reason);
    const pool = pools.value.filter(item => item.liquidity > 0n).sort((a, b) => a.fee - b.fee)[0];
    if (!pool) throw new Error('no funded WETH pool');
    const shown = await presentPool(rpc, pool);
    if (shown.status === 'unavailable') throw new Error(shown.reason);
    const funding = shown.value.token0.address.toLowerCase() === weth.toLowerCase() ? shown.value.token1 : shown.value.token0;
    const target = shown.value.token0.address.toLowerCase() === funding.address.toLowerCase() ? shown.value.token1 : shown.value.token0;
    assert(target.address.toLowerCase() === weth.toLowerCase(), 'fixture target must be WETH');

    const approveAndWait = async (wallet: typeof operatorWallet, token: Address, spender: Address, amount: bigint) => {
      const hash = await wallet.sendTransaction(buildApproval(token, spender, amount));
      await fork.client.waitForTransactionReceipt({ hash });
      return hash;
    };
    const swap = async (wallet: typeof operatorWallet, tokenIn: Address, tokenOut: Address, amountIn: bigint) => {
      const quote = await fork.client.simulateContract({
        account: wallet.account!, address: registry.value.quoter, abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
      });
      const amountOut = BigInt(quote.result as bigint);
      const hash = await wallet.writeContract({
        address: registry.value.swapRouter, abi: routerAbi, functionName: 'exactInputSingle',
        args: [{ tokenIn, tokenOut, fee: pool.fee, recipient: wallet.account!.address, amountIn, amountOutMinimum: amountOut * 9_900n / 10_000n, sqrtPriceLimitX96: 0n }],
      });
      await fork.client.waitForTransactionReceipt({ hash });
      return hash;
    };
    await approveAndWait(operatorWallet, weth, registry.value.swapRouter, parseEther('12'));
    await swap(operatorWallet, weth, funding.address, parseEther('12'));
    await approveAndWait(traderWallet as typeof operatorWallet, weth, registry.value.swapRouter, parseEther('6'));
    assert(await fork.client.readContract({ address: target.address, abi: erc20Abi, functionName: 'balanceOf', args: [operator.address] }) === 0n, 'operator target balance is not zero');
    const baseSnapshot = await (fork.client as any).request({ method: 'evm_snapshot', params: [] }) as string;
    let snapshot = baseSnapshot;
    const resetChain = async () => {
      assert(await (fork.client as any).request({ method: 'evm_revert', params: [snapshot] }), 'Anvil snapshot revert failed');
      snapshot = await (fork.client as any).request({ method: 'evm_snapshot', params: [] }) as string;
    };
    const newRepo = (name: string) => {
      const dbPath = join(fork.dir, `${name}.sqlite`);
      migrateSqlite(dbPath, join(process.cwd(), 'infra/migrations'));
      return { dbPath, repo: new SqliteLedgerRepository(dbPath) };
    };
    const prepareIntent = (repo: SqliteLedgerRepository, key: string) => {
      const intent = repo.createCanaryIntent({ wallet: operator.address, owner: key, idempotencyKey: key, payload: { capUsd: 5 } });
      return { intentId: String(intent.id) };
    };
    const makeInput = (repo: SqliteLedgerRepository, intentId: string): GuardedCanaryInput => ({
      repo, rpc, walletClient: operatorWallet, wallet: operator.address, owner: 'local',
      pool: pool.address, target, funding, fundingAmount: 5_000_000n,
      upperDropPct: 0, lowerDropPct: 10, slippageBps: 50, deadlineSeconds: 600,
      maxGasUsd: 100, gasUsdPerNative: 1, intentId, notify: async () => {},
      pinnedDeploymentSnapshot:snapshotVerification,
    });
    const inspectTick = async () => {
      const state = await inspectV3Pool(rpc, pool.address);
      if (state.status === 'unavailable') throw new Error(state.reason);
      return state.value.tick;
    };

    // Happy path + real post-approval price movement + concurrent duplicate.
    const happyStore = newRepo('happy');
    const happyIntent = prepareIntent(happyStore.repo, 'happy');
    let hookEntered!: () => void;
    const entered = new Promise<void>(resolve => { hookEntered = resolve; });
    let releaseHook!: () => void;
    const release = new Promise<void>(resolve => { releaseHook = resolve; });
    let staleSwapHash: Hash | undefined;
    let hookPreviewTick: number | undefined;
    const happyInput = makeInput(happyStore.repo, happyIntent.intentId);
    happyInput.hooks = {
      afterApprovalConfirmed: async context => {
        hookPreviewTick = context.preview.tick;
        staleSwapHash = await swap(traderWallet as typeof operatorWallet, weth, funding.address, parseEther('6'));
        const postSwapTick=await inspectTick();
        assert(postSwapTick !== hookPreviewTick, `real trader swap did not change pool tick: ${hookPreviewTick} -> ${postSwapTick}`);
        hookEntered();
        await release;
      },
    };
    const firstPromise = executeGuardedSingleSidedCanary(happyInput);
    try{await awaitGuardedHookOrEarlyExit(entered,firstPromise,'AFTER_APPROVAL_CONFIRMED');}catch(error){releaseHook();throw error;}
    const duplicateResult = await executeGuardedSingleSidedCanary(makeInput(happyStore.repo, happyIntent.intentId));
    releaseHook();
    const happyResult = await firstPromise;
    assert(happyResult.ok && happyResult.status === 'COMPLETED', 'happy production executor did not complete');
    assert(duplicateResult.status === 'ALREADY_PROCESSING', 'concurrent duplicate was not rejected');
    assert(happyResult.preview.tick !== happyResult.refreshed.tick, 'preview and refreshed ticks are equal');
    assert(happyResult.preview.calldataHash !== happyResult.refreshed.calldataHash, 'stale calldata hash was reused');
    assert(happyResult.refreshed.tickLower !== happyResult.preview.tickLower || happyResult.refreshed.tickUpper !== happyResult.preview.tickUpper, 'range ticks were not reconstructed');
    const fundingIs0 = funding.address.toLowerCase() === shown.value.token0.address.toLowerCase();
    assert(fundingIs0 ? happyResult.refreshed.amount1Desired === 0n : happyResult.refreshed.amount0Desired === 0n, 'target desired amount is nonzero');
    assert(fundingIs0 ? happyResult.refreshed.tickLower > happyResult.refreshed.tick : happyResult.refreshed.tickUpper <= happyResult.refreshed.tick, 'refreshed position is not funding-only');
    const sequentialDuplicates = await Promise.all([
      executeGuardedSingleSidedCanary(makeInput(happyStore.repo, happyIntent.intentId)),
      executeGuardedSingleSidedCanary(makeInput(happyStore.repo, happyIntent.intentId)),
    ]);
    assert(sequentialDuplicates.every(item => item.status === 'ALREADY_COMPLETED'), 'completed duplicate invocation was not idempotent');
    const happyCounts = counts(happyStore.repo, happyIntent.intentId);
    assert(happyCounts.approvalSubmissions === 1 && happyCounts.mintSubmissions === 1, 'duplicate transaction transition detected');
    assert(happyCounts.positions === 1 && happyCounts.deposits === 1, 'duplicate position or deposit detected');
    const transitions = happyStore.repo.canaryIntentTransitions(happyIntent.intentId);
    assert(json(transitions.map(item => item.state)) === json(EXPECTED_STATES), 'persisted happy-path states are missing, duplicated, or out of order');
    const approvalHash = happyResult.approvalHash!;
    const mintHash = happyResult.mintHash;
    const mintReceipt = await fork.client.getTransactionReceipt({ hash: mintHash });
    const targetTransfers = mintReceipt.logs.filter(log => log.address.toLowerCase() === target.address.toLowerCase()).flatMap(log => {
      try { return [decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics as any })]; } catch { return []; }
    });
    const targetAllowance = await fork.client.readContract({ address: target.address, abi: erc20Abi, functionName: 'allowance', args: [operator.address, registry.value.positionManager] });
    const fundingAllowance = await fork.client.readContract({ address: funding.address, abi: erc20Abi, functionName: 'allowance', args: [operator.address, registry.value.positionManager] });
    assert(targetAllowance === 0n && targetTransfers.length === 0, 'target approval or transfer was observed');
    assert(fundingAllowance <= 5_000_000n, 'approval exceeded the exact canary amount');
    const beforeReconcile = happyStore.repo.reconciliationDelta(`live:${happyResult.tokenId}`);
    happyStore.repo.reconcileAll();
    const afterReconcile = happyStore.repo.reconciliationDelta(`live:${happyResult.tokenId}`);
    assert(json(beforeReconcile) === json(afterReconcile), 'second reconciliation changed accounting');
    artifact.happyPath = {
      dbPath: happyStore.dbPath, intentId: happyIntent.intentId, transitions,
      approvalHash, mintHash, nftId: happyResult.tokenId, counts: happyCounts,
      preview: happyResult.preview, refreshed: happyResult.refreshed,
      staleSwapHash, targetTransfers: targetTransfers.length, targetAllowance,
      fundingAllowance, noArmRequired: true,
      duplicateResult, completedDuplicateResults: sequentialDuplicates,
      secondReconciliationDelta: { before: beforeReconcile, after: afterReconcile, change: 0 },
    };
    happyStore.repo.close();

    // Approval receipt timeout, repository restart, and hash-based continuation.
    await resetChain();
    const approvalStore = newRepo('approval-timeout');
    const approvalIntent = prepareIntent(approvalStore.repo, 'approval-timeout');
    const approvalInput = makeInput(approvalStore.repo, approvalIntent.intentId);
    approvalInput.hooks = { beforeApprovalReceiptWait: () => { throw new ReceiptWaitInterrupted('APPROVAL'); } };
    const approvalInterrupted = await executeGuardedSingleSidedCanary(approvalInput);
    const submittedApproval = approvalStore.repo.canaryIntent(approvalIntent.intentId)?.approval_hash as Hash;
    assert(approvalInterrupted.status === 'RECOVERY_REQUIRED' && submittedApproval, 'approval timeout did not preserve submitted hash');
    approvalStore.repo.close();
    const approvalRepo2 = new SqliteLedgerRepository(approvalStore.dbPath);
    const approvalRecovered = await recoverGuardedSingleSidedCanary(makeInput(approvalRepo2, approvalIntent.intentId));
    assert(approvalRecovered.ok, 'approval timeout recovery failed');
    await fork.client.getTransactionReceipt({ hash: submittedApproval });
    await fork.client.getTransactionReceipt({ hash: approvalRecovered.mintHash });
    const approvalCounts = counts(approvalRepo2, approvalIntent.intentId);
    assert(approvalCounts.approvalSubmissions === 1, 'approval recovery submitted a duplicate approval');
    artifact.approvalTimeoutRecovery = { recoveredHash: submittedApproval, result: approvalRecovered, counts: approvalCounts, transitions: approvalRepo2.canaryIntentTransitions(approvalIntent.intentId) };
    approvalRepo2.close();

    // Mint receipt timeout, repository restart, NFT recovery from existing receipt.
    await resetChain();
    const mintStore = newRepo('mint-timeout');
    const mintIntent = prepareIntent(mintStore.repo, 'mint-timeout');
    const mintInput = makeInput(mintStore.repo, mintIntent.intentId);
    mintInput.hooks = { beforeMintReceiptWait: () => { throw new ReceiptWaitInterrupted('MINT'); } };
    const mintInterrupted = await executeGuardedSingleSidedCanary(mintInput);
    const submittedMint = mintStore.repo.canaryIntent(mintIntent.intentId)?.mint_hash as Hash;
    assert(mintInterrupted.status === 'RECOVERY_REQUIRED' && submittedMint, 'mint timeout did not preserve submitted hash');
    mintStore.repo.close();
    const mintRepo2 = new SqliteLedgerRepository(mintStore.dbPath);
    const mintRecovered = await recoverGuardedSingleSidedCanary(makeInput(mintRepo2, mintIntent.intentId));
    assert(mintRecovered.ok, 'mint timeout recovery failed');
    await fork.client.getTransactionReceipt({ hash: submittedMint });
    const mintCounts = counts(mintRepo2, mintIntent.intentId);
    assert(mintCounts.mintSubmissions === 1 && mintCounts.positions === 1, 'mint recovery duplicated mint or position');
    artifact.mintTimeoutRecovery = { recoveredHash: submittedMint, nftId: mintRecovered.tokenId, result: mintRecovered, counts: mintCounts, transitions: mintRepo2.canaryIntentTransitions(mintIntent.intentId) };
    mintRepo2.close();

    // Approval confirmed, then deterministic final-simulation abort.
    await resetChain();
    const abortStore = newRepo('mint-abort');
    const abortIntent = prepareIntent(abortStore.repo, 'mint-abort');
    const abortInput = makeInput(abortStore.repo, abortIntent.intentId);
    abortInput.hooks = { beforeFinalMintSimulation: () => { throw new Error('INJECTED_UNSAFE_REFRESHED_MINT'); } };
    const abortResult = await executeGuardedSingleSidedCanary(abortInput);
    const abortRow = abortStore.repo.canaryIntent(abortIntent.intentId)!;
    const abortAllowance = await fork.client.readContract({ address: funding.address, abi: erc20Abi, functionName: 'allowance', args: [operator.address, registry.value.positionManager] });
    assert(!abortResult.ok && abortRow.state === 'FAILED', 'unsafe final mint did not fail terminally');
    assert(String(abortRow.failure_reason).includes('FINAL_MINT_SIMULATION') && String(abortRow.failure_reason).includes('INJECTED_UNSAFE_REFRESHED_MINT'), 'mint abort phase/reason was not persisted');
    assert(!abortRow.mint_hash && abortRow.approval_hash, 'mint was submitted during abort scenario');
    assert(abortAllowance === 5_000_000n, 'remaining capped allowance is not exact');
    const abortRetry = await recoverGuardedSingleSidedCanary(makeInput(abortStore.repo, abortIntent.intentId));
    assert(abortRetry.status === 'TERMINAL' && !abortStore.repo.canaryIntent(abortIntent.intentId)?.mint_hash, 'terminal mint abort retried automatically');
    artifact.mintAbort = { result: abortResult, row: abortRow, noArmRequired:true, remainingAllowance: abortAllowance, retry: abortRetry, counts: counts(abortStore.repo, abortIntent.intentId) };
    abortStore.repo.close();

    // Telegram confirmation boundary selects the real production executor on local transport.
    await resetChain();
    const routeStore = newRepo('telegram-route');
    const routeFlow=routeStore.repo.createTelegramFlow({userId:'route-user',chatId:'route-chat',state:{kind:'pool'},now:Date.now(),ttlMs:600_000});
    const routeSelection=routeStore.repo.createPoolSelection({userId:'route-user',chatId:'route-chat',sessionId:routeFlow.sessionId,poolAddress:pool.address,factoryAddress:pool.factory,token0Address:pool.token0,token1Address:pool.token1,fee:pool.fee,tickSpacing:pool.tickSpacing,discoveryBlock:pool.blockNumber,liquidity:pool.liquidity,initialized:pool.initialized});
    const preparedIntent=routeStore.repo.createCanaryIntent({wallet:operator.address,owner:'route-user',idempotencyKey:'route-final-click',payload:{canary:{sessionId:routeFlow.sessionId,selectionId:String(routeSelection.id),pool:pool.address,fee:pool.fee,target,funding,amount:5_000_000n,upper:0,lower:10}}});
    const routeInput={ repo: routeStore.repo, intentId:String(preparedIntent.id), selectionId:String(routeSelection.id),sessionId:routeFlow.sessionId,buttonPool:pool.address,verifiedFactory:registry.value.factory,userId: 'route-user', chatId: 'route-chat', allowlisted: true, readiness: { status: 'READY_FOR_USDG_ONLY_CANARY', approvalStatus: 'APPROVAL_REQUIRED' as const, estimatedGasUsd: 1 }, executionEnabled: true, dryRun: false, emergencyPause: false, liveCanaryEnabled: true, signerConfigured: true, chainId: 4663, deploymentVerified: true, positionUsd: 5, approvalUsd: 5, maxPositionUsd: 5, maxApprovalUsd: 5, openPositions: 0, maxOpenPositions: 1, wallet: operator.address, executorInput: { rpc, walletClient: operatorWallet, wallet: operator.address, owner: 'route-user', pool: pool.address, target, funding, fundingAmount: 5_000_000n, upperDropPct: 0, lowerDropPct: 10, slippageBps: 50, deadlineSeconds: 600, maxGasUsd: 100, gasUsdPerNative: 1, notify: async () => {}, pinnedDeploymentSnapshot:snapshotVerification } };
    const routeResult = await executePreparedCanaryRoute(routeInput);
    assert(routeResult.status === 'EXECUTOR_INVOKED' && routeResult.result.ok && routeResult.result.status === 'COMPLETED', 'Telegram route did not invoke and complete the real production executor');
    const routeIntentId = routeResult.intentId;
    const routeDuplicate = await executePreparedCanaryRoute(routeInput);
    const routeCounts = counts(routeStore.repo, routeIntentId);
    assert(routeCounts.approvalSubmissions === 1 && routeCounts.mintSubmissions === 1 && routeCounts.positions === 1, 'Telegram duplicate route produced duplicate execution');
    artifact.telegramProductionRoute = { executor: 'executeGuardedSingleSidedCanary', noArmRequired:true, selection:routeSelection, result: routeResult, duplicate: routeDuplicate, counts: routeCounts, budget:routeStore.repo.canaryBudget(),manualPause:routeStore.repo.safetyState()?.manualPause===true };
    routeStore.repo.close();

    const localHashes = [approvalHash, mintHash, submittedApproval, approvalRecovered.mintHash, submittedMint, routeResult.result.approvalHash, routeResult.result.mintHash].filter(Boolean) as Hash[];
    for (const hash of localHashes) {
      assert(!(await mainnetHasReceipt(hash)), `local transaction hash exists on mainnet: ${hash}`);
    }
    const productionAfter = {
      nonce: await productionNonce(),
      database: fileProof(runtimePaths.databasePath),
      flags: {
        EXECUTION_ENABLED: runtimeEnv.EXECUTION_ENABLED,
        DRY_RUN: runtimeEnv.DRY_RUN,
        EMERGENCY_PAUSE: runtimeEnv.EMERGENCY_PAUSE,
        LIVE_CANARY_ENABLED: runtimeEnv.LIVE_CANARY_ENABLED,
      },
    };
    assert(json(productionBefore.nonce) === json(productionAfter.nonce), 'production wallet nonce changed');
    assert(json(productionBefore.database) === json(productionAfter.database), 'production database changed');
    assert(json(productionBefore.flags) === json(productionAfter.flags), 'production execution flags changed');
    assert(!runtimeEnv.EXECUTION_ENABLED && runtimeEnv.DRY_RUN && runtimeEnv.EMERGENCY_PAUSE && !runtimeEnv.LIVE_CANARY_ENABLED, 'production is not fail-closed');
    assert(writes.length > 0 && writes.every(item => isLoopback(item.url)), 'write RPC escaped loopback');
    artifact.mainnetIsolation = {
      nonLocalWriteGuard: 'PASS', blockedMethods, localWrites: writes.length,
      allWritesLoopback: writes.every(item => isLoopback(item.url)),
      localHashesAbsentOnMainnet: true, productionBefore, productionAfter,
    };
    writeFileSync(artifactPath, json(artifact));
    return { ok: true, ...artifact };
  } catch (error) {
    artifact.error = error instanceof Error ? error.stack ?? error.message : String(error);
    writeFileSync(artifactPath, json(artifact));
    throw new Error(`${artifact.error}\nartifact: ${artifactPath}`);
  } finally {
    await fork.stop();
  }
}
