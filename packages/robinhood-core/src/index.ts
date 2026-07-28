import { createPublicClient, getAddress, http, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const RH_MAINNET = 4663;
export const RH_TESTNET = 46630;
export type Availability<T> = { status: 'available'; value: T; provenance: Provenance } | { status: 'unavailable'; reason: string; provenance?: Provenance; details?: unknown };
export type Provenance = { provider: string; observedAt: string; blockNumber?: bigint; confidence: 'verified' | 'derived' | 'partial' };
export type ExplorerStatus='VERIFIED'|'MISMATCH'|'UNAVAILABLE'|'RATE_LIMITED'|'UNKNOWN';
export type FinalVerificationStatus='VERIFIED_ONCHAIN'|'BLOCKED';
export type DeploymentVerificationResult={
 officialRegistryMatch:boolean;chainIdMatch:boolean;addressMatch:boolean;codePresent:boolean;runtimeCodeHashMatch:boolean;interfaceProbeMatch:boolean;relationshipMatch:boolean;
 explorerStatus:ExplorerStatus;explorerContractMatch:boolean;finalVerificationStatus:FinalVerificationStatus;executionAllowedByDeploymentAudit:boolean;blockingReasons:string[];warnings:string[];
};
export function evaluateDeploymentVerification(input:Omit<DeploymentVerificationResult,'finalVerificationStatus'|'executionAllowedByDeploymentAudit'|'blockingReasons'|'warnings'>):DeploymentVerificationResult{
 const blockingReasons:string[]=[];
 if(!input.chainIdMatch)blockingReasons.push('CHAIN_ID_MISMATCH');
 if(!input.officialRegistryMatch||!input.addressMatch)blockingReasons.push('OFFICIAL_ADDRESS_MISMATCH');
 if(!input.codePresent)blockingReasons.push('BYTECODE_MISSING');
 if(!input.runtimeCodeHashMatch)blockingReasons.push('RUNTIME_CODE_MISMATCH');
 if(!input.interfaceProbeMatch)blockingReasons.push('INTERFACE_PROBE_FAILED');
 if(!input.relationshipMatch)blockingReasons.push('CONTRACT_RELATIONSHIP_MISMATCH');
 const complete=[input.officialRegistryMatch,input.chainIdMatch,input.addressMatch,input.codePresent,input.runtimeCodeHashMatch,input.interfaceProbeMatch,input.relationshipMatch].every(Boolean);
 if(!complete&&!blockingReasons.length)blockingReasons.push('ONCHAIN_VERIFICATION_INCOMPLETE');
 const warnings:string[]=[];
 if(complete&&input.explorerStatus!=='VERIFIED')warnings.push(`Explorer metadata ${input.explorerStatus.toLowerCase().replace('_',' ')}; complete on-chain verification passed`);
 return {...input,finalVerificationStatus:complete?'VERIFIED_ONCHAIN':'BLOCKED',executionAllowedByDeploymentAudit:complete,blockingReasons,warnings};
}
export type ChainConfig = { chainId: number; name: string; rpcUrls: readonly string[]; explorerUrl?: string; nativeSymbol: string; assets: Record<string, Address> };
export const robinhoodMainnet: ChainConfig = {
  chainId: RH_MAINNET, name: 'Robinhood Chain', rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], explorerUrl: 'https://robinhoodchain.blockscout.com', nativeSymbol: 'ETH',
  assets: { WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' }
};
export const UNISWAP_V3_ROBINHOOD_SOURCE='https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments';
export const UNISWAP_DEPLOYMENTS_JSON='https://developers.uniswap.org/deployments.json';
export type DeploymentName='factory'|'interfaceMulticall'|'tickLens'|'quoterV2'|'positionManager'|'positionDescriptor'|'nftDescriptor'|'swapRouter02'|'permit2'|'universalRouter';
export type DeploymentSpec={name:DeploymentName;address:Address;sourceUrl:string;sourceType:'official-uniswap-page'|'official-uniswap-deployments-json';jsonRequired?:boolean};
export const ROBINHOOD_V3_DEPLOYMENT_SPECS=Object.freeze([
 {name:'factory',address:getAddress('0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'interfaceMulticall',address:getAddress('0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'tickLens',address:getAddress('0x7dfd4f31be6814d2906bde155c3e1b146eac1468'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'quoterV2',address:getAddress('0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'positionManager',address:getAddress('0x73991a25c818bf1f1128deaab1492d45638de0d3'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'positionDescriptor',address:getAddress('0x6f84dae9c064ff453e5c8af51efb819f8f610225'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'nftDescriptor',address:getAddress('0x2e9d45bb7b30549f5216813ada9a6b7982c5b3ed'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'swapRouter02',address:getAddress('0xcaf681a66d020601342297493863e78c959e5cb2'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'permit2',address:getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page'},
 {name:'universalRouter',address:getAddress('0x8876789976decbfcbbbe364623c63652db8c0904'),sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,sourceType:'official-uniswap-page',jsonRequired:false}
] as const satisfies readonly DeploymentSpec[]);
export type VerifiedDeployment={readonly spec:DeploymentSpec;readonly codePresent:boolean;readonly runtimeCodeHash?:Hex;readonly runtimeCodeSize:number;readonly runtimeCodeHashMatch:boolean;readonly officialPageMatch:boolean;readonly officialJsonMatch:boolean;readonly explorerStatus:ExplorerStatus;readonly explorerContractMatch:boolean;readonly verificationBlock:bigint;readonly verificationTimestamp:Date;readonly status:'verified'|'mismatch'|'unavailable'};
export type VerifiedUniswapV3Deployments={factory:Address;positionManager:Address;swapRouter:Address;quoter:Address;multicall:Address;permit2:Address;universalRouter:Address;sourceUrl:string;verifiedAt:string;verificationBlock:bigint;records:Readonly<Record<DeploymentName,VerifiedDeployment>>;relationships:Readonly<Record<string,boolean>>;verification:DeploymentVerificationResult};
export type V3SwapReadiness={factory:Address;swapRouter:Address;quoter:Address;permit2:Address;chainId:number;verificationBlock:bigint;verifiedAt:string;fingerprint:string;runtimeCodeHashes:Readonly<Record<'factory'|'quoterV2'|'swapRouter02'|'permit2',Hex>>};
const relationshipAbi=[{type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'WETH9',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'feeAmountTickSpacing',stateMutability:'view',inputs:[{type:'uint24'}],outputs:[{type:'int24'}]}] as const;
async function officialContains(url:string,address:Address,fetcher:typeof fetch):Promise<boolean>{try{const r=await fetcher(url);return r.ok&&(await r.text()).toLowerCase().includes(address.toLowerCase());}catch{return false;}}
function aggregateExplorerStatus(statuses:ExplorerStatus[]):ExplorerStatus{if(statuses.every(x=>x==='VERIFIED'))return 'VERIFIED';if(statuses.includes('RATE_LIMITED'))return 'RATE_LIMITED';if(statuses.includes('UNAVAILABLE'))return 'UNAVAILABLE';if(statuses.includes('MISMATCH'))return 'MISMATCH';return 'UNKNOWN';}
/** The persisted official registry plus exact runtime fingerprints and interface relationships are authoritative. Explorer metadata is provenance only. */
export async function auditRobinhoodV3Deployments(rpc:FallbackRpc,fetcher:typeof fetch=fetch):Promise<Availability<VerifiedUniswapV3Deployments>>{
 return rpc.withClient(async client=>{
  const snapshot=loadDeploymentSnapshot();
  const probe=(args:Parameters<typeof client.readContract>[0])=>client.readContract(args);
  const timed=async(url:string):Promise<Response>=>{let error:unknown;for(let attempt=0;attempt<2;attempt++){try{const response=await fetcher(url,{signal:AbortSignal.timeout(1_000)});if(response.ok)return response;error=new Error(`HTTP ${response.status}`);}catch(e){error=e;}if(attempt===0)await new Promise(resolve=>setTimeout(resolve,150));}throw error instanceof Error?error:new Error('fetch failed');};
  const [page,json,latest]=await Promise.all([timed(UNISWAP_V3_ROBINHOOD_SOURCE).then(r=>r.ok?r.text():'').catch(()=>''),timed(UNISWAP_DEPLOYMENTS_JSON).then(r=>r.ok?r.text():'').catch(()=>''),client.getBlock({blockTag:'latest'})]);
  const recordList=await Promise.all(ROBINHOOD_V3_DEPLOYMENT_SPECS.map(async spec=>{
   const [code,explorer]=await Promise.all([client.getBytecode({address:spec.address}),fetcher(`https://robinhoodchain.blockscout.com/api?module=contract&action=getsourcecode&address=${spec.address}`,{signal:AbortSignal.timeout(1_500)}).then(async response=>{if(response.status===429)return {status:'RATE_LIMITED' as const,match:false};if(!response.ok)return {status:'UNAVAILABLE' as const,match:false};try{const data=await response.json() as {message?:string;result?:unknown[]};const match=data.message==='OK'&&Array.isArray(data.result)&&data.result.length>0;return {status:(match?'VERIFIED':'MISMATCH') as ExplorerStatus,match};}catch{return {status:'UNKNOWN' as const,match:false};}}).catch(()=>({status:'UNAVAILABLE' as const,match:false}))]);
   const codePresent=!!code&&code!=='0x',runtimeCodeHash=codePresent?keccak256(code!):undefined,expected=snapshot.contracts[spec.name],runtimeCodeHashMatch=!!runtimeCodeHash&&runtimeCodeHash===expected.runtimeCodeHash&&(code!.length-2)/2===expected.runtimeCodeSize,officialPageMatch=page.toLowerCase().includes(spec.address.toLowerCase()),officialJsonMatch=json.toLowerCase().includes(spec.address.toLowerCase());
   const record:VerifiedDeployment={spec,codePresent,runtimeCodeSize:codePresent?(code!.length-2)/2:0,runtimeCodeHash,runtimeCodeHashMatch,officialPageMatch,officialJsonMatch,explorerStatus:explorer.status,explorerContractMatch:explorer.match,verificationBlock:latest.number,verificationTimestamp:new Date(Number(latest.timestamp)*1000),status:codePresent&&runtimeCodeHashMatch?'verified':'mismatch'};return [spec.name,record] as const;
  }));
  const records=Object.fromEntries(recordList) as Record<DeploymentName,VerifiedDeployment>,factory=records.factory.spec.address,weth=robinhoodMainnet.assets.WETH,checks:Record<string,boolean>={};let interfaceProbeMatch=true;
  for(const n of ['positionManager','quoterV2','swapRouter02'] as const){const address=records[n].spec.address;try{checks[`${n}.factory`]=String(await probe({address,abi:relationshipAbi,functionName:'factory'})).toLowerCase()===factory.toLowerCase();checks[`${n}.WETH9`]=String(await probe({address,abi:relationshipAbi,functionName:'WETH9'})).toLowerCase()===weth.toLowerCase();}catch(error){if(isRetryableRpcFailure(error))throw error;interfaceProbeMatch=false;checks[`${n}.factory`]=false;checks[`${n}.WETH9`]=false;}}
  for(const [fee,spacing] of [[100,1],[500,10],[3000,60],[10000,200]] as const){try{checks[`factory.fee.${fee}`]=Number(await probe({address:factory,abi:relationshipAbi,functionName:'feeAmountTickSpacing',args:[fee]}))===spacing;}catch(error){if(isRetryableRpcFailure(error))throw error;interfaceProbeMatch=false;checks[`factory.fee.${fee}`]=false;}}
  const explorerStatus=aggregateExplorerStatus(Object.values(records).map(r=>r.explorerStatus)),verification=evaluateDeploymentVerification({officialRegistryMatch:ROBINHOOD_V3_DEPLOYMENT_SPECS.every(spec=>snapshot.contracts[spec.name]?.address.toLowerCase()===spec.address.toLowerCase()),chainIdMatch:await client.getChainId()===RH_MAINNET,addressMatch:ROBINHOOD_V3_DEPLOYMENT_SPECS.every(spec=>records[spec.name].spec.address.toLowerCase()===spec.address.toLowerCase()),codePresent:Object.values(records).every(r=>r.codePresent),runtimeCodeHashMatch:Object.values(records).every(r=>r.runtimeCodeHashMatch),interfaceProbeMatch,relationshipMatch:Object.values(checks).every(Boolean),explorerStatus,explorerContractMatch:Object.values(records).every(r=>r.explorerContractMatch)});
  const provenance={provider:'official persisted Uniswap registry + exact rpc runtime fingerprints + interface/relationship probes; explorer informational',observedAt:new Date().toISOString(),blockNumber:latest.number,confidence:(verification.executionAllowedByDeploymentAudit?'verified':'partial') as Provenance['confidence']};
  if(!verification.executionAllowedByDeploymentAudit)return {status:'unavailable',reason:`deployment audit failed: ${verification.blockingReasons.join(',')}`,details:{verification,records,relationships:checks},provenance};
  const value=Object.freeze({factory,positionManager:records.positionManager.spec.address,swapRouter:records.swapRouter02.spec.address,quoter:records.quoterV2.spec.address,multicall:records.interfaceMulticall.spec.address,permit2:records.permit2.spec.address,universalRouter:records.universalRouter.spec.address,sourceUrl:UNISWAP_V3_ROBINHOOD_SOURCE,verifiedAt:new Date().toISOString(),verificationBlock:latest.number,records:Object.freeze(records),relationships:Object.freeze(checks),verification});
  return {status:'available',value,provenance};
 },{stage:'v3_deployment_audit',method:'eth_getCode+eth_call'});
}

const v3SwapDependencyNames=['factory','quoterV2','swapRouter02','permit2'] as const;
type V3SwapDependencyName=typeof v3SwapDependencyNames[number];
const v3SwapReadinessCache=new WeakMap<object,{expiresAt:number;fingerprint:string;value:V3SwapReadiness}>();
export const V3_SWAP_READINESS_TTL_MS=300_000;
function v3SwapReadinessFingerprint(snapshot:DeploymentSnapshot){return createHash('sha256').update(JSON.stringify({schemaVersion:snapshot.schemaVersion,chainId:snapshot.chainId,contracts:v3SwapDependencyNames.map(name=>[name,snapshot.contracts[name]!.address,snapshot.contracts[name]!.runtimeCodeHash,snapshot.contracts[name]!.runtimeCodeSize])})).digest('hex');}
function v3SwapReadinessCacheKey(rpc:FallbackRpc){return (rpc as unknown as {__cacheKey?:object}).__cacheKey??rpc as object;}
/** Execution-scoped proof for the V3 WETH/USDG route. The broad deployment audit remains the explicit audit path. */
export async function v3SwapReadiness(rpc:FallbackRpc,options:{now?:()=>number;ttlMs?:number;snapshotPath?:string}={}):Promise<Availability<V3SwapReadiness>>{
 const snapshot=loadDeploymentSnapshot(options.snapshotPath),fingerprint=v3SwapReadinessFingerprint(snapshot),now=options.now??Date.now,ttlMs=options.ttlMs??V3_SWAP_READINESS_TTL_MS,key=v3SwapReadinessCacheKey(rpc),cached=v3SwapReadinessCache.get(key);if(cached&&cached.expiresAt>now()&&cached.fingerprint===fingerprint&&cached.value.chainId===rpc.config.chainId)return {status:'available',value:cached.value,provenance:{provider:'v3 swap readiness cache',observedAt:cached.value.verifiedAt,blockNumber:cached.value.verificationBlock,confidence:'verified'}};
 const result=await rpc.withClient(async client=>{const [chainId,block,...codes]=await Promise.all([client.getChainId(),client.getBlock({blockTag:'latest'}),...v3SwapDependencyNames.map(name=>client.getBytecode({address:snapshot.contracts[name]!.address}))]);if(chainId!==RH_MAINNET||chainId!==rpc.config.chainId)return {status:'unavailable' as const,reason:'V3_SWAP_READINESS_CHAIN_ID_MISMATCH'};const hashes={} as Record<V3SwapDependencyName,Hex>;for(const [index,name] of v3SwapDependencyNames.entries()){const code=codes[index];if(!code||code==='0x')return {status:'unavailable' as const,reason:`V3_SWAP_READINESS_${name}_BYTECODE_MISSING`};const expected=snapshot.contracts[name]!,hash=keccak256(code);if(hash!==expected.runtimeCodeHash||(code.length-2)/2!==expected.runtimeCodeSize)return {status:'unavailable' as const,reason:`V3_SWAP_READINESS_${name}_RUNTIME_CODE_MISMATCH`};hashes[name]=hash;}const value=Object.freeze({factory:snapshot.contracts.factory!.address,quoter:snapshot.contracts.quoterV2!.address,swapRouter:snapshot.contracts.swapRouter02!.address,permit2:snapshot.contracts.permit2!.address,chainId,verificationBlock:block.number,verifiedAt:new Date(now()).toISOString(),fingerprint,runtimeCodeHashes:Object.freeze(hashes)});return {status:'available' as const,value,provenance:{provider:'execution-scoped V3 runtime code verification',observedAt:value.verifiedAt,blockNumber:block.number,confidence:'verified' as const}};},{stage:'v3_swap_readiness',method:'eth_chainId+eth_getBlockByNumber+eth_getCode'});
 if(result.status==='available')v3SwapReadinessCache.set(key,{expiresAt:now()+ttlMs,fingerprint,value:result.value});return result;
}

/** A historical, checksummed deployment record.  It is deliberately separate
 * from the live audit: snapshot verification never calls fetch or a public RPC. */
export type DeploymentSnapshot={
 schemaVersion:1;
 chainId:number; verificationBlock:string; blockTimestamp:string; snapshotCreatedAt:string;
 officialSourceUrls:string[]; contracts:Record<string,{address:Address;runtimeCodeHash:Hex;runtimeCodeSize:number}>;
 relationships:{factory:Address;weth:Address;factoryConsumers:string[];wethConsumers:string[];feeTierTickSpacing:Record<string,number>}; checksum:string;
};
export const DEFAULT_DEPLOYMENT_SNAPSHOT='config/robinhood-v3-deployments.16574811.json';
function canonicalJson(value:unknown):string { if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;return JSON.stringify(value); }
export function deploymentSnapshotChecksum(snapshot:Omit<DeploymentSnapshot,'checksum'>):string{return `sha256:${createHash('sha256').update(canonicalJson(snapshot)).digest('hex')}`;}
export function loadDeploymentSnapshot(path=process.env.ROBINHOOD_DEPLOYMENT_SNAPSHOT??DEFAULT_DEPLOYMENT_SNAPSHOT):DeploymentSnapshot{
 const parsed=JSON.parse(readFileSync(resolve(path),'utf8')) as DeploymentSnapshot;const {checksum,...body}=parsed;
 if(parsed.schemaVersion!==1)throw new Error(`unsupported deployment snapshot schema: ${String(parsed.schemaVersion)}`);
 if(parsed.chainId!==RH_MAINNET||parsed.verificationBlock!=='16574811')throw new Error('deployment snapshot is not pinned to Robinhood block 16574811');
 if(checksum!==deploymentSnapshotChecksum(body))throw new Error(`deployment snapshot checksum mismatch: ${path}`);
 for(const name of [...ROBINHOOD_V3_DEPLOYMENT_SPECS.map(x=>x.name),'WETH','USDG'])if(!parsed.contracts[name])throw new Error(`deployment snapshot missing ${name}`);
 for(const spec of ROBINHOOD_V3_DEPLOYMENT_SPECS)if(parsed.contracts[spec.name]!.address.toLowerCase()!==spec.address.toLowerCase())throw new Error(`deployment snapshot address mismatch: ${spec.name}`);
 for(const name of ['WETH','USDG'] as const)if(parsed.contracts[name]!.address.toLowerCase()!==robinhoodMainnet.assets[name].toLowerCase())throw new Error(`deployment snapshot address mismatch: ${name}`);
 return Object.freeze(parsed);
}
function snapshotRegistry(snapshot:DeploymentSnapshot):VerifiedUniswapV3Deployments{
 const verificationBlock=BigInt(snapshot.verificationBlock), timestamp=new Date(snapshot.blockTimestamp);
 const records=Object.fromEntries(ROBINHOOD_V3_DEPLOYMENT_SPECS.map(spec=>[spec.name,{spec,codePresent:true,runtimeCodeHash:snapshot.contracts[spec.name]!.runtimeCodeHash,runtimeCodeSize:snapshot.contracts[spec.name]!.runtimeCodeSize,runtimeCodeHashMatch:true,officialPageMatch:true,officialJsonMatch:true,explorerStatus:'VERIFIED' as const,explorerContractMatch:true,verificationBlock,verificationTimestamp:timestamp,status:'verified' as const}])) as Record<DeploymentName,VerifiedDeployment>;
 const verification=evaluateDeploymentVerification({officialRegistryMatch:true,chainIdMatch:true,addressMatch:true,codePresent:true,runtimeCodeHashMatch:true,interfaceProbeMatch:true,relationshipMatch:true,explorerStatus:'VERIFIED',explorerContractMatch:true});
 return Object.freeze({factory:snapshot.contracts.factory!.address,positionManager:snapshot.contracts.positionManager!.address,swapRouter:snapshot.contracts.swapRouter02!.address,quoter:snapshot.contracts.quoterV2!.address,multicall:snapshot.contracts.interfaceMulticall!.address,permit2:snapshot.contracts.permit2!.address,universalRouter:snapshot.contracts.universalRouter!.address,sourceUrl:snapshot.officialSourceUrls[0]!,verifiedAt:snapshot.snapshotCreatedAt,verificationBlock,records:Object.freeze(records),relationships:Object.freeze({}),verification});
}
export type ObservedDeploymentSnapshot={chainId:number;blockNumber:bigint;contracts:Record<string,{address:Address;runtimeCodeHash?:Hex;runtimeCodeSize:number}>};
export function comparePinnedDeploymentSnapshot(snapshot:DeploymentSnapshot,observed:ObservedDeploymentSnapshot):string[]{const mismatches:string[]=[];if(observed.chainId!==snapshot.chainId)mismatches.push(`chainId: expected ${snapshot.chainId}, received ${observed.chainId}`);if(observed.blockNumber<BigInt(snapshot.verificationBlock))mismatches.push(`block: snapshot requires at least ${snapshot.verificationBlock}, received ${observed.blockNumber}`);for(const [name,expected] of Object.entries(snapshot.contracts)){const actual=observed.contracts[name];if(!actual){mismatches.push(`${name}: missing observed contract`);continue;}if(actual.address.toLowerCase()!==expected.address.toLowerCase())mismatches.push(`${name}: address expected ${expected.address}, received ${actual.address}`);if(actual.runtimeCodeHash!==expected.runtimeCodeHash||actual.runtimeCodeSize!==expected.runtimeCodeSize)mismatches.push(`${name}: expected ${expected.runtimeCodeHash}/${expected.runtimeCodeSize}, received ${actual.runtimeCodeHash??'none'}/${actual.runtimeCodeSize}`);}return mismatches;}
/** Verify the pinned runtime against an already-running local fork only. */
export async function auditRobinhoodV3Snapshot(rpc:FallbackRpc,path?:string):Promise<Availability<VerifiedUniswapV3Deployments>>{
 let snapshot:DeploymentSnapshot;try{snapshot=loadDeploymentSnapshot(path);}catch(error){return {status:'unavailable',reason:error instanceof Error?error.message:String(error)};}
 return rpc.withClient(async client=>{try{
  const [chainId,block]=await Promise.all([client.getChainId(),client.getBlockNumber()]),contracts:ObservedDeploymentSnapshot['contracts']={};
  for(const [name,expected] of Object.entries(snapshot.contracts)){const code=await client.getBytecode({address:expected.address});contracts[name]={address:expected.address,runtimeCodeHash:code&&code!=='0x'?keccak256(code):undefined,runtimeCodeSize:code&&code!=='0x'?(code.length-2)/2:0};}
  const mismatches=comparePinnedDeploymentSnapshot(snapshot,{chainId,blockNumber:block,contracts});
  const checks:Record<string,boolean>={};const relationAbi=relationshipAbi;
  for(const name of snapshot.relationships.factoryConsumers){const address=snapshot.contracts[name]?.address;if(!address){mismatches.push(`missing factory consumer ${name}`);continue;}checks[`${name}.factory`]=(await client.readContract({address,abi:relationAbi,functionName:'factory'})).toLowerCase()===snapshot.relationships.factory.toLowerCase();}
  for(const name of snapshot.relationships.wethConsumers){const address=snapshot.contracts[name]?.address;if(!address){mismatches.push(`missing WETH consumer ${name}`);continue;}checks[`${name}.WETH9`]=(await client.readContract({address,abi:relationAbi,functionName:'WETH9'})).toLowerCase()===snapshot.relationships.weth.toLowerCase();}
  for(const [fee,spacing] of Object.entries(snapshot.relationships.feeTierTickSpacing))checks[`factory.fee.${fee}`]=Number(await client.readContract({address:snapshot.contracts.factory!.address,abi:relationAbi,functionName:'feeAmountTickSpacing',args:[Number(fee)]}))===spacing;
  if(mismatches.length||!Object.values(checks).every(Boolean))return {status:'unavailable',reason:'snapshot deployment audit failed',details:{mismatches,relationships:checks}};
  const value=snapshotRegistry(snapshot);return {status:'available',value:{...value,relationships:Object.freeze(checks)},provenance:{provider:'committed deployment snapshot + local fork RPC',observedAt:new Date().toISOString(),blockNumber:block,confidence:'verified'}};
 }catch(error){return {status:'unavailable',reason:`snapshot deployment audit failed: ${error instanceof Error?error.message:String(error)}`};}});
}

export const PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT='PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT' as const;
export type PinnedSnapshotVerificationInput={mode:typeof PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT;rpcUrl:string;productionExecutionEnabled:boolean;snapshotPath?:string};
export function isLoopbackRpcUrl(value:string):boolean{try{const host=new URL(value).hostname.toLowerCase();return host==='127.0.0.1'||host==='localhost'||host==='::1'||host==='[::1]';}catch{return false;}}
/** Test-only verification mode. The live production audit above remains unchanged and explorer-backed. */
export async function auditRobinhoodV3PinnedTestSnapshot(rpc:FallbackRpc,input:PinnedSnapshotVerificationInput):Promise<Availability<VerifiedUniswapV3Deployments>>{
 if(input.mode!==PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT)return {status:'unavailable',reason:'PINNED_SNAPSHOT_MODE_INVALID'};
 if(input.productionExecutionEnabled)return {status:'unavailable',reason:'PINNED_SNAPSHOT_REJECTED_FOR_PRODUCTION_EXECUTION'};
 if(!isLoopbackRpcUrl(input.rpcUrl)||rpc.config.rpcUrls.some(url=>!isLoopbackRpcUrl(url)))return {status:'unavailable',reason:'PINNED_SNAPSHOT_REQUIRES_LOOPBACK_RPC'};
 const result=await auditRobinhoodV3Snapshot(rpc,input.snapshotPath);
 if(result.status==='unavailable')return result;
 return {...result,provenance:{...result.provenance,provider:`${PINNED_VERIFIED_DEPLOYMENT_SNAPSHOT}: committed snapshot + exact local code hashes`}};
}

export type RpcHealth = { url: string; chainId?: number; latencyMs: number; healthy: boolean; error?: string; observedAt: string };
export function redactRpcUrl(value:string){try{const u=new URL(value);return `${u.protocol}//${u.hostname}${u.port?`:${u.port}`:''}`;}catch{return 'invalid-rpc-url';}}
/** Canonical irreversible secret stripping for persisted and operator-visible text. */
export function sanitizeSensitiveText(value:unknown):string{
 let text=typeof value==='string'?value:value instanceof Error?value.message:String(value);
 text=text.replace(/https?:\/\/[^\s"'<>]+/gi,raw=>{try{const url=new URL(raw),host=`${url.protocol}//${url.hostname}${url.port?`:${url.port}`:''}`;return `${host}/[REDACTED]`;}catch{return '[REDACTED_RPC_URL]';}});
 text=text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [REDACTED]');
 text=text.replace(/\b(Authorization|Proxy-Authorization)\s*[:=]\s*[^\r\n,;]+/gi,'$1: [REDACTED]');
 text=text.replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)\s*[:=]\s*["']?[^\s,"';}]+["']?/gi,'$1=[REDACTED]');
 text=text.replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|key|token|secret)=)[^\s&#]+/gi,'$1[REDACTED]');
 return text;
}
/** Uses the ordered list when configured, retaining the legacy single URL for compatibility. */
export function orderedRpcUrls(urlList?:string,legacyUrl?:string):string[]{
 const list=urlList?.split(',').map(url=>url.trim()).filter(Boolean)??[],urls=list.length?list:legacyUrl?[legacyUrl.trim()]:[];
 if(!urls.length)throw new Error('RPC_URL_REQUIRED');
 for(const url of urls)try{new URL(url);}catch{throw new Error(`INVALID_RPC_URL:${redactRpcUrl(url)}`);}
 return [...new Set(urls)];
}
function rpcErrorNodes(error:unknown){
 const nodes:unknown[]=[],queue=[error],seen=new Set<unknown>();
 while(queue.length){const value=queue.shift();if(!value||typeof value!=='object'||seen.has(value))continue;seen.add(value);nodes.push(value);const row=value as Record<string,unknown>;for(const key of ['cause','error','errors','details','metaMessages']){const child=row[key];if(Array.isArray(child))queue.push(...child);else if(child&&typeof child==='object')queue.push(child);}}
 return nodes;
}
function rpcErrorText(error:unknown){return rpcErrorNodes(error).flatMap(value=>{const row=value as Record<string,unknown>;return ['name','message','code','details'].map(key=>typeof row[key]==='string'||typeof row[key]==='number'?String(row[key]):'');}).join(' ');}
export function isRevertedRpcError(error:unknown):boolean{return /revert(?:ed)?|ContractFunctionRevertedError|RawContractError/i.test(rpcErrorText(error));}
export function isRetryableRpcFailure(error:unknown):boolean{
 if(isRevertedRpcError(error))return false;
 return rpcErrorNodes(error).some(value=>{const item=value as {name?:unknown;message?:unknown;status?:unknown;code?:unknown;details?:unknown},text=[item.name,item.message,item.code,typeof item.details==='string'?item.details:''].map(String).join(' '),status=Number(item.status),code=Number(item.code);if(item.code==='RPC_PROVIDER_FAILURE'||[408,425,429,500,502,503,504].includes(status)||[-32005,-32002].includes(code)||/\b(?:408|425|429|500|502|503|504)\b|too many requests|provider (?:is )?unavailable|service unavailable|HTTP request failed/i.test(text))return true;if(code===-32603&&/request failed|provider|upstream|unavailable|timeout|network/i.test(text))return true;if(/timeout|timed out|abort(?:ed)?/i.test(text))return true;return /HttpRequestError|FetchError|TypeError|transport|network error|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text);});
}
export type RpcOperationContext={workflowId?:string;stage?:string;method?:string;signal?:AbortSignal};
export type RpcAttemptContext={signal:AbortSignal;providerIndex:number;attempt:number};
export type RpcFailoverEvent={
 event:'rpc_provider_pool_configured'|'rpc_provider_retry'|'rpc_provider_selected'|'rpc_provider_terminal'|'rpc_preflight_operation_started'|'rpc_preflight_operation_succeeded'|'rpc_preflight_operation_failed';
 workflowId?:string;providerIndex:number;stage:string;method:string;status?:number;attempt:number;cooldownMs:number;
 configuredProviderCount:number;eligibleProviderCount:number;elapsedMs?:number;retryable?:boolean;errorClass?:string;errorCode?:string|number;
 outcome:'configured'|'started'|'cooldown'|'selected'|'failover'|'not_retryable'|'exhausted'|'cooling_down';
 terminalOutcome?:'succeeded'|'failed'|'timed_out'|'cancelled';
};
function rpcStatus(error:unknown):number|undefined{
 for(const value of rpcErrorNodes(error)){const row=value as {status?:unknown;message?:unknown};if(typeof row.status==='number'&&Number.isInteger(row.status))return row.status;const match=String(row.message??'').match(/\bHTTP(?: status)?[=: ]+(\d{3})\b|\b(429)\b/i);if(match)return Number(match[1]??match[2]);}
}
function safeRpcMessage(error:unknown){
 const text=rpcErrorText(error);
 if(rpcStatus(error)===429||/too many requests/i.test(text))return 'Too Many Requests';
 if(/timeout|timed out|abort(?:ed)?/i.test(text))return 'request timed out';
 if(/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|transport|fetch/i.test(text))return 'provider transport unavailable';
 return 'provider request failed';
}
function safeRpcIdentity(error:unknown){
 const row=rpcErrorNodes(error)[0] as Record<string,unknown>|undefined,name=typeof row?.name==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(row.name)?row.name:'Error',rawCode=row?.code,code=(typeof rawCode==='number'&&Number.isFinite(rawCode))||(typeof rawCode==='string'&&/^[A-Z0-9_.-]{1,64}$/i.test(rawCode))?rawCode:undefined;
 return {errorClass:name,errorCode:code,status:rpcStatus(error)};
}
export class RpcProviderFailure extends Error{
 readonly code='RPC_PROVIDER_FAILURE';
 constructor(readonly providerIndex:number,readonly stage:string,readonly method:string,readonly status:number|undefined,message:string,readonly attemptedProviderIndexes:number[]=[providerIndex]){
  super(`RPC_PROVIDER_FAILURE stage=${stage} method=${method} providerIndex=${providerIndex}${status===undefined?'':` status=${status}`} attemptedProviderIndexes=${attemptedProviderIndexes.join(',')} message=${message}`);this.name='RpcProviderFailure';
 }
}
export class RpcAttemptTimeoutError extends Error{
 readonly code='RPC_ATTEMPT_TIMEOUT';readonly status=408;
 constructor(readonly providerIndex:number,readonly stage:string,readonly method:string,readonly timeoutMs:number){
  super(`RPC_ATTEMPT_TIMEOUT stage=${stage} method=${method} providerIndex=${providerIndex} timeoutMs=${timeoutMs}`);this.name='RpcAttemptTimeoutError';
 }
}
export class RpcAttemptCancelledError extends Error{
 readonly code='RPC_ATTEMPT_CANCELLED';
 constructor(readonly providerIndex:number,readonly stage:string,readonly method:string){
  super(`RPC_ATTEMPT_CANCELLED stage=${stage} method=${method} providerIndex=${providerIndex}`);this.name='RpcAttemptCancelledError';
 }
}
export function sanitizeRpcError(error:unknown,context:RpcOperationContext={}):string{
 if(error instanceof RpcProviderFailure)return sanitizeSensitiveText(error.message);
 const raw=error instanceof Error?error.message:String(error);
 if(/^RPC_PREFLIGHT_TIMEOUT stage=[A-Za-z0-9_.-]+ method=[A-Za-z0-9_.+-]+ timeoutMs=\d+$/.test(raw))return sanitizeSensitiveText(raw);
 const stage=context.stage??'rpc_read',method=context.method??'unknown';
 if(isRetryableRpcFailure(error))return new RpcProviderFailure(-1,stage,method,rpcStatus(error),safeRpcMessage(error)).message;
 if(isRevertedRpcError(error))return `EVM_REVERT stage=${stage} method=${method}`;
 if(/https?:\/\/|api[_-]?key|authorization|headers?|request body|environment/i.test(raw))return `RPC_ERROR stage=${stage} method=${method} message=request failed`;
 return sanitizeSensitiveText(raw);
}
export class FallbackRpc {
  readonly clients: PublicClient[];
  readonly metrics={primaryUses:0,fallbackUses:0,failures:0};
  private readonly cooldownUntil:number[];private readonly cooldownMs:number;private readonly now:()=>number;private readonly onProviderEvent?:(event:RpcFailoverEvent)=>void;
  private readonly urls:readonly string[];private readonly attemptTimeoutMs:number;private readonly transportTimeoutMs:number;private readonly injectedClients:boolean;private nextProviderIndex=0;
  constructor(readonly config: ChainConfig, urls = config.rpcUrls,options:{timeoutMs?:number;attemptTimeoutMs?:number;cooldownMs?:number;now?:()=>number;clients?:PublicClient[];onProviderEvent?:(event:RpcFailoverEvent)=>void}={}) {
    const chain={id:config.chainId,name:config.name,nativeCurrency:{name:config.nativeSymbol,symbol:config.nativeSymbol,decimals:18},rpcUrls:{default:{http:urls}}};
    this.urls=[...urls];this.transportTimeoutMs=options.timeoutMs??12_000;this.attemptTimeoutMs=options.attemptTimeoutMs??this.transportTimeoutMs;this.injectedClients=Boolean(options.clients);
    this.clients=options.clients??urls.map(url=>createPublicClient({chain,transport:http(url,{timeout:this.transportTimeoutMs,retryCount:0})}));if(!this.clients.length)throw new Error('RPC_URL_REQUIRED');this.cooldownUntil=this.clients.map(()=>0);this.cooldownMs=options.cooldownMs??30_000;this.now=options.now??Date.now;this.onProviderEvent=options.onProviderEvent;this.onProviderEvent?.({event:'rpc_provider_pool_configured',providerIndex:-1,stage:'rpc_pool',method:'configuration',attempt:0,cooldownMs:this.cooldownMs,configuredProviderCount:this.clients.length,eligibleProviderCount:this.clients.length,outcome:'configured'});
  }
  async health(): Promise<RpcHealth[]> { return Promise.all(this.clients.map(async (client, i) => { const started = Date.now(),url=redactRpcUrl(this.config.rpcUrls[i]!); try { const chainId = await client.getChainId(); return { url, chainId, latencyMs: Date.now()-started, healthy: chainId === this.config.chainId, observedAt: new Date().toISOString() }; } catch (e) { return { url, latencyMs: Date.now()-started, healthy: false, error:e instanceof Error?e.name:'RPC_ERROR',observedAt:new Date().toISOString() }; } })); }
  /** Executes one read against the statically configured chain. Chain identity is
   * audited explicitly by health/deployment checks, not redundantly before every
   * hot-path read. Retryable transport failures may move to the next endpoint;
   * contract reverts never do. */
  private attemptClient(index:number,signal:AbortSignal):PublicClient{
   if(this.injectedClients)return this.clients[index]!;
   const urls=this.urls,chain={id:this.config.chainId,name:this.config.name,nativeCurrency:{name:this.config.nativeSymbol,symbol:this.config.nativeSymbol,decimals:18},rpcUrls:{default:{http:urls}}};
   return createPublicClient({chain,transport:http(urls[index],{timeout:this.transportTimeoutMs,retryCount:0,fetchOptions:{signal}})}) as PublicClient;
  }
  async withClient<T>(operation: (client: PublicClient,attempt:RpcAttemptContext) => Promise<T>,context:RpcOperationContext={}): Promise<T> {
   let failure:{error:unknown;index:number}|undefined,attempt=0;const stage=context.stage??'rpc_read',method=context.method??'unknown',configuredProviderCount=this.clients.length,eligibleProviderCount=this.cooldownUntil.filter(until=>until<=this.now()).length,attempted=new Set<number>(),attemptedProviderIndexes:number[]=[];
   while(attempted.size<configuredProviderCount){const now=this.now(),unattempted=Array.from({length:configuredProviderCount},(_,index)=>index).filter(index=>!attempted.has(index)),eligible=unattempted.filter(index=>this.cooldownUntil[index]!<=now),pool=eligible.length?eligible:unattempted.filter(index=>this.cooldownUntil[index]===Math.min(...unattempted.map(candidate=>this.cooldownUntil[candidate]!)));let index=-1;for(let offset=0;offset<configuredProviderCount;offset++){const candidate=(this.nextProviderIndex+offset)%configuredProviderCount;if(pool.includes(candidate)){index=candidate;break;}}if(index<0)throw new Error('RPC_PROVIDER_SELECTION_FAILED');if(context.signal?.aborted)throw context.signal.reason instanceof Error?context.signal.reason:new RpcAttemptCancelledError(index,stage,method);attempted.add(index);attemptedProviderIndexes.push(index);this.nextProviderIndex=(index+1)%configuredProviderCount;attempt++;const controller=new AbortController(),client=this.attemptClient(index,controller.signal),started=this.now(),base={workflowId:context.workflowId,providerIndex:index,stage,method,attempt,cooldownMs:this.cooldownMs,configuredProviderCount,eligibleProviderCount};let timer:ReturnType<typeof setTimeout>|undefined;
    const cancel=()=>controller.abort(context.signal?.reason??new RpcAttemptCancelledError(index,stage,method));context.signal?.addEventListener('abort',cancel,{once:true});
    if(context.workflowId)this.onProviderEvent?.({event:'rpc_preflight_operation_started',...base,elapsedMs:0,outcome:'started'});
    try{const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=new RpcAttemptTimeoutError(index,stage,method,this.attemptTimeoutMs);controller.abort(error);reject(error);},this.attemptTimeoutMs);timer.unref?.();}),cancelled=new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>{if(context.signal?.aborted)reject(context.signal.reason instanceof Error?context.signal.reason:new RpcAttemptCancelledError(index,stage,method));},{once:true});}),value=await Promise.race([Promise.resolve().then(()=>operation(client,{signal:controller.signal,providerIndex:index,attempt})),timeout,cancelled]),elapsedMs=Math.max(0,this.now()-started);index===0?this.metrics.primaryUses++:this.metrics.fallbackUses++;if(context.workflowId)this.onProviderEvent?.({event:'rpc_preflight_operation_succeeded',...base,elapsedMs,cooldownMs:0,retryable:false,outcome:'selected',terminalOutcome:'succeeded'});this.onProviderEvent?.({event:'rpc_provider_selected',...base,cooldownMs:0,outcome:'selected'});return value;}
    catch(caught){const cancelled=context.signal?.aborted,timedOut=caught instanceof RpcAttemptTimeoutError,retryable=!cancelled&&isRetryableRpcFailure(caught),identity=safeRpcIdentity(caught),hasNext=attempted.size<configuredProviderCount,elapsedMs=Math.max(0,this.now()-started),outcome=retryable?(hasNext?'failover':'exhausted'):'not_retryable',terminalOutcome=cancelled?'cancelled':timedOut?'timed_out':'failed';this.metrics.failures++;if(context.workflowId)this.onProviderEvent?.({event:'rpc_preflight_operation_failed',...base,...identity,elapsedMs,retryable,outcome,terminalOutcome});if(cancelled)throw context.signal!.reason instanceof Error?context.signal!.reason:caught instanceof Error?caught:new RpcAttemptCancelledError(index,stage,method);if(!retryable)throw caught instanceof Error?caught:new Error(String(caught));failure={error:caught,index};this.cooldownUntil[index]=this.now()+this.cooldownMs;this.onProviderEvent?.({event:'rpc_provider_retry',...base,status:identity.status,retryable:true,outcome:'cooldown'});}
    finally{if(timer)clearTimeout(timer);context.signal?.removeEventListener('abort',cancel);}
   }
   const terminal=new RpcProviderFailure(failure!.index,stage,method,rpcStatus(failure!.error),safeRpcMessage(failure!.error),attemptedProviderIndexes);this.onProviderEvent?.({event:'rpc_provider_terminal',workflowId:context.workflowId,providerIndex:failure!.index,stage,method,status:terminal.status,attempt,cooldownMs:this.cooldownMs,configuredProviderCount,eligibleProviderCount,outcome:'exhausted'});throw terminal;
  }
  scoped(context:RpcOperationContext):FallbackRpc{
   const base=this;return new Proxy(this,{get(target,property,receiver){if(property==='withClient')return <T>(operation:(client:PublicClient)=>Promise<T>,local:RpcOperationContext={})=>base.withClient(operation,{...context,...local});const value=Reflect.get(target,property,receiver);return typeof value==='function'?value.bind(target):value;}}) as FallbackRpc;
  }
}
export const erc20Abi = [{ type:'function', name:'decimals', stateMutability:'view', inputs:[], outputs:[{type:'uint8'}] }, { type:'function', name:'symbol', stateMutability:'view', inputs:[], outputs:[{type:'string'}] }, { type:'function', name:'name', stateMutability:'view', inputs:[], outputs:[{type:'string'}] }, { type:'function', name:'totalSupply', stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] }, { type:'function', name:'balanceOf', stateMutability:'view', inputs:[{type:'address'}], outputs:[{type:'uint256'}] }, { type:'function', name:'allowance', stateMutability:'view', inputs:[{type:'address'},{type:'address'}], outputs:[{type:'uint256'}] }] as const;
export type Token = { address: Address; symbol: string; name: string; decimals: number; bytecodeHash?: Hex; canonical: boolean };
export function normalizeSymbol(symbol: string): string { return symbol.trim().replace(/\s+/g, ' ').toUpperCase(); }
const officialAssetApi='https://api.robinhood.com/rhj/assets';
type OfficialAssetResponse={assets?:Array<{tokenSymbol:string;tokenName:string;deployments?:Array<{contractAddress:string;chainId:number}>;status?:string}>};
/** Robinhood's documented live asset registry, used instead of a copied stock-token list. */
export async function fetchOfficialRobinhoodAssetRegistry(fetcher:typeof fetch=fetch):Promise<Availability<Token[]>> { try { const response=await fetcher(officialAssetApi,{headers:{accept:'application/json'}});if(!response.ok)return {status:'unavailable',reason:`official asset registry HTTP ${response.status}`};const data=await response.json() as OfficialAssetResponse;const tokens=(data.assets??[]).flatMap(asset=>(asset.deployments??[]).filter(d=>d.chainId===RH_MAINNET).map(d=>({address:d.contractAddress as Address,symbol:normalizeSymbol(asset.tokenSymbol),name:asset.tokenName,decimals:18,canonical:true})));return {status:'available',value:tokens,provenance:{provider:officialAssetApi,observedAt:new Date().toISOString(),confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`official asset registry unavailable: ${e instanceof Error?e.message:String(e)}`};} }
export async function inspectErc20(rpc: FallbackRpc, address: Address): Promise<Availability<Token>> {
 try{return await rpc.withClient(async client => { const code = await client.getBytecode({ address }); if (!code || code === '0x') return { status:'unavailable' as const, reason:'address has no deployed bytecode' }; const [decimals, symbol, name] = await Promise.all(['decimals','symbol','name'].map(functionName => client.readContract({ address, abi: erc20Abi, functionName: functionName as 'decimals' }))); const d = Number(decimals); if (!Number.isInteger(d) || d < 0 || d > 255) return { status:'unavailable' as const, reason:'invalid token decimals' }; return { status:'available' as const, value:{address, decimals:d, symbol:normalizeSymbol(String(symbol)), name:String(name), canonical:Object.values(rpc.config.assets).some(a=>a.toLowerCase()===address.toLowerCase())}, provenance:{provider:'rpc:eth_call', observedAt:new Date().toISOString(), confidence:'verified' as const} }; },{stage:'token_metadata',method:'eth_call'});}
 catch(error){if(isRetryableRpcFailure(error))throw error;return {status:'unavailable',reason:`token metadata unavailable: ${sanitizeRpcError(error,{stage:'token_metadata',method:'eth_call'})}`};}
}
export type PoolState = { address: Address; factory:Address; token0: Address; token1: Address; fee: number; tickSpacing: number; liquidity: bigint; sqrtPriceX96: bigint; tick: number; initialized:boolean; blockNumber: bigint; createdAt?: Date };
export const v3PoolAbi = [{type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'token0',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'token1',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'fee',stateMutability:'view',inputs:[],outputs:[{type:'uint24'}]},{type:'function',name:'tickSpacing',stateMutability:'view',inputs:[],outputs:[{type:'int24'}]},{type:'function',name:'liquidity',stateMutability:'view',inputs:[],outputs:[{type:'uint128'}]},{type:'function',name:'slot0',stateMutability:'view',inputs:[],outputs:[{type:'uint160'},{type:'int24'},{type:'uint16'},{type:'uint16'},{type:'uint16'},{type:'uint8'},{type:'bool'}]}] as const;
const v3EventAbi=[{type:'event',name:'Swap',inputs:[{indexed:true,name:'sender',type:'address'},{indexed:true,name:'recipient',type:'address'},{indexed:false,name:'amount0',type:'int256'},{indexed:false,name:'amount1',type:'int256'},{indexed:false,name:'sqrtPriceX96',type:'uint160'},{indexed:false,name:'liquidity',type:'uint128'},{indexed:false,name:'tick',type:'int24'}]},{type:'event',name:'Mint',inputs:[{indexed:false,name:'sender',type:'address'},{indexed:true,name:'owner',type:'address'},{indexed:true,name:'tickLower',type:'int24'},{indexed:true,name:'tickUpper',type:'int24'},{indexed:false,name:'amount',type:'uint128'},{indexed:false,name:'amount0',type:'uint256'},{indexed:false,name:'amount1',type:'uint256'}]},{type:'event',name:'Burn',inputs:[{indexed:true,name:'owner',type:'address'},{indexed:true,name:'tickLower',type:'int24'},{indexed:true,name:'tickUpper',type:'int24'},{indexed:false,name:'amount',type:'uint128'},{indexed:false,name:'amount0',type:'uint256'},{indexed:false,name:'amount1',type:'uint256'}]}] as const;
export type V3EventKind='Swap'|'Mint'|'Burn';
export type V3EventRead={kind:V3EventKind;blockNumber:bigint;transactionHash:Hex;logIndex:number;args:Record<string,unknown>};
/** Reads canonical pool events only; callers must select a bounded range and preserve provider provenance. */
export async function readV3Events(rpc:FallbackRpc,address:Address,kind:V3EventKind,fromBlock:bigint,toBlock:bigint):Promise<Availability<V3EventRead[]>>{if(fromBlock>toBlock)return {status:'unavailable',reason:'invalid block range'};return rpc.withClient(async client=>{try{const event=v3EventAbi.find(x=>x.name===kind)!;const logs=await client.getLogs({address,event,fromBlock,toBlock});return {status:'available',value:logs.map(log=>({kind,blockNumber:log.blockNumber!,transactionHash:log.transactionHash!,logIndex:Number(log.logIndex),args:log.args as Record<string,unknown>})),provenance:{provider:'rpc:eth_getLogs',observedAt:new Date().toISOString(),confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`event read unavailable: ${e instanceof Error?e.message:String(e)}`};}})}
export async function inspectV3Pool(rpc: FallbackRpc, address: Address): Promise<Availability<PoolState>> {
 try{return await rpc.withClient(async client => { const code=await client.getBytecode({address}); if (!code || code==='0x') return {status:'unavailable' as const,reason:'pool address has no bytecode'};const [factory,token0,token1,fee,tickSpacing,liquidity,slot0,blockNumber]=await Promise.all([client.readContract({address,abi:v3PoolAbi,functionName:'factory'}),client.readContract({address,abi:v3PoolAbi,functionName:'token0'}),client.readContract({address,abi:v3PoolAbi,functionName:'token1'}),client.readContract({address,abi:v3PoolAbi,functionName:'fee'}),client.readContract({address,abi:v3PoolAbi,functionName:'tickSpacing'}),client.readContract({address,abi:v3PoolAbi,functionName:'liquidity'}),client.readContract({address,abi:v3PoolAbi,functionName:'slot0'}),client.getBlockNumber()]); if(token0===zeroAddress||token1===zeroAddress||token0.toLowerCase()===token1.toLowerCase()||Number(fee)===0||Number(tickSpacing)<=0||slot0[0]===0n)return {status:'unavailable' as const,reason:'malformed or uninitialized v3 pool'}; return {status:'available' as const,value:{address,factory,token0,token1,fee:Number(fee),tickSpacing:Number(tickSpacing),liquidity,sqrtPriceX96:slot0[0],tick:Number(slot0[1]),initialized:Boolean(slot0[6]),blockNumber},provenance:{provider:'rpc:v3-pool',observedAt:new Date().toISOString(),blockNumber,confidence:'verified' as const}};},{stage:'v3_pool_inspection',method:'slot0+liquidity'});}
 catch(error){if(isRetryableRpcFailure(error))throw error;return {status:'unavailable',reason:`v3 pool inspection failed: ${sanitizeRpcError(error,{stage:'v3_pool_inspection',method:'slot0+liquidity'})}`};}
}
const factoryAbi=[{type:'function',name:'getPool',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'uint24'}],outputs:[{type:'address'}]}] as const;
/** Discovers pools only via a verified factory and inspectable canonical quote assets. */
export async function discoverV3Pools(rpc:FallbackRpc,deployments:Availability<{factory:Address}>,token:Address,feeTiers= [100,500,3000,10_000]):Promise<Availability<PoolState[]>> {
 if(deployments.status==='unavailable')return {status:'unavailable',reason:deployments.reason};
 const candidates=Object.values(rpc.config.assets).filter(quote=>quote.toLowerCase()!==token.toLowerCase()).flatMap(quote=>feeTiers.map(fee=>({quote,fee})));
 const inspected=await Promise.all(candidates.map(async({quote,fee})=>{try{const pool=await rpc.withClient(client=>client.readContract({address:deployments.value.factory,abi:factoryAbi,functionName:'getPool',args:[token,quote,fee]}),{stage:'v3_pool_discovery',method:'Factory.getPool'});if(pool===zeroAddress)return null;const value=await inspectV3Pool(rpc,pool);return value.status==='available'&&value.value.factory.toLowerCase()===deployments.value.factory.toLowerCase()&&value.value.fee===fee?value.value:null;}catch(error){if(isRetryableRpcFailure(error))throw error;return null;}}));
 return {status:'available',value:inspected.filter((pool):pool is PoolState=>pool!==null),provenance:{provider:`factory:${deployments.value.factory}`,observedAt:new Date().toISOString(),confidence:'verified'}};
}
export type V3SwapReadinessDiagnostic={chainId:number;readinessStatus:'available'|'unavailable';cache:'hit'|'miss';providerAttemptIndexes:number[];factoryGetPoolReached:boolean;feeTiersQueried:number[];validPools:Array<{address:Address;fee:number}>;durationMs:number;errorCode:string|null};
/** Read-only diagnostic for the exact V3 readiness and pool-discovery path used by canonicalV3. */
export async function diagnoseV3SwapReadiness(rpc:FallbackRpc,options:Parameters<typeof v3SwapReadiness>[1]={}):Promise<V3SwapReadinessDiagnostic>{
 const started=Date.now(),attempts:number[]=[],feeTiers=[100,500,3000,10_000],base=rpc;let factoryGetPoolReached=false;const traced=new Proxy(base,{get(target,property,receiver){if(property==='__cacheKey')return base;if(property==='withClient')return <T>(operation:(client:PublicClient,attempt:RpcAttemptContext)=>Promise<T>,context:RpcOperationContext={})=>base.withClient((client,attempt)=>{attempts.push(attempt.providerIndex);if(context.stage==='v3_pool_discovery'&&context.method==='Factory.getPool')factoryGetPoolReached=true;return operation(client,attempt);},context);return Reflect.get(target,property,receiver);}}) as FallbackRpc,finish=(patch:Omit<V3SwapReadinessDiagnostic,'chainId'|'providerAttemptIndexes'|'durationMs'>):V3SwapReadinessDiagnostic=>({chainId:base.config.chainId,providerAttemptIndexes:[...new Set(attempts)],durationMs:Date.now()-started,...patch});
 try{const readiness=await v3SwapReadiness(traced,options);if(readiness.status==='unavailable')return finish({readinessStatus:'unavailable',cache:'miss',factoryGetPoolReached:false,feeTiersQueried:[],validPools:[],errorCode:readiness.reason});const pools=await discoverV3Pools(traced,readiness,robinhoodMainnet.assets.WETH,feeTiers),cache=readiness.provenance.provider==='v3 swap readiness cache'?'hit':'miss';if(pools.status==='unavailable')return finish({readinessStatus:'unavailable',cache,factoryGetPoolReached,feeTiersQueried:feeTiers,validPools:[],errorCode:'V3_SWAP_POOL_DISCOVERY_UNAVAILABLE'});const validPools=pools.value.filter(pool=>pool.liquidity>0n&&(pool.token0.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase()||pool.token1.toLowerCase()===robinhoodMainnet.assets.USDG.toLowerCase())).map(pool=>({address:pool.address,fee:pool.fee}));return validPools.length?finish({readinessStatus:'available',cache,factoryGetPoolReached,feeTiersQueried:feeTiers,validPools,errorCode:null}):finish({readinessStatus:'unavailable',cache,factoryGetPoolReached,feeTiersQueried:feeTiers,validPools:[],errorCode:'V3_SWAP_VALID_POOL_UNAVAILABLE'});
 }catch(error){return finish({readinessStatus:'unavailable',cache:'miss',factoryGetPoolReached:false,feeTiersQueried:[],validPools:[],errorCode:error instanceof RpcProviderFailure?'RPC_PROVIDER_FAILURE':isRevertedRpcError(error)?'EVM_REVERT':'V3_SWAP_READINESS_ERROR'});}
}
export const positionManagerAbi=[{type:'function',name:'ownerOf',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'address'}]},{type:'function',name:'positions',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'uint96',name:'nonce'},{type:'address',name:'operator'},{type:'address',name:'token0'},{type:'address',name:'token1'},{type:'uint24',name:'fee'},{type:'int24',name:'tickLower'},{type:'int24',name:'tickUpper'},{type:'uint128',name:'liquidity'},{type:'uint256',name:'feeGrowthInside0LastX128'},{type:'uint256',name:'feeGrowthInside1LastX128'},{type:'uint128',name:'tokensOwed0'},{type:'uint128',name:'tokensOwed1'}]},{type:'function',name:'collect',stateMutability:'nonpayable',inputs:[{type:'tuple',components:[{type:'uint256',name:'tokenId'},{type:'address',name:'recipient'},{type:'uint128',name:'amount0Max'},{type:'uint128',name:'amount1Max'}],name:'params'}],outputs:[{type:'uint256',name:'amount0'},{type:'uint256',name:'amount1'}]},{type:'event',name:'Transfer',inputs:[{indexed:true,name:'from',type:'address'},{indexed:true,name:'to',type:'address'},{indexed:true,name:'tokenId',type:'uint256'}]}] as const;
export type V3Position={tokenId:bigint;owner:Address;operator:Address;token0:Address;token1:Address;fee:number;tickLower:number;tickUpper:number;liquidity:bigint;tokensOwed0:bigint;tokensOwed1:bigint;pool:PoolState};
export async function inspectV3Position(rpc:FallbackRpc,deployments:Availability<VerifiedUniswapV3Deployments>,tokenId:bigint):Promise<Availability<V3Position>>{if(deployments.status==='unavailable')return {status:'unavailable',reason:deployments.reason};return rpc.withClient(async client=>{try{const [owner,p]=await Promise.all([client.readContract({address:deployments.value.positionManager,abi:positionManagerAbi,functionName:'ownerOf',args:[tokenId]}),client.readContract({address:deployments.value.positionManager,abi:positionManagerAbi,functionName:'positions',args:[tokenId]})]);const poolAddress=await client.readContract({address:deployments.value.factory,abi:factoryAbi,functionName:'getPool',args:[p[2],p[3],p[4]]});if(poolAddress===zeroAddress)return {status:'unavailable',reason:'position pool is not registered by official factory'};const pool=await inspectV3Pool(rpc,poolAddress);if(pool.status==='unavailable'||pool.value.factory.toLowerCase()!==deployments.value.factory.toLowerCase())return {status:'unavailable',reason:'position pool failed v3 factory validation'};return {status:'available',value:{tokenId,owner,operator:p[1],token0:p[2],token1:p[3],fee:Number(p[4]),tickLower:Number(p[5]),tickUpper:Number(p[6]),liquidity:p[7],tokensOwed0:p[10],tokensOwed1:p[11],pool:pool.value},provenance:{provider:'rpc:NonfungiblePositionManager',observedAt:new Date().toISOString(),blockNumber:pool.value.blockNumber,confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`position read failed: ${e instanceof Error?e.message:String(e)}`};}})}
/** eth_call only; requests exact collectable token quantities without sending a transaction. */
export async function simulateUnclaimedFees(rpc:FallbackRpc,deployments:Availability<VerifiedUniswapV3Deployments>,position:V3Position,caller:Address):Promise<Availability<{token0:bigint;token1:bigint}>>{if(deployments.status==='unavailable')return {status:'unavailable',reason:deployments.reason};if(caller.toLowerCase()!==position.owner.toLowerCase()&&caller.toLowerCase()!==position.operator.toLowerCase())return {status:'unavailable',reason:'collect simulation caller is neither owner nor approved operator'};return rpc.withClient(async client=>{try{const r=await client.simulateContract({account:caller,address:deployments.value.positionManager,abi:positionManagerAbi,functionName:'collect',args:[{tokenId:position.tokenId,recipient:caller,amount0Max:(2n**128n)-1n,amount1Max:(2n**128n)-1n}]});return {status:'available',value:{token0:r.result[0],token1:r.result[1]},provenance:{provider:'rpc:eth_call collect',observedAt:new Date().toISOString(),confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`collect eth_call failed: ${e instanceof Error?e.message:String(e)}`};}})}
/** Replays ERC-721 Transfer logs and rechecks ownerOf, requiring a caller-selected bounded start block. */
export async function walletV3Positions(rpc:FallbackRpc,deployments:Availability<VerifiedUniswapV3Deployments>,wallet:Address,fromBlock:bigint):Promise<Availability<bigint[]>>{if(deployments.status==='unavailable')return {status:'unavailable',reason:deployments.reason};return rpc.withClient(async client=>{try{const to=await client.getBlockNumber();const logs=await client.getLogs({address:deployments.value.positionManager,event:positionManagerAbi[3],fromBlock,toBlock:to});const candidates=new Set<bigint>();for(const log of logs){if(log.args.to?.toLowerCase()===wallet.toLowerCase()||log.args.from?.toLowerCase()===wallet.toLowerCase())candidates.add(log.args.tokenId!);}const owned:bigint[]=[];for(const id of candidates)try{if((await client.readContract({address:deployments.value.positionManager,abi:positionManagerAbi,functionName:'ownerOf',args:[id]})).toLowerCase()===wallet.toLowerCase())owned.push(id);}catch{/* burned or invalid */}return {status:'available',value:owned,provenance:{provider:'rpc:ERC721 Transfer logs + ownerOf',observedAt:new Date().toISOString(),blockNumber:to,confidence:'verified'}};}catch(e){return {status:'unavailable',reason:`wallet position log scan failed: ${e instanceof Error?e.message:String(e)}`};}})}
export function priceFromSqrtX96(sqrtPriceX96: bigint, token0Decimals: number, token1Decimals: number): number { const ratio = Number(sqrtPriceX96) / 2 ** 96; return ratio * ratio * 10 ** (token0Decimals-token1Decimals); }
export async function blockTimestamp(rpc: FallbackRpc, blockNumber: bigint): Promise<Availability<Date>> { return rpc.withClient(async client => { try { const b=await client.getBlock({blockNumber}); return {status:'available',value:new Date(Number(b.timestamp)*1000),provenance:{provider:'rpc:block',observedAt:new Date().toISOString(),blockNumber,confidence:'verified'}}; } catch { return {status:'unavailable',reason:'block timestamp unavailable'}; } }); }
