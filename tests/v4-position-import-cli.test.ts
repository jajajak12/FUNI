import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const adoption=readFileSync('apps/cli/src/position-adoption.ts','utf8');
const cli=readFileSync('apps/cli/src/index.ts','utf8');
const importBody=adoption.slice(adoption.indexOf('export async function importKnownV4Position'),adoption.indexOf('async function adoptV3'));

describe('known V4 NFT import command safety boundary',()=>{
 it('keeps preview before every persistence branch and reports incomplete accounting',()=>{
  expect(importBody.indexOf("if(!input.apply)return {status:'PREVIEW'")).toBeLessThan(importBody.indexOf('await adoptV4'));
 expect(importBody).toContain("historicalAccounting:'INCOMPLETE_UNAVAILABLE'");
  expect(importBody).toContain("expectedAccountingStatus:botManaged?'RECEIPT_ACCOUNTED'");
  expect(importBody).toContain('range=v4ImportRangeEvidence({currentTick:state.pool.tick');
  expect(importBody).toContain("historicalAccounting:'INCOMPLETE_UNAVAILABLE'");
  expect(importBody).toContain("action=botManaged?'NO_OP_BOT_MANAGED':adoption?(metadataComplete?'NO_OP_ALREADY_ADOPTED':'METADATA_REPAIRED')");
 });
 it('requires confirmation, fully closed safety, current owner, and preserves bot-managed rows',()=>{
  expect(importBody).toContain("throw new Error('V4_POSITION_IMPORT_OWNER_MISMATCH')");
  expect(importBody).toContain("throw new Error('V4_POSITION_IMPORT_CONFIRMATION_REQUIRED')");
  expect(importBody).toContain("throw new Error('V4_POSITION_IMPORT_SAFETY_CLOSED_REQUIRED')");
  expect(importBody).toContain("if(botManaged||(adoption&&metadataComplete))return {status:'NO_OP'");
  expect(cli).toContain('v4-position-import:${tokenInput}');
  expect(cli).toContain('enqueueTargetedPositionReconciliation');
 });
 it('does not introduce signer, nonce, or broadcast reachability',()=>{
  expect(importBody).not.toMatch(/walletClient|guardedWalletClient|sendTransaction|nonce/i);
  expect(importBody).toContain('signingUsed:false,broadcastUsed:false,mainnetTransactionsSent:0');
  expect(importBody).toContain('persistCurrentV4ValuationMetadata');
});
});
