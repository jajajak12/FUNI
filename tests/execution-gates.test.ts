import { describe,expect,it } from 'vitest';
import { evaluateCanonicalExecutionGates, parseStrictBoolean, readCanonicalExecutionGates } from '../apps/cli/src/execution-gates.js';

describe('canonical execution runtime gates',()=>{
 it('strictly parses explicit true and false spellings',()=>{
  for(const value of ['false','0','no','off',' FALSE '])expect(parseStrictBoolean('EMERGENCY_PAUSE',value)).toBe(false);
  for(const value of ['true','1','yes','on',' TRUE '])expect(parseStrictBoolean('EMERGENCY_PAUSE',value)).toBe(true);
 });
 it('classifies invalid values as CONFIG_INVALID rather than emergency pause',()=>{
  const gates=readCanonicalExecutionGates({env:{EXECUTION_ENABLED:'true',DRY_RUN:'false',EMERGENCY_PAUSE:'definitely'},signerReady:true,chainReady:true,deploymentReady:true});
  const result=evaluateCanonicalExecutionGates('close',gates);
  expect(result.reasons).toContain('CONFIG_INVALID:EMERGENCY_PAUSE');
  expect(result.reasons).not.toContain('EMERGENCY_PAUSE');
 });
 it('allows close to reach its executor when the fresh canonical gates pass',()=>{
  const gates=readCanonicalExecutionGates({env:{EXECUTION_ENABLED:'true',DRY_RUN:'false',EMERGENCY_PAUSE:'false'},signerReady:true,chainReady:true,deploymentReady:true});
  expect(evaluateCanonicalExecutionGates('close',gates)).toMatchObject({verdict:'PASS',reasons:[]});
 });
 it('fails close closed when the fresh emergency pause is true',()=>{
  const gates=readCanonicalExecutionGates({env:{EXECUTION_ENABLED:'true',DRY_RUN:'false',EMERGENCY_PAUSE:'true'},signerReady:true,chainReady:true,deploymentReady:true});
  expect(evaluateCanonicalExecutionGates('close',gates)).toMatchObject({verdict:'BLOCKED',reasons:['EMERGENCY_PAUSE']});
 });
 it('uses fresh execution-time environment rather than a paused preview snapshot',()=>{
  const preview=readCanonicalExecutionGates({env:{EXECUTION_ENABLED:'true',DRY_RUN:'false',EMERGENCY_PAUSE:'true'},signerReady:true,chainReady:true,deploymentReady:true});
  const final=readCanonicalExecutionGates({env:{EXECUTION_ENABLED:'true',DRY_RUN:'false',EMERGENCY_PAUSE:'false'},signerReady:true,chainReady:true,deploymentReady:true});
  expect(evaluateCanonicalExecutionGates('close',preview).verdict).toBe('BLOCKED');
  expect(evaluateCanonicalExecutionGates('close',final).verdict).toBe('PASS');
 });
});
