import { describe, expect, it } from 'vitest';
import { evaluateDeploymentVerification } from '@funi/core';

const complete={officialRegistryMatch:true,chainIdMatch:true,addressMatch:true,codePresent:true,runtimeCodeHashMatch:true,interfaceProbeMatch:true,relationshipMatch:true,explorerStatus:'VERIFIED' as const,explorerContractMatch:true};

describe('authoritative on-chain deployment verification policy',()=>{
 it('allows complete on-chain verification with matching explorer provenance',()=>{const result=evaluateDeploymentVerification(complete);expect(result.finalVerificationStatus).toBe('VERIFIED_ONCHAIN');expect(result.executionAllowedByDeploymentAudit).toBe(true);expect(result.blockingReasons).toEqual([]);expect(result.warnings).toEqual([]);});
 it.each(['MISMATCH','UNAVAILABLE','RATE_LIMITED','UNKNOWN'] as const)('treats explorer %s as warning-only after complete on-chain verification',explorerStatus=>{const result=evaluateDeploymentVerification({...complete,explorerStatus,explorerContractMatch:false});expect(result.finalVerificationStatus).toBe('VERIFIED_ONCHAIN');expect(result.executionAllowedByDeploymentAudit).toBe(true);expect(result.blockingReasons).toEqual([]);expect(result.warnings[0]).toContain('complete on-chain verification passed');});
 it.each([
  ['chainIdMatch','CHAIN_ID_MISMATCH'],['officialRegistryMatch','OFFICIAL_ADDRESS_MISMATCH'],['addressMatch','OFFICIAL_ADDRESS_MISMATCH'],['codePresent','BYTECODE_MISSING'],['runtimeCodeHashMatch','RUNTIME_CODE_MISMATCH'],['interfaceProbeMatch','INTERFACE_PROBE_FAILED'],['relationshipMatch','CONTRACT_RELATIONSHIP_MISMATCH'],
 ] as const)('fails closed when %s is false', (field,reason)=>{const result=evaluateDeploymentVerification({...complete,[field]:false});expect(result.executionAllowedByDeploymentAudit).toBe(false);expect(result.finalVerificationStatus).toBe('BLOCKED');expect(result.blockingReasons).toContain(reason);});
 it('produces one shared immutable verdict for CLI and Telegram gates',()=>{const verdict=evaluateDeploymentVerification({...complete,explorerStatus:'MISMATCH',explorerContractMatch:false});const cli=verdict.executionAllowedByDeploymentAudit,telegram=verdict.finalVerificationStatus==='VERIFIED_ONCHAIN';expect(cli).toBe(telegram);expect(cli).toBe(true);});
});
