import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address } from 'viem';
import { migrateSqlite, SqliteLedgerRepository } from '@funi/ledger';
import { robinhoodMainnet } from '@funi/core';
import { executeV4Lifecycle } from '../apps/cli/src/v4-lifecycle.js';

const wallet='0x00000000000000000000000000000000000000a1' as Address,source='0x00000000000000000000000000000000000000b1' as Address,key={currency0:'0x00000000000000000000000000000000000000c1' as Address,currency1:robinhoodMainnet.assets.USDG,fee:500,tickSpacing:10,hooks:'0x0000000000000000000000000000000000000000' as Address},hash=`0x${'12'.repeat(32)}` as const,q96=2n**96n,transfer=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const u24=(value:number)=>BigInt(value<0?value+0x1000000:value),positionInfo=(u24(-20)<<8n)|(u24(20)<<32n);
const transferLog=(address:Address,value:bigint)=>({address,data:encodeAbiParameters([{type:'uint256'}],[value]),topics:encodeEventTopics({abi:[transfer],eventName:'Transfer',args:{from:source,to:wallet}})});

function fixture(action:'collect'|'partial_close'|'full_close'){
 const dir=mkdtempSync(join(tmpdir(),'v4-manual-swap-close-')),path=join(dir,'db.sqlite');migrateSqlite(path,'infra/migrations');const repo=new SqliteLedgerRepository(path),remaining=action==='collect'?1_000n:action==='partial_close'?500n:0n;
 repo.ensurePosition('v4:1','1','pool');repo.upsertV4Position({tokenId:1n,owner:wallet,poolId:'pool',poolKey:key,currency0:key.currency0,currency1:key.currency1,fee:key.fee,tickSpacing:key.tickSpacing,hooks:key.hooks,tickLower:-20,tickUpper:20,liquidity:1_000n,initialAmount0:0n,initialAmount1:200n,mintHash:`0x${'33'.repeat(32)}`,targetToken:key.currency0,fundingToken:key.currency1,targetDecimals:18,fundingDecimals:6,targetIndex:0,fundingIndex:1,openIntentId:'open'});repo.ingestDeposit({id:'open',positionId:'v4:1',txHash:`0x${'33'.repeat(32)}`,logIndex:0,amounts:{token0:0n,token1:200n},blockNumber:1n,blockTimestamp:new Date().toISOString()});
 const receipt={status:'success' as const,transactionHash:hash,blockNumber:7n,gasUsed:80_000n,effectiveGasPrice:2n,logs:[transferLog(key.currency0,11n),transferLog(key.currency1,22n)]};
 const client:any={
  getBlock:async()=>({number:7n,timestamp:1_000n}),getBlockNumber:async()=>7n,getBytecode:async()=> '0x01',estimateGas:async()=>100n,getGasPrice:async()=>1n,waitForTransactionReceipt:async()=>receipt,
 readContract:async({address,functionName}:{address:Address;functionName:string})=>{
   if(functionName==='ownerOf')return wallet;
   if(functionName==='getPoolAndPositionInfo')return [key,positionInfo];
   if(functionName==='getPositionLiquidity')return remaining;
   if(functionName==='getSlot0')return [q96,0,0,500];
   if(functionName==='getLiquidity')return 10_000n;
   if(functionName==='getPositionInfo')return [remaining,0n,0n];
   if(functionName==='getFeeGrowthInside')return [0n,0n];
   if(functionName==='decimals')return address.toLowerCase()===key.currency0.toLowerCase()?18:6;
   if(functionName==='symbol')return address.toLowerCase()===key.currency0.toLowerCase()?'TOKEN0':'TOKEN1';
   if(functionName==='name')return address.toLowerCase()===key.currency0.toLowerCase()?'Token Zero':'Token One';
   throw new Error(`UNEXPECTED_READ:${functionName}`);
  },
  multicall:async({contracts}:{contracts:readonly any[]})=>Promise.all(contracts.map(async contract=>({status:'success',result:contract.functionName==='getBlockNumber'?7n:await client.readContract(contract)}))),
 };
 const rpc={config:{chainId:4663,rpcUrls:['http://127.0.0.1'],assets:{}},withClient:async(fn:(value:any)=>unknown)=>fn(client)} as any,preflightState={owner:wallet,liquidity:1_000n,tickLower:-20,tickUpper:20,key,pool:{key,sqrtPriceX96:q96,tick:0,liquidity:10_000n,initialized:true,lpFee:500,protocolFee:0,blockNumber:6n},price1Per0:1};let sends=0;
 const input={repo,rpc,walletClient:{} as any,wallet,tokenId:1n,action,percent:action==='partial_close'?50 as const:undefined,slippageBps:50,deadlineSeconds:600,idempotencyKey:`manual-policy:${action}`,allowPublicWrites:false,preflightState:preflightState as any,transactionSender:async()=>{sends++;return hash;}};
 return {dir,repo,input,sends:()=>sends,close(){repo.close();rmSync(dir,{recursive:true,force:true});}};
}

describe('normal V4 lifecycle manual-swap-only behavior',()=>{
 for(const action of ['collect','partial_close','full_close'] as const)it(`${action} reconciles wallet assets without creating an unrelated transaction workflow`,async()=>{
  const f=fixture(action);try{
   const first=await executeV4Lifecycle(f.input),second=await executeV4Lifecycle(f.input);
   expect(first).toMatchObject({ok:true,status:'COMPLETED',hash,transfers:{token0:11n,token1:22n}});
   expect(second).toMatchObject({ok:true,status:'ALREADY_COMPLETED',hash});
   expect(f.sends()).toBe(1);
    expect(f.repo.db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='v4_close_swap_workflows'").get()).toEqual({count:0});
   expect(f.repo.db.prepare("SELECT COUNT(*) count FROM chain_transaction_journal WHERE workflow_identity<>?").get(f.input.idempotencyKey)).toEqual({count:0});
   expect(f.repo.db.prepare("SELECT event_kind,valuation_status FROM realized_pnl_events").all()).toEqual([{event_kind:action==='collect'?'CLAIM':'CLOSE',valuation_status:'AVAILABLE'}]);
   if(action==='full_close')expect(f.repo.db.prepare("SELECT basis_after_usd_micros FROM v4_position_basis_events WHERE event_kind='CONSUME'").get()).toEqual({basis_after_usd_micros:'0'});
  }finally{f.close();}
 });
});
