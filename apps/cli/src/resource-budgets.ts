export const ALCHEMY_CU={eth_blockNumber:10,eth_call:26} as const;
export function projectedIdleAlchemyUsage(input:{
 activePositions:number;activePools?:number;stateTtlMs?:number;activeOwnershipTtlMs?:number;batchLimit?:number;days?:number;
}){
 const positions=Math.max(0,Math.floor(input.activePositions)),pools=Math.max(0,Math.floor(input.activePools??positions)),stateTtl=input.stateTtlMs??120_000,ownershipTtl=input.activeOwnershipTtlMs??300_000,batchLimit=input.batchLimit??16,days=input.days??1;
 const poolBatches=pools?Math.ceil(pools/batchLimit):0,ownershipBatches=positions?Math.ceil(positions/batchLimit):0,poolRounds=pools?Math.floor(86_400_000/stateTtl):0,ownershipRounds=positions?Math.floor(86_400_000/ownershipTtl):0;
 const blockNumberRequests=(poolRounds*poolBatches+ownershipRounds*ownershipBatches)*days,ethCallRequests=blockNumberRequests,poolMulticallMembers=poolRounds*pools*2*days,ownershipMulticallMembers=ownershipRounds*positions*5*days,totalRequests=blockNumberRequests+ethCallRequests,computeUnits=blockNumberRequests*ALCHEMY_CU.eth_blockNumber+ethCallRequests*ALCHEMY_CU.eth_call;
 return {activePositions:positions,activePools:pools,days,poolRounds,ownershipRounds,blockNumberRequests,ethCallRequests,poolMulticallMembers,ownershipMulticallMembers,totalRequests,computeUnits,monthlyComputeUnits:days===1?computeUnits*30:undefined,assumptions:{batchLimit,stateTtlMs:stateTtl,activeOwnershipTtlMs:ownershipTtl,ethBlockNumberCu:ALCHEMY_CU.eth_blockNumber,ethCallCu:ALCHEMY_CU.eth_call,multicallIsOneEthCallRequest:true}};
}
