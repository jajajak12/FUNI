import type { FallbackRpc } from '@funi/core';

export type RpcAttribution={
 provider:string;startedAt:string;endedAt?:string;totalRpcDurationMs?:number;
 ethCallCount:number;eth_blockNumberCount:number;getCodeCount:number;getLogsCount:number;
 receiptCount:number;blockReadCount:number;multicallCount:number;multicallMembers:number;
 estimateGasCount:number;getBalanceCount:number;gasPriceCount:number;chainIdCount:number;
 byStage?:Record<string,{ethCallCount:number;eth_blockNumberCount:number;getCodeCount:number;blockReadCount:number;estimateGasCount:number;getBalanceCount:number;gasPriceCount:number;chainIdCount:number;multicallCount:number;multicallMembers:number}>;
};
export function attributedRpc(base:FallbackRpc,provider:string,ethCallBudget:number,shared?:RpcAttribution,stage='unattributed'){
 const started=Date.now(),metrics=shared??{provider,startedAt:new Date(started).toISOString(),ethCallCount:0,eth_blockNumberCount:0,getCodeCount:0,getLogsCount:0,receiptCount:0,blockReadCount:0,multicallCount:0,multicallMembers:0,estimateGasCount:0,getBalanceCount:0,gasPriceCount:0,chainIdCount:0};
 const stageMetrics=()=>((metrics.byStage??={})[stage]??={ethCallCount:0,eth_blockNumberCount:0,getCodeCount:0,blockReadCount:0,estimateGasCount:0,getBalanceCount:0,gasPriceCount:0,chainIdCount:0,multicallCount:0,multicallMembers:0});
 const rpc={...base,config:base.config,metrics:base.metrics,withClient:<T>(work:(client:any,url:string)=>Promise<T>)=>base.withClient((client:any)=>{
  const wrapped=new Proxy(client,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(typeof value!=='function')return value;return (...args:any[])=>{
   const perStage=stageMetrics();let calls=0;if(key==='multicall'){const members=Number(args[0]?.contracts?.length??0);metrics.multicallCount++;metrics.multicallMembers+=members;perStage.multicallCount++;perStage.multicallMembers+=members;calls=members;}else if(key==='readContract'||key==='simulateContract'||key==='call'||key==='estimateContractGas')calls=1;
   if(calls){if(metrics.ethCallCount+calls>ethCallBudget)throw new Error(`RPC_ETH_CALL_BUDGET_EXCEEDED:${ethCallBudget}`);metrics.ethCallCount+=calls;perStage.ethCallCount+=calls;}
   if(key==='getBlockNumber'){metrics.eth_blockNumberCount++;perStage.eth_blockNumberCount++;}else if(key==='getBytecode'){metrics.getCodeCount++;perStage.getCodeCount++;}else if(key==='getLogs')metrics.getLogsCount++;else if(key==='getTransactionReceipt')metrics.receiptCount++;else if(key==='getBlock'){metrics.blockReadCount++;perStage.blockReadCount++;}else if(key==='estimateGas'){metrics.estimateGasCount++;perStage.estimateGasCount++;}else if(key==='getBalance'){metrics.getBalanceCount++;perStage.getBalanceCount++;}else if(key==='getGasPrice'){metrics.gasPriceCount++;perStage.gasPriceCount++;}else if(key==='getChainId'){metrics.chainIdCount++;perStage.chainIdCount++;}
   return value.apply(target,args);
  };}});
  return work(wrapped,provider);
 })} as unknown as FallbackRpc;
 (rpc as any).__cacheKey=(base as any).__cacheKey??base;
 return {rpc,metrics,finish(){metrics.endedAt=new Date().toISOString();metrics.totalRpcDurationMs=Date.now()-started;return metrics;}};
}
