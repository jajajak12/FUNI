import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FallbackRpc, robinhoodMainnet } from '@robin/core';
import { migrateSqlite, SqliteLedgerRepository } from '@robin/ledger';
import { discoverV4Pools } from '@robin/v4';
import { startPinnedFork } from './fork-fixture.js';
import { executeV4OperationalOpen, v4OperationalOpenPreflight } from './v4-operational-executor.js';
import { trustedWethUsdReference } from './portfolio.js';
import { runtimePaths } from './runtime.js';

const chain={id:4663,name:'Robinhood Fork',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['http://127.0.0.1']}}} as const;
const erc20=[{type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'}],outputs:[{type:'bool'}]}] as const;
const assert:(value:unknown,message:string)=>asserts value=(value,message)=>{if(!value)throw new Error(`ASSERTION_FAILED:${message}`);};
const json=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item,2);
const proof=(path:string)=>{if(!existsSync(path))return {exists:false};const stat=statSync(path);return {exists:true,size:stat.size,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};};

export async function runV4OperationalOpenE2E(){
 const pinnedGasPriceWei=116_700_000n,productionBefore=proof(runtimePaths.databasePath),fork=await startPinnedFork({gasPriceWei:pinnedGasPriceWei}),artifactPath=join(fork.dir,'v4-operational-open-e2e.json'),artifact:any={artifactPath,pinnedBlock:17_400_000,pinnedGasPriceWei,mainnetTransactionsSent:0};
 try{
  await (fork.client as any).request({method:'evm_setNextBlockTimestamp',params:[Math.floor(Date.now()/1000)]});await (fork.client as any).request({method:'evm_mine',params:[]});
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:[fork.url]}),found=await discoverV4Pools(rpc,robinhoodMainnet.assets.WETH),pool=found.status==='available'?found.value.find(item=>item.id==='0xfcfae8fa0bd6da961bcf5d990f27690932deac4f093e99bf3e871691c6586593'):undefined;assert(pool&&pool.liquidity>0n,'operational pool unavailable');
  const operator=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),wallet=createWalletClient({account:operator,chain,transport:http(fork.url)}),source='0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca' as Address;
  for(const address of [operator.address,source])await (fork.client as any).request({method:'anvil_setBalance',params:[address,'0x3635C9ADC5DEA00000']});
  await (fork.client as any).request({method:'anvil_impersonateAccount',params:[source]});const sourceWallet=createWalletClient({account:source,chain,transport:http(fork.url)});await fork.client.waitForTransactionReceipt({hash:await sourceWallet.writeContract({address:robinhoodMainnet.assets.USDG,abi:erc20,functionName:'transfer',args:[operator.address,5_000_000n]})});await (fork.client as any).request({method:'anvil_stopImpersonatingAccount',params:[source]});
  const dbPath=join(fork.dir,'v4-operational-open.sqlite');migrateSqlite(dbPath,'infra/migrations');const repo=new SqliteLedgerRepository(dbPath);
  repo.upsertV4RegistryPool({poolId:pool.id,currency0:pool.key.currency0,currency1:pool.key.currency1,initializeFeeRaw:pool.key.fee,tickSpacing:pool.key.tickSpacing,hooks:pool.key.hooks,initializationBlock:1n,dynamicFee:false,staticFeePips:pool.key.fee,hookClassification:'ZERO_HOOK'});
  repo.refreshV4RegistryPool({poolId:pool.id,sqrtPriceX96:pool.sqrtPriceX96,tick:pool.tick,liquidity:pool.liquidity,protocolFee:pool.protocolFee??0,lpFeePips:pool.lpFee??pool.key.fee,initialized:true,refreshBlock:pool.blockNumber,validationStatus:'ELIGIBLE',blockers:[]});
  const native=await trustedWethUsdReference(rpc);assert(native.status==='available','native USD unavailable');const observedAtMs=Date.parse(native.observedAt),selection={poolId:pool.id,key:pool.key,target:robinhoodMainnet.assets.WETH,funding:robinhoodMainnet.assets.USDG,targetIndex:0 as const,fundingIndex:1 as const,amount:5_000_000n,targetSymbol:'WETH',fundingSymbol:'USDG',targetDecimals:18,fundingDecimals:6,feeSemantics:pool.feeSemantics,hookStatus:pool.hookSemantics,valuationProvenance:{source:'pinned fork StateView'},selectionId:'operational-fork'},runtime={executionEnabled:true,dryRun:false,emergencyPause:false,signerConfigured:true,allowlisted:true},common={repo,rpc,wallet:operator.address,runtime,selection,range:{upperDropPct:0,lowerDropPct:30},maxPositionUsd:100,maxApprovalUsd:100,maxTxGasUsd:.25,maxLifecycleGasUsd:1,slippageBps:50,maxSlippageBps:50,nativeUsd:native.value,nativeUsdSource:native.source,nativeUsdObservedAtMs:observedAtMs,nativeUsdFreshUntilMs:observedAtMs+120_000,fundingUsd:1,priceObservedAtMs:Date.now(),priceFreshUntilMs:Date.now()+120_000,gasPriceWei:pinnedGasPriceWei,log:(event:string,details:Record<string,unknown>)=>{if(event==='v4_operational_gas_estimate')(artifact.gasStages??=[]).push(details);}};
  const preflight=await v4OperationalOpenPreflight(common);assert(preflight.gate.executionReachable,'operational preflight blocked');const key='fork-operational-open',intent=repo.createV4LiveOpenIntent({idempotencyKey:key,owner:operator.address,poolId:pool.id,poolKey:pool.key,amount:selection.amount,payload:{lane:'operational',selection}});
  const result=await executeV4OperationalOpen({...common,walletClient:wallet,intentId:String(intent.id),idempotencyKey:key}),duplicate=await executeV4OperationalOpen({...common,walletClient:wallet,intentId:String(intent.id),idempotencyKey:key});assert(result.status==='POSITION_RECONCILED','operational open failed');assert(duplicate.status==='ALREADY_COMPLETED','duplicate operational callback was not idempotent');assert(repo.listV4Positions().length===1,'duplicate callback minted more than one tracked NFT');repo.close();
  Object.assign(artifact,{ok:true,preflight:{status:preflight.status,gate:preflight.gate,gas:preflight.gas},result,duplicate,trackedNfts:1,productionIsolation:{before:productionBefore,after:proof(runtimePaths.databasePath)},allWritesLoopback:true});writeFileSync(artifactPath,json(artifact));return artifact;
 }catch(error){artifact.error=error instanceof Error?error.stack??error.message:String(error);writeFileSync(artifactPath,json(artifact));throw new Error(`${artifact.error}\nartifact:${artifactPath}`);}finally{await fork.stop();}
}
