import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { robinhoodMainnet } from '@robin/core';
/** Postdates the known AI/USDG and hooked WETH/AI Initialize events while remaining immutable. */
export const PINNED_FORK_BLOCK=17_400_000n;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function unusedForkPort(){return new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const a=server.address();server.close(error=>error?reject(error):!a||typeof a==='string'?reject(new Error('port unavailable')):resolve(a.port));});});}
export async function startPinnedFork(input:{gasPriceWei?:bigint}={}){const dir=mkdtempSync(join(tmpdir(),'robin-guarded-canary-')),logPath=join(dir,'anvil.log'),fd=openSync(logPath,'a'),port=await unusedForkPort(),url=`http://127.0.0.1:${port}`,anvil=process.env.ANVIL_BIN??'/usr/local/bin/anvil',args=['--fork-url',process.env.ROBINHOOD_FORK_RPC_URL??robinhoodMainnet.rpcUrls[0],'--fork-block-number',PINNED_FORK_BLOCK.toString(),'--host','127.0.0.1','--port',String(port),...(input.gasPriceWei!==undefined?['--gas-price',input.gasPriceWei.toString()]:[])],child=spawn(anvil,args,{stdio:['ignore',fd,fd]}),client=createPublicClient({transport:http(url,{timeout:20_000})});let last='not ready';for(let i=0;i<80;i++){try{if(await client.getChainId()!==4663)throw new Error('wrong chain');if(await client.getBlockNumber()!==PINNED_FORK_BLOCK)throw new Error('wrong block');return {dir,logPath,url,client,async stop(){if(!child.killed){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(5_000).then(()=>child.kill('SIGKILL'))]);}closeSync(fd);}};}catch(e){last=e instanceof Error?e.message:String(e);await sleep(250);}}child.kill('SIGKILL');closeSync(fd);throw new Error(`fork startup failed: ${last}`);}
