import { describe, expect, it } from 'vitest';
import { classifyV4RangeState } from '@funi/v4';
import { v4ImportRangeEvidence } from '../apps/cli/src/position-adoption.js';

describe('V4 canonical range state',()=>{
 it.each([
  [-401000,-400050,-391160,'below_range'],
  [-400050,-400050,-391160,'in_range'],
  [-395000,-400050,-391160,'in_range'],
  [-391160,-400050,-391160,'above_range'],
  [-390946,-400050,-391160,'above_range'],
 ] as const)('classifies tick %i for [%i, %i)',(tick,lower,upper,expected)=>expect(classifyV4RangeState(tick,lower,upper)).toBe(expected));
 it('keeps zero-liquidity geometry and token 362228-shaped evidence above range',()=>{
  const preview=v4ImportRangeEvidence({currentTick:-390946,tickLower:-400050,tickUpper:-391160,poolBlock:123n,rangeState:classifyV4RangeState(-390946,-400050,-391160)});
  expect(preview).toEqual({currentTick:-390946,tickLower:-400050,tickUpper:-391160,poolBlock:'123',rangeState:'above_range'});
 });
 it('fails closed if the preview formatter receives contradictory inspection evidence',()=>{
  expect(()=>v4ImportRangeEvidence({currentTick:-390946,tickLower:-400050,tickUpper:-391160,poolBlock:123n,rangeState:'in_range'})).toThrow('V4_POSITION_IMPORT_RANGE_EVIDENCE_INCONSISTENT');
 });
});
