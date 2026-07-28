import { z } from 'zod';

const TRUE_VALUES=new Set(['true','1','yes','on']);
const FALSE_VALUES=new Set(['false','0','no','off']);

export class RuntimeGateConfigError extends Error{
 constructor(public readonly key:string,public readonly value:unknown){super(`CONFIG_INVALID:${key}`);this.name='RuntimeGateConfigError';}
}

export function parseStrictBoolean(key:string,value:unknown,fallback?:boolean):boolean{
 if(value===undefined||value===null||value===''){
  if(fallback!==undefined)return fallback;
  throw new RuntimeGateConfigError(key,value);
 }
 if(typeof value==='boolean')return value;
 const normalized=String(value).trim().toLowerCase();
 if(TRUE_VALUES.has(normalized))return true;
 if(FALSE_VALUES.has(normalized))return false;
 throw new RuntimeGateConfigError(key,value);
}

export const strictBooleanSchema=(key:string,fallback:boolean)=>z.preprocess(
 value=>value===undefined?fallback:parseStrictBoolean(key,value),z.boolean(),
);

export type ExecutionOperation='open'|'close'|'collect'|'burn'|'rebalance'|'compound';
export type CanonicalExecutionGates={
 executionEnabled:boolean;dryRun:boolean;emergencyPause:boolean;
 signerReady:boolean;chainReady:boolean;deploymentReady:boolean;manualPause:boolean;
 configSource:string;configValid:boolean;configErrors:string[];
};

export function readCanonicalExecutionGates(input:{
 env?:NodeJS.ProcessEnv;signerReady:boolean;chainReady:boolean;deploymentReady:boolean;
 manualPause?:boolean;configSource?:string;
}):CanonicalExecutionGates{
 const env=input.env??process.env,errors:string[]=[];
 const read=(key:string,fallback:boolean)=>{try{return parseStrictBoolean(key,env[key],fallback);}catch(error){errors.push(error instanceof Error?error.message:`CONFIG_INVALID:${key}`);return fallback;}};
 return {
  executionEnabled:read('EXECUTION_ENABLED',false),dryRun:read('DRY_RUN',true),emergencyPause:read('EMERGENCY_PAUSE',true),
  signerReady:input.signerReady,chainReady:input.chainReady,deploymentReady:input.deploymentReady,manualPause:input.manualPause===true,
  configSource:input.configSource??'process.env',configValid:errors.length===0,configErrors:errors,
 };
}

export function evaluateCanonicalExecutionGates(operation:ExecutionOperation,gates:CanonicalExecutionGates){
 const reasons=[...gates.configErrors];
 if(!gates.executionEnabled)reasons.push('EXECUTION_DISABLED');
 if(gates.dryRun)reasons.push('DRY_RUN_ENABLED');
 if(gates.configValid&&gates.emergencyPause)reasons.push('EMERGENCY_PAUSE');
 if(gates.manualPause)reasons.push('MANUAL_PAUSE');
 if(!gates.signerReady)reasons.push('PROTECTED_SIGNER_REQUIRED');
 if(!gates.chainReady)reasons.push('WRONG_CHAIN');
 if(!gates.deploymentReady)reasons.push('V4_DEPLOYMENT_UNVERIFIED');
 return {event:'execution_gate_evaluated' as const,operation,...gates,verdict:reasons.length?'BLOCKED' as const:'PASS' as const,reasons};
}
