import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createWalletClient, custom, keccak256, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { authorizeRebalanceWorkflow, calculateRebalancePlan, createRebalanceWorkflow, ensureRebalanceLineage } from '../apps/cli/src/rebalance.js';
import { executeRebalanceTransaction, rebalanceResumeRecoveryCandidate, signWithConfiguredAccount } from '../apps/cli/src/rebalance-transaction.js';

const walletAddress='0x0000000000000000000000000000000000000002' as const;
const targetAddress='0x0000000000000000000000000000000000000003' as const;
const limits={maxTxGasUsd:.25,maxLifecycleGasUsd:1,nativeUsd:1};
const missing=()=>{throw new Error('transaction not found');};
const successfulReceipt=(hash:string)=>({status:'success',transactionHash:hash,gasUsed:90_000n,effectiveGasPrice:1n,blockNumber:1n,logs:[]});
const revertedReceipt=(hash:string)=>({status:'reverted',transactionHash:hash,gasUsed:90_000n,effectiveGasPrice:1n,blockNumber:1n,logs:[]});
const pendingTransaction=(hash:string,nonce=145,from:string=walletAddress)=>({hash,nonce,from,blockNumber:null});

function addWorkflow(repo:SqliteLedgerRepository,suffix:string){
 const lineage=ensureRebalanceLineage(repo,{rootPositionId:`v4:${suffix}`,originalPrincipalUsd:5,fundingToken:'0x0000000000000000000000000000000000000001',fundingSymbol:'USDG',protocol:'v4',poolId:`pool-${suffix}`});
 const plan=calculateRebalancePlan({mode:'REBALANCE',originalPrincipalUsd:5,recoveredPrincipalUsd:5,verifiedFeesUsd:0,compoundCapUsd:5000,originalFundingSymbol:'USDG'});
 const workflow=createRebalanceWorkflow(repo,{idempotencyKey:`tx-test-${suffix}`,lineageId:String(lineage.id),oldPositionId:`v4:${suffix}`,mode:'REBALANCE',downsidePct:30,preview:{plan}});
 authorizeRebalanceWorkflow(repo,{workflowId:String(workflow.id),maximumTopUpUsd:0,balances:{originalFundingUsd:0,usdgUsd:0}});
 return String(workflow.id);
}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rebalance-tx-')),path=join(dir,'db.sqlite');
 migrateSqlite(path,join(process.cwd(),'infra/migrations'));
 const repo=new SqliteLedgerRepository(path),workflowId=addWorkflow(repo,'1');
 return {repo,path,workflowId,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};
}
function request(nonce:number){return {account:walletAddress,chainId:4663,to:targetAddress,data:'0x12',value:0n,gas:120_000n,gasPrice:1n,nonce};}
function insertAttempt(f:ReturnType<typeof fixture>,input:{hash:string;nonce:number;stage?:string;status?:string;attempt?:number;request?:Record<string,unknown>}){
 const at=new Date().toISOString(),stage=input.stage??'FEE_TARGET_TO_FUNDING:ERC20_APPROVAL:RESET',attempt=input.attempt??0,status=input.status??'PREPARED';
 f.repo.db.prepare('INSERT INTO rebalance_transactions(id,workflow_id,semantic_stage,attempt,status,tx_hash,nonce,to_address,calldata_hash,request_json,estimated_gas_raw,estimated_gas_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`${f.workflowId}:${stage}:${attempt}`,f.workflowId,stage,attempt,status,input.hash,input.nonce,targetAddress,`0x${'1'.repeat(64)}`,JSON.stringify(input.request??request(input.nonce),(_,v)=>typeof v==='bigint'?v.toString():v),'100000',0,at,at);
 return stage;
}
function client(input:Record<string,unknown>={}){return {getTransactionReceipt:missing,getTransaction:missing,getTransactionCount:async({blockTag}:{blockTag:string})=>blockTag==='latest'?145:145,estimateGas:async()=>100_000n,getGasPrice:async()=>1n,...input};}
function rpc(clients:Array<Record<string,unknown>>){return {config:{chainId:4663},clients,withClient:async(fn:(value:any)=>unknown)=>fn(clients[0])} as any;}
function txInput(f:ReturnType<typeof fixture>,semanticStage:string,rpcValue:any,walletClient:any,hooks?:Record<string,unknown>,workflowId=f.workflowId){
 const send=walletClient.sendRawTransaction;
 const transportWallet={...walletClient,syntheticSerializedTransactionFixture:true,request:send?async(args:{method:string;params:[Hex]})=>{
  expect(args.method).toBe('eth_sendRawTransaction');expect(args.params).toHaveLength(1);return send({serializedTransaction:args.params[0]});
 }:walletClient.request};
 return {repo:f.repo,rpc:rpcValue,walletClient:transportWallet,wallet:walletAddress,workflowId,semanticStage,to:targetAddress,data:'0x12' as Hex,limits,hooks} as any;
}
function rows(f:ReturnType<typeof fixture>,stage?:string){return f.repo.db.prepare(`SELECT attempt,status,tx_hash,nonce,request_json,receipt_json,failure_reason FROM rebalance_transactions WHERE workflow_id=?${stage?' AND semantic_stage=?':''} ORDER BY semantic_stage,attempt`).all(...(stage?[f.workflowId,stage]:[f.workflowId])) as Array<Record<string,unknown>>;}

describe('durable rebalance transaction journal',()=>{
 it('signs locally without eth_signTransaction',async()=>{
  const methods:string[]=[],account=privateKeyToAccount(`0x${'1'.repeat(64)}`),wallet=createWalletClient({account,chain:{id:4663,name:'Robinhood',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['http://127.0.0.1']}}},transport:custom({request:async({method})=>{methods.push(method);if(method==='eth_chainId')return '0x1237';throw new Error('RPC_FORBIDDEN');}})});
  const serialized=await signWithConfiguredAccount(wallet,request(7));expect(keccak256(serialized)).toMatch(/^0x[0-9a-f]{64}$/);expect(methods).toEqual(['eth_chainId']);
 });

 it('exact hash confirmed reconciles the existing attempt only',async()=>{
  const f=fixture(),serialized='0x020304' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let sends=0,signs=0;
  try{const result=await executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionReceipt:async()=>successfulReceipt(hash)})]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>{signs++;return serialized;},sendRawTransaction:async()=>{sends++;return hash;}}));expect(result).toMatchObject({hash,recovered:true});expect({sends,signs}).toEqual({sends:0,signs:0});expect(rows(f,stage)).toEqual([expect.objectContaining({attempt:0,status:'CONFIRMED',tx_hash:hash})]);}finally{f.close();}
 });

 it('exact hash reverted records the exact receipt and fails closed',async()=>{
  const f=fixture(),hash=keccak256('0x030405'),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionReceipt:async()=>revertedReceipt(hash)})]),{}))).rejects.toThrow(`REBALANCE_TRANSACTION_REVERTED:${stage}`);const [row]=rows(f,stage);expect(row).toMatchObject({attempt:0,status:'FAILED',tx_hash:hash,nonce:145,failure_reason:'TRANSACTION_REVERTED'});expect(JSON.parse(String(row!.receipt_json))).toMatchObject({status:'reverted',transactionHash:hash});}finally{f.close();}
 });

 it('exact hash pending becomes SUBMITTED and creates no attempt',async()=>{
  const f=fixture(),hash=keccak256('0x040506'),stage=insertAttempt(f,{hash,nonce:145});let sends=0;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransaction:async()=>pendingTransaction(hash)})]),{sendRawTransaction:async()=>{sends++;return hash;}},{beforeReceipt:()=>{throw new Error('PENDING_STOP');}}))).rejects.toThrow('PENDING_STOP');expect(sends).toBe(0);expect(rows(f,stage)).toEqual([expect.objectContaining({attempt:0,status:'SUBMITTED',tx_hash:hash})]);}finally{f.close();}
 });

 it('exact hash absent with nonce available retries only the persisted transaction',async()=>{
  const f=fixture(),serialized='0x050607' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let sent:Hex|undefined;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async(input:Record<string,unknown>)=>{expect(input.nonce).toBe(145);return serialized;},sendRawTransaction:async({serializedTransaction}:{serializedTransaction:Hex})=>{sent=serializedTransaction;return hash;}},{beforeReceipt:()=>{throw new Error('RETRY_STOP');}}))).rejects.toThrow('RETRY_STOP');expect(sent).toBe(serialized);expect(rows(f,stage)).toEqual([expect.objectContaining({attempt:0,status:'SUBMITTED',tx_hash:hash,nonce:145})]);}finally{f.close();}
 });

 it('exact hash absent with latest nonce advanced blocks automatic replacement',async()=>{
  const f=fixture(),oldHash=keccak256('0x060708'),fresh='0x070809' as Hex,freshHash=keccak256(fresh),stage=insertAttempt(f,{hash:oldHash,nonce:145});
  const c=client({getTransactionCount:async({blockTag}:{blockTag:string})=>blockTag==='latest'?147:147});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([c]),{account:{signTransaction:async()=>fresh},signTransaction:async()=>fresh,sendRawTransaction:async()=>freshHash}))).rejects.toThrow('REBALANCE_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED');expect(rows(f,stage)).toEqual([expect.objectContaining({attempt:0,status:'PREPARED',tx_hash:oldHash,nonce:145,failure_reason:null})]);}finally{f.close();}
 });

 it('pending nonce advanced while latest has not advanced is an unresolved conflict',async()=>{
  const f=fixture(),hash=keccak256('0x08090a'),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionCount:async({blockTag}:{blockTag:string})=>blockTag==='latest'?145:146})]),{}))).rejects.toThrow('REBALANCE_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',attempt:0,tx_hash:hash,failure_reason:null})]);}finally{f.close();}
 });

 it('all providers inconclusive preserves the row unchanged',async()=>{
  const f=fixture(),hash=keccak256('0x090a0b'),stage=insertAttempt(f,{hash,nonce:145}),bad=client({getTransactionReceipt:async()=>{throw new Error('provider unavailable');}});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([bad,bad]),{}))).rejects.toThrow('REBALANCE_TRANSACTION_EVIDENCE_INCONCLUSIVE:PROVIDER_ERROR');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',attempt:0,tx_hash:hash,failure_reason:null})]);}finally{f.close();}
 });

 it('provider disagreement preserves the row unchanged',async()=>{
  const f=fixture(),hash=keccak256('0x0a0b0c'),stage=insertAttempt(f,{hash,nonce:145}),a=client(),b=client({getTransactionCount:async()=>146});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([a,b]),{}))).rejects.toThrow('REBALANCE_TRANSACTION_EVIDENCE_INCONCLUSIVE:PROVIDER_DISAGREEMENT');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',attempt:0,tx_hash:hash})]);}finally{f.close();}
 });

 it('send throws after acceptance and exact receipt confirms without retry',async()=>{
  const f=fixture(),serialized='0xaabbcc' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let accepted=false,sends=0,signs=0;const c=client({getTransactionReceipt:async()=>{if(!accepted)return missing();return successfulReceipt(hash);}});
  try{const result=await executeRebalanceTransaction(txInput(f,stage,rpc([c]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>{signs++;return serialized;},sendRawTransaction:async()=>{sends++;accepted=true;throw new Error('synthetic provider response lost');}}));expect(result).toMatchObject({hash,recovered:true});expect({sends,signs}).toEqual({sends:1,signs:1});expect(rows(f,stage)).toEqual([expect.objectContaining({status:'CONFIRMED',tx_hash:hash})]);}finally{f.close();}
 });

 it('send throws after acceptance and exact pending hash becomes monitor-only SUBMITTED',async()=>{
  const f=fixture(),serialized='0xaabbcd' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let accepted=false,sends=0;const c=client({getTransaction:async()=>{if(!accepted)return missing();return pendingTransaction(hash);}});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([c]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{sends++;accepted=true;throw new Error('synthetic timeout');}},{beforeReceipt:()=>{throw new Error('MONITOR_ONLY_STOP');}}))).rejects.toThrow('MONITOR_ONLY_STOP');expect(sends).toBe(1);expect(rows(f,stage)).toEqual([expect.objectContaining({status:'SUBMITTED',tx_hash:hash})]);}finally{f.close();}
 });

 it('send ambiguity with conflicting providers fails closed',async()=>{
  const f=fixture(),serialized='0xaabbce' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let accepted=false;const a=client({getTransactionReceipt:async()=>accepted?successfulReceipt(hash):missing()}),b=client();
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([a,b]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{accepted=true;throw new Error('synthetic ambiguous send');}}))).rejects.toThrow('REBALANCE_BROADCAST_AMBIGUOUS:PROVIDER_DISAGREEMENT');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',tx_hash:hash})]);}finally{f.close();}
 });

 it('already-known send remains unproven when every provider reports exact hash absent',async()=>{
  const f=fixture(),serialized='0x0b0c0d' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{throw new Error('already known');}}))).rejects.toThrow('REBALANCE_BROADCAST_UNPROVEN_HASH_ABSENT_NONCE_AVAILABLE');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',attempt:0,tx_hash:hash})]);}finally{f.close();}
 });

 it('nonce-too-low is not accepted as submission',async()=>{
  const f=fixture(),serialized='0x0c0d0e' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{throw new Error('nonce too low');}}))).rejects.toThrow('REBALANCE_BROADCAST_UNPROVEN_HASH_ABSENT_NONCE_AVAILABLE');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',attempt:0,tx_hash:hash})]);}finally{f.close();}
 });

 it('restart after PREPARED persistence recovers the exact serialized transaction',async()=>{
  const f=fixture(),serialized='0x0d0e0f' as Hex,hash=keccak256(serialized),stage='REOPEN_MINT';
  const wallet={account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>hash};
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionCount:async()=>145})]),wallet,{beforeSubmit:()=>{throw new Error('CRASH_AFTER_PREPARED');}}))).rejects.toThrow('CRASH_AFTER_PREPARED');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',attempt:0,tx_hash:hash})]);await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),wallet,{beforeReceipt:()=>{throw new Error('RECOVERED_AFTER_PREPARED');}}))).rejects.toThrow('RECOVERED_AFTER_PREPARED');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'SUBMITTED',attempt:0,tx_hash:hash})]);}finally{f.close();}
 });

 it('restart after broadcast before SUBMITTED update observes exact pending hash',async()=>{
  const f=fixture(),serialized='0x0e0f10' as Hex,hash=keccak256(serialized),stage='REOPEN_MINT',wallet={account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>hash};
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionCount:async()=>145})]),wallet,{afterBroadcast:()=>{throw new Error('CRASH_AFTER_BROADCAST');}}))).rejects.toThrow('CRASH_AFTER_BROADCAST');expect(rows(f,stage)[0]).toMatchObject({status:'PREPARED',tx_hash:hash});await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransaction:async()=>pendingTransaction(hash)})]),wallet,{beforeReceipt:()=>{throw new Error('OBSERVED_PENDING');}}))).rejects.toThrow('OBSERVED_PENDING');expect(rows(f,stage)[0]).toMatchObject({status:'SUBMITTED',attempt:0,tx_hash:hash});}finally{f.close();}
 });

 it('restart after SUBMITTED before receipt reconciles the exact receipt',async()=>{
  const f=fixture(),serialized='0x0f1011' as Hex,hash=keccak256(serialized),stage='REOPEN_MINT',wallet={account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>hash};
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionCount:async()=>145})]),wallet,{beforeReceipt:()=>{throw new Error('CRASH_AFTER_SUBMITTED');}}))).rejects.toThrow('CRASH_AFTER_SUBMITTED');expect(rows(f,stage)[0]).toMatchObject({status:'SUBMITTED'});const result=await executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionReceipt:async()=>successfulReceipt(hash)})]),wallet));expect(result).toMatchObject({hash,recovered:true});expect(rows(f,stage)[0]).toMatchObject({status:'CONFIRMED',attempt:0});}finally{f.close();}
 });

 it('two executors cannot replace one exact-hash-absent consumed nonce',async()=>{
  const f=fixture(),oldHash=keccak256('0x101112'),stage=insertAttempt(f,{hash:oldHash,nonce:145}),c=client({getTransactionCount:async()=>147});
  try{const results=await Promise.allSettled([executeRebalanceTransaction(txInput(f,stage,rpc([c]),{})),executeRebalanceTransaction(txInput(f,stage,rpc([c]),{}))]);expect(results.every(item=>item.status==='rejected'&&String(item.reason).includes('REBALANCE_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED'))).toBe(true);expect(rows(f,stage)).toEqual([expect.objectContaining({attempt:0,status:'PREPARED',tx_hash:oldHash})]);}finally{f.close();}
 });

 it('CLI and Telegram allocations share the durable wallet nonce mutex',async()=>{
  const f=fixture(),secondWorkflow=addWorkflow(f.repo,'2'),one='0x121314' as Hex,two='0x131415' as Hex;let release!:()=>void,started!:()=>void;const signingStarted=new Promise<void>(resolve=>{started=resolve;}),continueSigning=new Promise<void>(resolve=>{release=resolve;}),freshRpc=rpc([client({getTransactionCount:async()=>147})]);
  const cli=executeRebalanceTransaction(txInput(f,'REOPEN_MINT',freshRpc,{account:{signTransaction:async()=>one},signTransaction:async()=>{started();await continueSigning;return one;},sendRawTransaction:async()=>keccak256(one)},{beforeSubmit:()=>{throw new Error('CLI_STOP');}}));
  try{await signingStarted;await expect(executeRebalanceTransaction(txInput(f,'REOPEN_MINT',freshRpc,{account:{signTransaction:async()=>two},signTransaction:async()=>two,sendRawTransaction:async()=>keccak256(two)},undefined,secondWorkflow))).rejects.toThrow('REBALANCE_NONCE_MUTEX_HELD');expect(f.repo.db.prepare('SELECT COUNT(*) count FROM rebalance_transactions WHERE workflow_id=?').get(secondWorkflow)).toEqual({count:0});release();await expect(cli).rejects.toThrow('CLI_STOP');}finally{release?.();await cli.catch(()=>undefined);f.close();}
 });

 it('exact persisted retry holds the durable mutex through broadcast disposition',async()=>{
  const f=fixture(),serialized='0x202122' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145}),acquire=f.repo.acquireNonceMutex.bind(f.repo),release=f.repo.releaseNonceMutex.bind(f.repo);let acquired=0,released=0;
  f.repo.acquireNonceMutex=((wallet:string,nonce:bigint)=>{acquired++;return acquire(wallet,nonce);}) as typeof f.repo.acquireNonceMutex;f.repo.releaseNonceMutex=((wallet:string)=>{released++;return release(wallet);}) as typeof f.repo.releaseNonceMutex;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{expect(f.repo.db.prepare('SELECT COUNT(*) count FROM nonce_mutex').get()).toEqual({count:1});return hash;}},{beforeReceipt:()=>{throw new Error('LOCK_PROVEN');}}))).rejects.toThrow('LOCK_PROVEN');expect({acquired,released}).toEqual({acquired:1,released:1});expect(f.repo.db.prepare('SELECT COUNT(*) count FROM nonce_mutex').get()).toEqual({count:0});}finally{f.close();}
 });

 it('exact retry racing fresh allocation cannot share the wallet nonce',async()=>{
  const f=fixture(),secondWorkflow=addWorkflow(f.repo,'retry-race'),serialized='0x212223' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let releaseSign!:()=>void,signing!:()=>void;const signingStarted=new Promise<void>(resolve=>{signing=resolve;}),continueSigning=new Promise<void>(resolve=>{releaseSign=resolve;}),sharedRpc=rpc([client({getTransactionCount:async()=>145})]);
  const retry=executeRebalanceTransaction(txInput(f,stage,sharedRpc,{account:{signTransaction:async()=>serialized},signTransaction:async()=>{signing();await continueSigning;return serialized;},sendRawTransaction:async()=>hash},{beforeSubmit:()=>{throw new Error('RETRY_HOLDS_LOCK');}}));
  try{await signingStarted;await expect(executeRebalanceTransaction(txInput(f,'REOPEN_MINT',sharedRpc,{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>hash},undefined,secondWorkflow))).rejects.toThrow('REBALANCE_NONCE_MUTEX_HELD');expect(f.repo.db.prepare('SELECT COUNT(*) count FROM rebalance_transactions WHERE workflow_id=?').get(secondWorkflow)).toEqual({count:0});releaseSign();await expect(retry).rejects.toThrow('RETRY_HOLDS_LOCK');}finally{releaseSign?.();await retry.catch(()=>undefined);f.close();}
 });

 it('independent SQLite connections serialize the same temporary wallet lock',()=>{
  const f=fixture(),other=new SqliteLedgerRepository(f.path);
  try{expect(f.repo.acquireNonceMutex(walletAddress,145n)).toBe(true);expect(other.acquireNonceMutex(walletAddress,145n)).toBe(false);expect(other.releaseNonceMutex(walletAddress)).toBe(true);expect(other.acquireNonceMutex(walletAddress,145n)).toBe(true);}finally{other.releaseNonceMutex(walletAddress);other.close();f.close();}
 });

 it('checksum and lowercase wallet forms share one mutex key',()=>{
  const f=fixture(),checksum='0x52908400098527886E0F7030069857D2E4169EE7',lower=checksum.toLowerCase();
  try{expect(f.repo.acquireNonceMutex(checksum,1n)).toBe(true);expect(f.repo.acquireNonceMutex(lower,1n)).toBe(false);expect(f.repo.db.prepare('SELECT wallet FROM nonce_mutex').get()).toEqual({wallet:lower});expect(f.repo.releaseNonceMutex(checksum)).toBe(true);expect(f.repo.acquireNonceMutex(lower,1n)).toBe(true);}finally{f.repo.releaseNonceMutex(lower);f.close();}
 });

 it('an expired mutex lease can be acquired by another connection',()=>{
  const f=fixture(),other=new SqliteLedgerRepository(f.path);
  try{expect(f.repo.acquireNonceMutex(walletAddress,145n,-1)).toBe(true);expect(other.acquireNonceMutex(walletAddress,146n)).toBe(true);expect(other.db.prepare('SELECT nonce FROM nonce_mutex WHERE wallet=?').get(walletAddress)).toEqual({nonce:'146'});}finally{other.releaseNonceMutex(walletAddress);other.close();f.close();}
 });

 it('a row changed after mutex acquisition is reloaded without stale broadcast',async()=>{
  const f=fixture(),serialized='0x222324' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145}),acquire=f.repo.acquireNonceMutex.bind(f.repo);let sends=0;
  f.repo.acquireNonceMutex=((wallet:string,nonce:bigint)=>{const locked=acquire(wallet,nonce);if(locked)f.repo.db.prepare("UPDATE rebalance_transactions SET status='CONFIRMED',receipt_json=? WHERE workflow_id=? AND semantic_stage=?").run(JSON.stringify(successfulReceipt(hash),(_,v)=>typeof v==='bigint'?v.toString():v),f.workflowId,stage);return locked;}) as typeof f.repo.acquireNonceMutex;
  try{const result=await executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{sends++;return hash;}}));expect(result).toMatchObject({hash,recovered:true});expect(sends).toBe(0);}finally{f.close();}
 });

 it('repeated durable races stop at the bounded recovery limit',async()=>{
  const f=fixture(),hash=keccak256('0x232425'),stage=insertAttempt(f,{hash,nonce:145}),acquire=f.repo.acquireNonceMutex.bind(f.repo);let attempts=0,sends=0;
  f.repo.acquireNonceMutex=((wallet:string,nonce:bigint)=>{const locked=acquire(wallet,nonce);if(locked){attempts++;f.repo.db.prepare('UPDATE rebalance_transactions SET tx_hash=? WHERE workflow_id=? AND semantic_stage=?').run(keccak256(`0x${(30+attempts).toString(16).padStart(2,'0')}` as Hex),f.workflowId,stage);}return locked;}) as typeof f.repo.acquireNonceMutex;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{sendRawTransaction:async()=>{sends++;return hash;}}))).rejects.toThrow('REBALANCE_RECOVERY_RACE_LIMIT');expect(attempts).toBe(4);expect(sends).toBe(0);}finally{f.close();}
 });

 it('malformed receipt evidence is inconclusive and leaves the row unchanged',async()=>{
  const f=fixture(),hash=keccak256('0x242526'),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionReceipt:async()=>({status:'success'})})]),{}))).rejects.toThrow('REBALANCE_TRANSACTION_EVIDENCE_INCONCLUSIVE:MALFORMED_EVIDENCE');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',tx_hash:hash,failure_reason:null})]);}finally{f.close();}
 });

 it('malformed transaction evidence is inconclusive and leaves the row unchanged',async()=>{
  const f=fixture(),hash=keccak256('0x252627'),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransaction:async()=>({hash})})]),{}))).rejects.toThrow('REBALANCE_TRANSACTION_EVIDENCE_INCONCLUSIVE:MALFORMED_EVIDENCE');expect(rows(f,stage)).toEqual([expect.objectContaining({status:'PREPARED',tx_hash:hash,failure_reason:null})]);}finally{f.close();}
 });

 it('receipt and transaction hash mismatches are inconclusive',async()=>{
  for(const kind of ['receipt','transaction'] as const){const f=fixture(),hash=keccak256(kind==='receipt'?'0x262728':'0x272829'),wrong=keccak256('0x28292a'),stage=insertAttempt(f,{hash,nonce:145}),evidence=kind==='receipt'?{getTransactionReceipt:async()=>successfulReceipt(wrong)}:{getTransaction:async()=>pendingTransaction(wrong)};try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client(evidence)]),{}))).rejects.toThrow('REBALANCE_TRANSACTION_EVIDENCE_INCONCLUSIVE:MALFORMED_EVIDENCE');expect(rows(f,stage)[0]).toMatchObject({status:'PREPARED',tx_hash:hash});}finally{f.close();}}
 });

 it('all providers conclusively absent retry the exact persisted transaction',async()=>{
  const f=fixture(),serialized='0x292a2b' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});let sends=0;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client(),client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{sends++;return hash;}},{beforeReceipt:()=>{throw new Error('MULTI_ABSENT_RETRIED');}}))).rejects.toThrow('MULTI_ABSENT_RETRIED');expect(sends).toBe(1);expect(rows(f,stage)[0]).toMatchObject({status:'SUBMITTED',attempt:0,tx_hash:hash});}finally{f.close();}
 });

 it('mixed receipt and pending evidence disagrees without broadcast',async()=>{
  const f=fixture(),hash=keccak256('0x2a2b2c'),stage=insertAttempt(f,{hash,nonce:145});let sends=0;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionReceipt:async()=>successfulReceipt(hash)}),client({getTransaction:async()=>pendingTransaction(hash)})]),{sendRawTransaction:async()=>{sends++;return hash;}}))).rejects.toThrow('REBALANCE_TRANSACTION_EVIDENCE_INCONCLUSIVE:PROVIDER_DISAGREEMENT');expect(sends).toBe(0);expect(rows(f,stage)[0]).toMatchObject({status:'PREPARED',tx_hash:hash});}finally{f.close();}
 });

 it('submitted hash mismatch fails closed with PREPARED unchanged',async()=>{
  const f=fixture(),serialized='0x2b2c2d' as Hex,hash=keccak256(serialized),wrong=keccak256('0x2c2d2e'),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>wrong}))).rejects.toThrow('REBALANCE_BROADCAST_UNPROVEN_HASH_ABSENT_NONCE_AVAILABLE');expect(rows(f,stage)[0]).toMatchObject({status:'PREPARED',tx_hash:hash});}finally{f.close();}
 });

 it('signed transaction hash mismatch fails closed before broadcast',async()=>{
  const f=fixture(),persisted=keccak256('0x2d2e2f'),different='0x2e2f30' as Hex,stage=insertAttempt(f,{hash:persisted,nonce:145});let sends=0;
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>different},signTransaction:async()=>different,sendRawTransaction:async()=>{sends++;return persisted;}}))).rejects.toThrow('REBALANCE_SIGNED_TRANSACTION_HASH_MISMATCH');expect(sends).toBe(0);expect(rows(f,stage)[0]).toMatchObject({status:'PREPARED',tx_hash:persisted});}finally{f.close();}
 });

 it('unknown broadcast errors leave PREPARED unchanged',async()=>{
  const f=fixture(),serialized='0x2f3031' as Hex,hash=keccak256(serialized),stage=insertAttempt(f,{hash,nonce:145});
  try{await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client()]),{account:{signTransaction:async()=>serialized},signTransaction:async()=>serialized,sendRawTransaction:async()=>{throw new Error('unclassified relay failure');}}))).rejects.toThrow('REBALANCE_BROADCAST_UNPROVEN_HASH_ABSENT_NONCE_AVAILABLE');expect(rows(f,stage)[0]).toMatchObject({status:'PREPARED',tx_hash:hash});}finally{f.close();}
 });

 it('confirmed CLOSE_FULL and CLOSE_BURN are never repeated',async()=>{
  const f=fixture(),closeHash=keccak256('0x141516'),burnHash=keccak256('0x151617');let sends=0;
  try{for(const [stage,hash,nonce] of [['CLOSE_FULL',closeHash,143],['CLOSE_BURN',burnHash,144]] as const){insertAttempt(f,{stage,hash,nonce});f.repo.db.prepare("UPDATE rebalance_transactions SET status='CONFIRMED',receipt_json=? WHERE workflow_id=? AND semantic_stage=?").run(JSON.stringify(successfulReceipt(hash),(_,v)=>typeof v==='bigint'?v.toString():v),f.workflowId,stage);const result=await executeRebalanceTransaction(txInput(f,stage,{config:{chainId:4663},withClient:async()=>{throw new Error('must not query RPC');}},{sendRawTransaction:async()=>{sends++;throw new Error('must not send');}}));expect(result).toMatchObject({hash,recovered:true});}expect(sends).toBe(0);expect(rows(f).filter(row=>row.status==='CONFIRMED')).toHaveLength(2);}finally{f.close();}
 });

 it('current-workflow-shaped stale nonce blocks replacement without changing workflow state',async()=>{
  const f=fixture(),closeHash=keccak256('0x161718'),burnHash=keccak256('0x171819'),oldHash=keccak256('0x18191a'),fresh='0x191a1b' as Hex,stage='FEE_TARGET_TO_FUNDING:ERC20_APPROVAL:RESET';
  try{for(const [closeStage,hash,nonce] of [['CLOSE_FULL',closeHash,143],['CLOSE_BURN',burnHash,144]] as const){insertAttempt(f,{stage:closeStage,hash,nonce});f.repo.db.prepare("UPDATE rebalance_transactions SET status='CONFIRMED',receipt_json=? WHERE workflow_id=? AND semantic_stage=?").run(JSON.stringify(successfulReceipt(hash),(_,v)=>typeof v==='bigint'?v.toString():v),f.workflowId,closeStage);}insertAttempt(f,{stage,hash:oldHash,nonce:145});f.repo.db.prepare("UPDATE rebalance_workflows SET state='FAILED_RECOVERABLE',state_json=?,replacement_position_id=NULL WHERE id=?").run(JSON.stringify({resumeFrom:'SURPLUS_SWAP_STARTED'}),f.workflowId);
   await expect(executeRebalanceTransaction(txInput(f,stage,rpc([client({getTransactionCount:async()=>147})]),{account:{signTransaction:async()=>fresh},signTransaction:async()=>fresh,sendRawTransaction:async()=>keccak256(fresh)}))).rejects.toThrow('REBALANCE_EXACT_HASH_ABSENT_NONCE_CONSUMED_OR_REPLACED');
   const workflow=f.repo.db.prepare('SELECT state,state_json,replacement_position_id FROM rebalance_workflows WHERE id=?').get(f.workflowId) as Record<string,unknown>;expect(workflow).toMatchObject({state:'FAILED_RECOVERABLE',replacement_position_id:null});expect(JSON.parse(String(workflow.state_json))).toEqual({resumeFrom:'SURPLUS_SWAP_STARTED'});expect(rows(f).filter(row=>row.status==='CONFIRMED')).toHaveLength(2);expect(rows(f,stage)).toEqual([expect.objectContaining({attempt:0,status:'PREPARED',nonce:145,failure_reason:null})]);
  }finally{f.close();}
 });

 it('resume guard permits one recovery row and blocks extras or unrelated rows',()=>{
  const workflowId='workflow',prepared={workflow_id:workflowId,status:'PREPARED'},submitted={workflow_id:workflowId,status:'SUBMITTED'};expect(rebalanceResumeRecoveryCandidate(workflowId,[prepared])).toBe(prepared);expect(rebalanceResumeRecoveryCandidate(workflowId,[submitted])).toBe(submitted);expect(()=>rebalanceResumeRecoveryCandidate(workflowId,[prepared,submitted])).toThrow('REBALANCE_LATER_TRANSACTION_EXISTS');expect(()=>rebalanceResumeRecoveryCandidate(workflowId,[{workflow_id:'other',status:'PREPARED'}])).toThrow('REBALANCE_LATER_TRANSACTION_EXISTS');expect(()=>rebalanceResumeRecoveryCandidate(workflowId,[{workflow_id:workflowId,status:'CONFIRMED'}])).toThrow('REBALANCE_LATER_TRANSACTION_EXISTS');
 });
});
