import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, encodeFunctionResult, getAddress, multicall3Abi } from 'viem';
import { FallbackRpc, RH_MAINNET, ROBINHOOD_MULTICALL3, robinhoodMainnet } from '@funi/core';

const balanceOfAbi=[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}] as const;
const token=getAddress('0x0000000000000000000000000000000000000001');
const owner=getAddress('0x0000000000000000000000000000000000000002');

describe('Robinhood canonical Multicall3 chain metadata',()=>{
 it('exposes the canonical deployment without changing chain identity or network metadata',()=>{
  const rpc=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://example.invalid']});
  expect(robinhoodMainnet).toMatchObject({chainId:4663,name:'Robinhood Chain',nativeSymbol:'ETH',rpcUrls:['https://rpc.mainnet.chain.robinhood.com'],explorerUrl:'https://robinhoodchain.blockscout.com'});
  expect(RH_MAINNET).toBe(4663);
  expect(robinhoodMainnet.contracts?.multicall3?.address).toBe(ROBINHOOD_MULTICALL3);
  expect(ROBINHOOD_MULTICALL3).toBe(getAddress('0xcA11bde05977b3631167028862be2a173976CA11'));
  expect(rpc.clients[0]?.chain).toMatchObject({id:4663,contracts:{multicall3:{address:ROBINHOOD_MULTICALL3}}});
 });

 it('lets generic viem multicall resolve Multicall3 from the canonical chain config',async()=>{
  const configured=new FallbackRpc({...robinhoodMainnet,rpcUrls:['https://example.invalid']}),requests:Array<{method:string;params?:unknown}>=[],memberResult=encodeFunctionResult({abi:balanceOfAbi,functionName:'balanceOf',result:7n}),aggregateResult=encodeFunctionResult({abi:multicall3Abi,functionName:'aggregate3',result:[{success:true,returnData:memberResult}]}),client=createPublicClient({
   chain:configured.clients[0]!.chain!,
   transport:custom({request:async request=>{requests.push(request);if(request.method!=='eth_call')throw new Error(`unexpected method ${request.method}`);return aggregateResult;}}),
  });
  await expect(client.multicall({allowFailure:true,contracts:[{address:token,abi:balanceOfAbi,functionName:'balanceOf',args:[owner]}]})).resolves.toEqual([{status:'success',result:7n}]);
  expect(requests).toHaveLength(1);
  expect((requests[0]!.params as [{to:string}])[0].to).toBe(ROBINHOOD_MULTICALL3);
 });
});
