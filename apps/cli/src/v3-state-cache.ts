import { getAddress, type Address } from 'viem';
import { inspectV3Pool, protocolDeployment, v3PoolCreatedEvent, type FallbackRpc } from '@funi/core';
import type { SqliteLedgerRepository } from '@funi/ledger';

const CHAIN_ID=4663,PROTOCOL='uniswap_v3';
const deployment=protocolDeployment(CHAIN_ID,PROTOCOL);
const factory=getAddress(deployment.contracts.factory!);
const deploymentBlock=BigInt(deployment.deploymentBlock!);

type Created={pool:Address;token0:Address;token1:Address;fee:number;tickSpacing:number;block:bigint};
const state=(row:Record<string,unknown>|undefined)=>{try{return row?JSON.parse(String(row.state_json)):{};}catch{return {};}};
export function planV3Discovery(repo:SqliteLedgerRepository,finalized:bigint,window=2_000n){
 const cursor=repo.chainRegistryCursor(CHAIN_ID,PROTOCOL,'deployment_verification'),from=cursor?BigInt(String(cursor.next_block)):deploymentBlock;
 return from>finalized?null:{from,to:from+window-1n<finalized?from+window-1n:finalized};
}
export async function fetchV3Discovery(rpc:FallbackRpc,plan:{from:bigint;to:bigint}){
 const logs=await rpc.withClient(client=>client.getLogs({address:factory,event:v3PoolCreatedEvent,fromBlock:plan.from,toBlock:plan.to}),{stage:'v3_registry_discovery',method:'Factory.PoolCreated'});
 return logs.map(log=>{const args=log.args as Record<string,unknown>;return {pool:getAddress(String(args.pool)),token0:getAddress(String(args.token0)),token1:getAddress(String(args.token1)),fee:Number(args.fee),tickSpacing:Number(args.tickSpacing),block:log.blockNumber!} satisfies Created;});
}
export function persistV3Discovery(repo:SqliteLedgerRepository,plan:{from:bigint;to:bigint},created:readonly Created[],now=Date.now()){
 const upsert=repo.db.prepare(`INSERT INTO v3_pool_state_cache(pool_address,factory_address,token0_address,token1_address,fee,tick_spacing,liquidity_raw,sqrt_price_x96,current_tick,initialized,refresh_block,refreshed_at_ms,chain_id,protocol) VALUES(?,?,?,?,?,?,'0',NULL,NULL,0,?,?,4663,'uniswap_v3') ON CONFLICT(pool_address) DO UPDATE SET factory_address=excluded.factory_address,token0_address=excluded.token0_address,token1_address=excluded.token1_address,fee=excluded.fee,tick_spacing=excluded.tick_spacing,chain_id=4663,protocol='uniswap_v3'`);
 const run=repo.db.transaction(()=>{for(const pool of created)upsert.run(pool.pool,factory,pool.token0,pool.token1,pool.fee,pool.tickSpacing,pool.block.toString(),now);repo.upsertChainRegistryCursor({chainId:CHAIN_ID,protocol:PROTOCOL,cursorKind:'deployment_verification',nextBlock:plan.to+1n,finalityConfirmations:2,state:{lastCompletedFromBlock:plan.from.toString(),lastCompletedToBlock:plan.to.toString(),poolsDiscovered:created.length}});});run();
 return created.length;
}
export function planV3Refresh(repo:SqliteLedgerRepository,limit=8){
 const cursor=repo.chainRegistryCursor(CHAIN_ID,PROTOCOL,'state_cache'),saved=state(cursor),after=String(saved.afterPool??'');
 let rows=repo.db.prepare("SELECT pool_address FROM v3_pool_state_cache WHERE chain_id=4663 AND protocol='uniswap_v3' AND lower(pool_address)>? ORDER BY lower(pool_address) LIMIT ?").all(after,limit) as Array<{pool_address:string}>;
 if(rows.length<limit)rows.push(...repo.db.prepare("SELECT pool_address FROM v3_pool_state_cache WHERE chain_id=4663 AND protocol='uniswap_v3' AND lower(pool_address)<=? ORDER BY lower(pool_address) LIMIT ?").all(after,limit-rows.length) as Array<{pool_address:string}>);
 return {poolIds:rows.map(row=>getAddress(row.pool_address)),afterPool:rows.at(-1)?.pool_address.toLowerCase()??after};
}
export async function fetchV3Refresh(rpc:FallbackRpc,poolIds:readonly Address[]){
 return Promise.all(poolIds.map(async pool=>({pool,result:await inspectV3Pool(rpc,pool)})));
}
export function persistV3Refresh(repo:SqliteLedgerRepository,plan:{poolIds:readonly Address[];afterPool:string},results:Awaited<ReturnType<typeof fetchV3Refresh>>,now=Date.now()){
 const update=repo.db.prepare("UPDATE v3_pool_state_cache SET factory_address=?,token0_address=?,token1_address=?,fee=?,tick_spacing=?,liquidity_raw=?,sqrt_price_x96=?,current_tick=?,initialized=?,refresh_block=?,refreshed_at_ms=?,chain_id=4663,protocol='uniswap_v3' WHERE lower(pool_address)=lower(?)"),run=repo.db.transaction(()=>{for(const item of results){if(item.result.status!=='available'||item.result.value.factory.toLowerCase()!==factory.toLowerCase())continue;const p=item.result.value;update.run(p.factory,p.token0,p.token1,p.fee,p.tickSpacing,p.liquidity.toString(),p.sqrtPriceX96.toString(),p.tick,p.initialized?1:0,p.blockNumber.toString(),now,p.address);}repo.upsertChainRegistryCursor({chainId:CHAIN_ID,protocol:PROTOCOL,cursorKind:'state_cache',nextBlock:'0',finalityConfirmations:2,state:{afterPool:plan.afterPool,lastRefreshAtMs:now}});});run();
 return {attempted:results.length,refreshed:results.filter(item=>item.result.status==='available').length};
}
