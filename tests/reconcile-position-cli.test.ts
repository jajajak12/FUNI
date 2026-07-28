import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('reconcile-position CLI command',()=>{
 it('uses the existing targeted queue behind the fully closed safety gate',()=>{
  const source=readFileSync('apps/cli/src/index.ts','utf8'),start=source.indexOf('async function reconcilePositionCommand'),end=source.indexOf('async function main()',start),command=source.slice(start,end);
  expect(command).toContain("cmd!=='reconcile-position'");
  expect(command).toContain('RECONCILE_POSITION_SAFETY_CLOSED_REQUIRED');
  expect(command).toContain('enqueueTargetedPositionReconciliation');
  expect(command).toContain("queueStatus:status");
  expect(command).toContain('safetyVerified:true');
  expect(command).toContain('signingUsed:false');
  expect(command).toContain('broadcastUsed:false');
  expect(command).not.toMatch(/reconcileActivePositions|guardedWalletClient|sendRawTransaction|acquireNonceMutex|INSERT INTO targeted_position_reconciliation_requests/);
 });
 it('rejects malformed position IDs and validates the enrolled position before enqueueing',()=>{
  const source=readFileSync('apps/cli/src/index.ts','utf8'),start=source.indexOf('async function reconcilePositionCommand'),end=source.indexOf('async function main()',start),command=source.slice(start,end);
  expect(command).toContain('/^(v4|live):([1-9][0-9]*)$/');
  expect(command).toContain('RECONCILE_POSITION_ID_INVALID');
  expect(command).toContain('RECONCILE_POSITION_NOT_FOUND');
 });
});
