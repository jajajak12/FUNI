import { join } from 'node:path';
import { keccak256, toHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import {
  CHAIN_PROFILES,
  adaptiveLogRead,
  FallbackRpc,
  PROTOCOL_DEPLOYMENTS,
  assertChainIdentity,
  chainConfigurationStatus,
  loadChainDeploymentRegistry,
  loadChainRuntimeConfig,
  protocolDeployment,
  sanitizeSensitiveText,
  v3PoolCreatedEvent,
  type ChainKey,
  type ChainProfile,
  type ChainRuntimeConfig,
  type DeploymentVerificationStatus,
  type ProtocolDeployment,
  type ProtocolKey,
} from '@funi/core';
import { SqliteLedgerRepository } from '@funi/ledger';

export type ChainRuntimeContext={
 readonly profile:ChainProfile;readonly config:ChainRuntimeConfig;readonly deployments:ReadonlyMap<ProtocolKey,ProtocolDeployment>;
 readonly rpc:FallbackRpc;readonly publicReadClient:PublicClient;readonly walletClient:undefined;
 readonly feePolicy:Readonly<{model:ChainProfile['feeModel']}>;readonly confirmationPolicy:Readonly<{receiptConfirmations:number}>;
 readonly tokenMetadataCache:Map<string,unknown>;readonly poolRegistryCache:Map<string,unknown>;
 readonly repository:SqliteLedgerRepository;readonly capabilities:ReadonlyMap<ProtocolKey,ProtocolDeployment['capabilities']>;
 close():void;
};
export type ContextLoadResult={key:ChainKey;chainId:number;status:'AVAILABLE'|'UNAVAILABLE';context?:ChainRuntimeContext;blockerReason?:string};

export type CanonicalDeploymentVerificationEvidence={
 chainId:number;protocol:ProtocolKey;deploymentVersion:number;deploymentRegistryRevision:Hex;providerSetRevision:Hex;
 verifiedBlock:bigint;verifiedAtMs:number;validUntilMs:number;status:DeploymentVerificationStatus;evidenceRevision:Hex;
 requiredContractCodeHashes:Readonly<Record<string,Hex>>;requiredRelationshipHash:Hex;marketPool?:Record<string,unknown>;
 providerCount:number;blockerReason?:string;source:'PERSISTED'|'RUNTIME_VERIFIED';
};

const evidenceJson=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
const hashObject=(value:unknown)=>keccak256(toHex(evidenceJson(value)));
export function deploymentEvidenceValidityMs(profile:ChainProfile){return Math.min(600_000,Math.max(30_000,profile.expectedBlockTimeMs*40));}
export function deploymentRegistryRevision(deployment:ProtocolDeployment){return hashObject({registryVersion:deployment.registryVersion,chainId:deployment.chainId,protocol:deployment.protocol,contracts:Object.entries(deployment.contracts).sort(([a],[b])=>a.localeCompare(b))});}
export function providerSetRevision(rpc:FallbackRpc){return hashObject({chainId:rpc.config.chainId,providers:rpc.config.rpcUrls.map(value=>keccak256(toHex(value)))});}

export function createChainRuntimeContext(input:{key:ChainKey;databasePath:string;env?:NodeJS.ProcessEnv;rpc?:FallbackRpc;registryPath?:string}):ChainRuntimeContext{
 const config=loadChainRuntimeConfig(input.key,input.env);if(!config.enabled)throw new Error('CHAIN_DISABLED');if(!config.available)throw new Error(config.blockerReason??'CHAIN_UNAVAILABLE');
 const profile=config.profile,registry=loadChainDeploymentRegistry(input.registryPath??join(process.cwd(),'config','deployments',`${input.key}.v1.json`)),deployments=new Map<ProtocolKey,ProtocolDeployment>(registry.deployments.map(item=>[item.protocol,item]));
 if(registry.chainId!==profile.chainId||registry.chainKey!==profile.key)throw new Error('RUNTIME_DEPLOYMENT_REGISTRY_CHAIN_MISMATCH');
 const assets=Object.fromEntries([['WRAPPED_NATIVE',profile.wrappedNativeAddress],...profile.quoteTokens.map(item=>[item.symbol,item.address])]);
 const rpc=input.rpc??new FallbackRpc({chainId:profile.chainId,name:profile.displayName,rpcUrls:config.rpcUrls,nativeSymbol:profile.nativeSymbol,explorerUrl:profile.blockExplorerBase,assets},config.rpcUrls,{timeoutMs:8_000,attemptTimeoutMs:8_000});
 if(rpc.config.chainId!==profile.chainId)throw new Error('RUNTIME_RPC_CONFIGURATION_CHAIN_MISMATCH');
 const repository=new SqliteLedgerRepository(input.databasePath);
 return Object.freeze({profile,config,deployments,rpc,publicReadClient:rpc.clients[0]!,walletClient:undefined,feePolicy:Object.freeze({model:profile.feeModel}),confirmationPolicy:Object.freeze({receiptConfirmations:config.confirmations}),tokenMetadataCache:new Map(),poolRegistryCache:new Map(),repository,capabilities:new Map([...deployments].map(([key,value])=>[key,value.capabilities])),close:()=>repository.close()});
}

export function loadIsolatedChainContexts(input:{databasePathFor:(key:ChainKey)=>string;env?:NodeJS.ProcessEnv}){const results:ContextLoadResult[]=[];for(const key of Object.keys(CHAIN_PROFILES) as ChainKey[]){const config=loadChainRuntimeConfig(key,input.env);if(!config.enabled){results.push({key,chainId:config.profile.chainId,status:'UNAVAILABLE',blockerReason:config.blockerReason??'CHAIN_DISABLED'});continue;}try{results.push({key,chainId:config.profile.chainId,status:'AVAILABLE',context:createChainRuntimeContext({key,databasePath:input.databasePathFor(key),env:input.env})});}catch(error){results.push({key,chainId:config.profile.chainId,status:'UNAVAILABLE',blockerReason:sanitizeSensitiveText(error instanceof Error?error.message:'CHAIN_CONTEXT_CREATION_FAILED')});}}return results;}

export async function assertRuntimeProviderIdentity(context:Pick<ChainRuntimeContext,'profile'|'rpc'>){const health=await context.rpc.health();if(health.some(item=>item.healthy))return health;const wrong=health.find(item=>item.chainId!==undefined&&item.chainId!==context.profile.chainId);if(wrong)throw new Error(`WRONG_CHAIN_PROVIDER:${wrong.chainId}:${context.profile.chainId}`);throw new Error('NO_CHAIN_CORRECT_PROVIDER_AVAILABLE');}

export type PublicRpcProbeResult={providerIndex:number;stateReadEligibility:boolean;logEligibility:boolean;minimumSuccessfulLogWindow?:number;failureCategory?:string};
/** Sanitized, bounded public-RPC probe. The log shape is always the verified V3
 * factory plus exact PoolCreated topic and explicit recent block bounds. */
export async function probePublicRpcCapabilities(input:{profile:ChainProfile;rpc:FallbackRpc;protocol:ProtocolKey;smallLogWindow?:bigint}):Promise<PublicRpcProbeResult[]>{
 const deployment=protocolDeployment(input.profile.chainId,input.protocol),factory=deployment.contracts.factory;if(!factory)return input.rpc.clients.map((_,providerIndex)=>({providerIndex,stateReadEligibility:false,logEligibility:false,failureCategory:'DEPLOYMENT_FACTORY_MISSING'}));const results:PublicRpcProbeResult[]=[];
 for(const [providerIndex,client] of input.rpc.clients.entries()){let latest=0n,stateReadEligibility=false,failureCategory:string|undefined;const started=Date.now();try{const chainId=await client.getChainId();if(chainId!==input.profile.chainId){input.rpc.markProviderCapability(providerIndex,'chain_identity','WRONG_CHAIN','PROVIDER_ERROR');results.push({providerIndex,stateReadEligibility:false,logEligibility:false,failureCategory:'WRONG_CHAIN'});continue;}input.rpc.markProviderCapability(providerIndex,'chain_identity','SUPPORTED',undefined,Date.now()-started);const block=await client.getBlock({blockTag:'latest'});latest=block.number;input.rpc.markProviderCapability(providerIndex,'block_read','SUPPORTED');const code=await client.getBytecode({address:factory});if(!code||code==='0x')throw new Error('FACTORY_BYTECODE_MISSING');input.rpc.markProviderCapability(providerIndex,'contract_code','SUPPORTED');await client.readContract({address:factory,abi:factoryAbi,functionName:'feeAmountTickSpacing',args:[500]});input.rpc.markProviderCapability(providerIndex,'eth_call','SUPPORTED');stateReadEligibility=true;}catch(error){failureCategory=sanitizeSensitiveText(error instanceof Error?error.message:'STATE_READ_PROBE_FAILED');results.push({providerIndex,stateReadEligibility:false,logEligibility:false,failureCategory});continue;}
  const single=new FallbackRpc(input.rpc.config,[input.rpc.config.rpcUrls[providerIndex]??'https://provider.invalid'],{clients:[client],attemptTimeoutMs:8_000,cooldownMs:30_000}),one=await adaptiveLogRead({rpc:single,address:factory,event:v3PoolCreatedEvent,fromBlock:latest,toBlock:latest,options:{chunkSize:1n,maxRequests:2,maxRecursiveSplits:0,maxElapsedMs:8_000}});if(one.status==='blocked'){failureCategory=one.failureCategory;input.rpc.markProviderCapability(providerIndex,'logs',one.failureCategory==='METHOD_UNSUPPORTED'?'UNSUPPORTED':'LIMITED',one.failureCategory==='REQUEST_LIMIT'||one.failureCategory==='SPLIT_LIMIT'||one.failureCategory==='ELAPSED_LIMIT'?'PROVIDER_ERROR':one.failureCategory);results.push({providerIndex,stateReadEligibility,logEligibility:false,failureCategory});continue;}
  const window=input.smallLogWindow??100n,from=latest>=window-1n?latest-window+1n:0n,small=await adaptiveLogRead({rpc:single,address:factory,event:v3PoolCreatedEvent,fromBlock:from,toBlock:latest,options:{chunkSize:window,maxRequests:32,maxRecursiveSplits:12,maxElapsedMs:8_000}});if(small.status==='success'){input.rpc.markProviderCapability(providerIndex,'logs','SUPPORTED');results.push({providerIndex,stateReadEligibility,logEligibility:true,minimumSuccessfulLogWindow:Math.min(one.minimumSuccessfulLogWindow,small.minimumSuccessfulLogWindow)});}else{input.rpc.markProviderCapability(providerIndex,'logs','SUPPORTED',small.failureCategory==='REQUEST_LIMIT'||small.failureCategory==='SPLIT_LIMIT'||small.failureCategory==='ELAPSED_LIMIT'?'PROVIDER_ERROR':small.failureCategory);results.push({providerIndex,stateReadEligibility,logEligibility:true,minimumSuccessfulLogWindow:one.minimumSuccessfulLogWindow,failureCategory:small.failureCategory});}
 }
 return results;
}

export function bscReadOnlyRuntimeStatus(input:{deploymentVerification:DeploymentVerificationStatus;providers:PublicRpcProbeResult[]}){const deploymentVerified=input.deploymentVerification==='VERIFIED'||input.deploymentVerification==='PARTIALLY_VERIFIED',state=deploymentVerified&&input.providers.some(item=>item.stateReadEligibility),logs=state&&input.providers.some(item=>item.stateReadEligibility&&item.logEligibility),runtimeState=state?(logs?'BSC_READ_ONLY_FULL':'BSC_READ_ONLY_PARTIAL_LOG_DISCOVERY_BLOCKED'):'BSC_READ_ONLY_BLOCKED',readOnlyMode=state?(logs?'FULL':'PARTIAL'):'BLOCKED',blocker=state&&!logs?'BSC_LOG_DISCOVERY_PROVIDER_UNAVAILABLE':!state?'BSC_STATE_READ_PROVIDER_UNAVAILABLE':undefined;return {runtimeState,readOnlyAvailable:state,readOnlyMode,deploymentVerification:input.deploymentVerification,registryDiscovery:logs,blocker,executionReady:false};}

const factoryAbi=[
 {type:'function',name:'feeAmountTickSpacing',stateMutability:'view',inputs:[{type:'uint24'}],outputs:[{type:'int24'}]},
 {type:'function',name:'getPool',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'uint24'}],outputs:[{type:'address'}]},
] as const;
const erc20DecimalsAbi=[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{type:'uint8'}]}] as const;
const positionManagerRoleAbi=[{type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'WETH9',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},{type:'function',name:'deployer',stateMutability:'view',inputs:[],outputs:[{type:'address'}]}] as const;
const poolAbi=[
 {type:'function',name:'factory',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
 {type:'function',name:'token0',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
 {type:'function',name:'token1',stateMutability:'view',inputs:[],outputs:[{type:'address'}]},
 {type:'function',name:'fee',stateMutability:'view',inputs:[],outputs:[{type:'uint24'}]},
 {type:'function',name:'tickSpacing',stateMutability:'view',inputs:[],outputs:[{type:'int24'}]},
 {type:'function',name:'slot0',stateMutability:'view',inputs:[],outputs:[{type:'uint160'},{type:'int24'},{type:'uint16'},{type:'uint16'},{type:'uint16'},{type:'uint32'},{type:'bool'}]},
 {type:'function',name:'liquidity',stateMutability:'view',inputs:[],outputs:[{type:'uint128'}]},
] as const;
const knownPoolFees=[100,500,2500,3000,10_000] as const;

async function verifyKnownV3Pool(client:PublicClient,profile:ChainProfile,deployment:ProtocolDeployment){
 const factory=deployment.contracts.factory;if(!factory)throw new Error('DEPLOYMENT_FACTORY_MISSING');let pool:Address|undefined,fee:number|undefined,spacing:number|undefined,quote:Address|undefined;
 knownPoolSearch:for(const candidateQuote of profile.quoteTokens.map(item=>item.address))for(const candidateFee of knownPoolFees){const candidate=await client.readContract({address:factory,abi:factoryAbi,functionName:'getPool',args:[profile.wrappedNativeAddress,candidateQuote,candidateFee]});if(candidate===zeroAddress)continue;pool=candidate;fee=candidateFee;quote=candidateQuote;spacing=Number(await client.readContract({address:factory,abi:factoryAbi,functionName:'feeAmountTickSpacing',args:[candidateFee]}));break knownPoolSearch;}
 if(!pool||fee===undefined||!quote||!spacing||spacing<=0)throw new Error('DEPLOYMENT_KNOWN_POOL_NOT_FOUND');
 const [poolFactory,token0,token1,poolFee,poolSpacing,slot0,liquidity,code]=await Promise.all([
  client.readContract({address:pool,abi:poolAbi,functionName:'factory'}),client.readContract({address:pool,abi:poolAbi,functionName:'token0'}),client.readContract({address:pool,abi:poolAbi,functionName:'token1'}),client.readContract({address:pool,abi:poolAbi,functionName:'fee'}),client.readContract({address:pool,abi:poolAbi,functionName:'tickSpacing'}),client.readContract({address:pool,abi:poolAbi,functionName:'slot0'}),client.readContract({address:pool,abi:poolAbi,functionName:'liquidity'}),client.getBytecode({address:pool}),
 ]);
 if(!code||code==='0x')throw new Error('DEPLOYMENT_KNOWN_POOL_BYTECODE_MISSING');if(poolFactory.toLowerCase()!==factory.toLowerCase())throw new Error('DEPLOYMENT_KNOWN_POOL_FACTORY_MISMATCH');
 const expected=[profile.wrappedNativeAddress.toLowerCase(),quote.toLowerCase()].sort(),actual=[token0.toLowerCase(),token1.toLowerCase()];if(actual[0]!==expected[0]||actual[1]!==expected[1])throw new Error('DEPLOYMENT_KNOWN_POOL_TOKEN_ORDER_MISMATCH');
 if(Number(poolFee)!==fee)throw new Error('DEPLOYMENT_KNOWN_POOL_FEE_MISMATCH');if(Number(poolSpacing)!==spacing)throw new Error('DEPLOYMENT_KNOWN_POOL_TICK_SPACING_MISMATCH');if(slot0[0]<=0n||!slot0[6])throw new Error('DEPLOYMENT_KNOWN_POOL_SLOT_STATE_INVALID');if(liquidity<=0n)throw new Error('DEPLOYMENT_KNOWN_POOL_LIQUIDITY_MISSING');
 return {pool,token0,token1,fee,tickSpacing:spacing,sqrtPriceX96:slot0[0],tick:Number(slot0[1]),liquidity,codeHash:keccak256(code)};
}

export async function verifyDeploymentReadOnly(context:Pick<ChainRuntimeContext,'profile'|'rpc'> & Partial<Pick<ChainRuntimeContext,'deployments'>> & {nowMs?:number},protocol:ProtocolKey){
 const deployment=context.deployments?.get(protocol)??protocolDeployment(context.profile.chainId,protocol),providerResults:Array<Record<string,unknown>&{status:'VERIFIED'|'UNVERIFIED'}>=[];
 if(deployment.runtimeVerification.status==='UNSUPPORTED')return {chainId:context.profile.chainId,protocol,registryVersion:deployment.registryVersion,status:'UNSUPPORTED' as const,providers:providerResults,executionSupported:false,blockerReason:deployment.runtimeVerification.blockerReason??deployment.capabilities.blockerReason??'DEPLOYMENT_UNSUPPORTED'};
 for(const [providerIndex,client] of context.rpc.clients.entries())try{
  const providerChainId=await client.getChainId();assertChainIdentity({requestedChainId:context.profile.chainId,providerChainId,deploymentChainId:deployment.chainId});
  context.rpc.markProviderCapability(providerIndex,'chain_identity','SUPPORTED');
  const entries=Object.entries(deployment.contracts).filter((entry):entry is [string,Address]=>Boolean(entry[1])),codes=await Promise.all(entries.map(([,address])=>client.getBytecode({address}))),codeHashes:Record<string,Hex>={};for(const [index,[name]] of entries.entries()){const code=codes[index];if(!code||code==='0x')throw new Error(`DEPLOYMENT_BYTECODE_MISSING:${name}`);codeHashes[name]=keccak256(code);}
  const roleEvidence:Record<string,unknown>={};if(deployment.contracts.wrappedNative){const decimals=Number(await client.readContract({address:deployment.contracts.wrappedNative,abi:erc20DecimalsAbi,functionName:'decimals'}));if(decimals!==context.profile.nativeDecimals)throw new Error('DEPLOYMENT_WRAPPED_NATIVE_DECIMALS_MISMATCH');roleEvidence.wrappedNativeDecimals=decimals;}
  if(deployment.contracts.positionManager&&deployment.contracts.factory&&deployment.contracts.wrappedNative){const [managerFactory,managerWrapped]=await Promise.all([client.readContract({address:deployment.contracts.positionManager,abi:positionManagerRoleAbi,functionName:'factory'}),client.readContract({address:deployment.contracts.positionManager,abi:positionManagerRoleAbi,functionName:'WETH9'})]);if(managerFactory.toLowerCase()!==deployment.contracts.factory.toLowerCase())throw new Error('DEPLOYMENT_POSITION_MANAGER_FACTORY_MISMATCH');if(managerWrapped.toLowerCase()!==deployment.contracts.wrappedNative.toLowerCase())throw new Error('DEPLOYMENT_POSITION_MANAGER_WRAPPED_NATIVE_MISMATCH');roleEvidence.positionManagerFactory=true;roleEvidence.positionManagerWrappedNative=true;if(protocol==='pancakeswap_v3'){const managerDeployer=await client.readContract({address:deployment.contracts.positionManager,abi:positionManagerRoleAbi,functionName:'deployer'});if(!deployment.contracts.poolDeployer||managerDeployer.toLowerCase()!==deployment.contracts.poolDeployer.toLowerCase())throw new Error('DEPLOYMENT_PANCAKE_POOL_DEPLOYER_MISMATCH');roleEvidence.positionManagerPoolDeployer=true;}}
  const knownPool=protocol==='pancakeswap_v3'||protocol==='uniswap_v3'?await verifyKnownV3Pool(client,context.profile,deployment):undefined,block=await client.getBlock({blockTag:'latest'});if(context.profile.chainId===1&&(block.baseFeePerGas===null||block.baseFeePerGas<=0n))throw new Error('DEPLOYMENT_EIP1559_BASE_FEE_EVIDENCE_MISSING');context.rpc.markProviderCapability(providerIndex,'contract_code','SUPPORTED');context.rpc.markProviderCapability(providerIndex,'eth_call','SUPPORTED');context.rpc.markProviderCapability(providerIndex,'block_read','SUPPORTED');
  providerResults.push({providerIndex,status:'VERIFIED',chainId:providerChainId,verifiedBlock:block.number.toString(),verifiedAt:new Date(context.nowMs??Date.now()).toISOString(),codeHashes,roleEvidence,knownPool,baseFeeEvidence:context.profile.chainId===1?{present:true}:undefined});
 }catch(error){const reason=sanitizeSensitiveText(error instanceof Error?error.message:'DEPLOYMENT_VERIFICATION_FAILED');if(/CHAIN_CONTEXT_MISMATCH:providerChainId/.test(reason))context.rpc.markProviderCapability(providerIndex,'chain_identity','WRONG_CHAIN','PROVIDER_ERROR');providerResults.push({providerIndex,status:'UNVERIFIED',reason});}
 const verified=providerResults.filter(item=>item.status==='VERIFIED'),status=verified.length===context.rpc.clients.length?'VERIFIED' as const:verified.length?'PARTIALLY_VERIFIED' as const:'UNVERIFIED' as const;return {chainId:context.profile.chainId,protocol,registryVersion:deployment.registryVersion,status,providers:providerResults,executionSupported:status==='VERIFIED'&&deployment.capabilities.executionSupported,blockerReason:status!=='VERIFIED'?'DEPLOYMENT_RUNTIME_NOT_VERIFIED':deployment.capabilities.executionSupported?undefined:deployment.capabilities.blockerReason};
}

function persistedDeploymentEvidence(repo:SqliteLedgerRepository,chainId:number,protocol:ProtocolKey){
 try{return repo.db.prepare("SELECT payload_json FROM chain_runtime_evidence WHERE chain_id=? AND protocol=? AND evidence_kind='DEPLOYMENT_VERIFICATION'").get(chainId,protocol) as {payload_json:string}|undefined;}catch{return undefined;}
}

function decodeDeploymentEvidence(row:{payload_json:string}|undefined):CanonicalDeploymentVerificationEvidence|undefined{
 if(!row)return undefined;try{const value=JSON.parse(row.payload_json) as Record<string,unknown>;return {...value,verifiedBlock:BigInt(String(value.verifiedBlock))} as CanonicalDeploymentVerificationEvidence;}catch{return undefined;}
}

function persistDeploymentEvidence(repo:SqliteLedgerRepository,evidence:CanonicalDeploymentVerificationEvidence){
 repo.db.prepare("INSERT INTO chain_runtime_evidence(chain_id,protocol,evidence_kind,evidence_revision,deployment_version,provider_set_revision,observed_block,observed_at_ms,valid_until_ms,status,payload_json) VALUES(?,?,'DEPLOYMENT_VERIFICATION',?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,protocol,evidence_kind) DO UPDATE SET evidence_revision=excluded.evidence_revision,deployment_version=excluded.deployment_version,provider_set_revision=excluded.provider_set_revision,observed_block=excluded.observed_block,observed_at_ms=excluded.observed_at_ms,valid_until_ms=excluded.valid_until_ms,status=excluded.status,payload_json=excluded.payload_json").run(evidence.chainId,evidence.protocol,evidence.evidenceRevision,evidence.deploymentVersion,evidence.providerSetRevision,evidence.verifiedBlock.toString(),evidence.verifiedAtMs,evidence.validUntilMs,evidence.status,evidenceJson({...evidence,source:'PERSISTED'}));
}

/** The only guarded-v3 deployment evidence entry point.  Every consumer gets
 * either the still-valid persisted record or a freshly verified replacement. */
export async function canonicalDeploymentVerification(input:{profile:ChainProfile;rpc:FallbackRpc;protocol:ProtocolKey;repo?:SqliteLedgerRepository;nowMs?:number;forceRefresh?:boolean}):Promise<CanonicalDeploymentVerificationEvidence>{
 const nowMs=input.nowMs??Date.now(),deployment=protocolDeployment(input.profile.chainId,input.protocol),registryRevision=deploymentRegistryRevision(deployment),providersRevision=providerSetRevision(input.rpc),prior=decodeDeploymentEvidence(input.repo?persistedDeploymentEvidence(input.repo,input.profile.chainId,input.protocol):undefined);
 if(prior&&!input.forceRefresh&&prior.chainId===input.profile.chainId&&prior.protocol===input.protocol&&prior.deploymentVersion===deployment.registryVersion&&prior.deploymentRegistryRevision===registryRevision&&prior.providerSetRevision===providersRevision&&prior.status==='VERIFIED'&&prior.validUntilMs>=nowMs){
  const identities=await Promise.allSettled(input.rpc.clients.map(client=>client.getChainId())),observed=identities.flatMap(item=>item.status==='fulfilled'?[item.value]:[]);if(observed.length&&observed.every(value=>value===input.profile.chainId))return {...prior,source:'PERSISTED'};
 }
 const runtime=await verifyDeploymentReadOnly({profile:input.profile,rpc:input.rpc,nowMs},input.protocol),verified=runtime.providers.filter(item=>item.status==='VERIFIED'),blocks=verified.map(item=>BigInt(String(item.verifiedBlock))),first=verified[0],codeHashes=(first?.codeHashes??{}) as Record<string,Hex>,relationshipEvidence=verified.map(item=>item.roleEvidence??{}),requiredRelationshipHash=hashObject(relationshipEvidence[0]??{}),consistent=verified.length===runtime.providers.length&&verified.every(item=>evidenceJson(item.codeHashes??{})===evidenceJson(codeHashes)&&hashObject(item.roleEvidence??{})===requiredRelationshipHash),status=runtime.status==='VERIFIED'&&consistent?'VERIFIED' as const:runtime.status==='VERIFIED'?'UNVERIFIED' as const:runtime.status,verifiedBlock=blocks.length?blocks.reduce((a,b)=>a<b?a:b):0n,marketPool=first?.knownPool as Record<string,unknown>|undefined,evidenceRevision=hashObject({chainId:input.profile.chainId,protocol:input.protocol,deploymentVersion:deployment.registryVersion,registryRevision,providersRevision,verifiedBlock,codeHashes,requiredRelationshipHash,status});
 const evidence:CanonicalDeploymentVerificationEvidence={chainId:input.profile.chainId,protocol:input.protocol,deploymentVersion:deployment.registryVersion,deploymentRegistryRevision:registryRevision,providerSetRevision:providersRevision,verifiedBlock,verifiedAtMs:nowMs,validUntilMs:nowMs+deploymentEvidenceValidityMs(input.profile),status,evidenceRevision,requiredContractCodeHashes:codeHashes,requiredRelationshipHash,marketPool,providerCount:verified.length,blockerReason:status==='VERIFIED'?undefined:runtime.blockerReason??(consistent?undefined:'DEPLOYMENT_PROVIDER_EVIDENCE_DISAGREEMENT'),source:'RUNTIME_VERIFIED'};
 if(input.repo)persistDeploymentEvidence(input.repo,evidence);return evidence;
}

export function sanitizedChainsStatus(env:NodeJS.ProcessEnv=process.env){return {chains:chainConfigurationStatus(env),deployments:PROTOCOL_DEPLOYMENTS.map(item=>({registryVersion:item.registryVersion,chainId:item.chainId,chainKey:item.chainKey,protocol:item.protocol,source:item.source,runtimeVerification:item.runtimeVerification.status,capabilities:item.capabilities,contracts:Object.keys(item.contracts)}))};}
