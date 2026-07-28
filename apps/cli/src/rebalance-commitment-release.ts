/** Append-only operator abandonment evidence.  It never changes workflow history. */
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteLedgerRepository } from '@robin/ledger';
import type { FallbackRpc } from '@robin/core';
import { rebalanceExactHashEvidence } from './rebalance-transaction.js';
import type { Address, Hash, PublicClient } from 'viem';
import { positionManagerAbi, V4_ROBINHOOD_DEPLOYMENTS } from '@robin/v4';

export const PERMANENT_OPERATOR_ABANDONMENT='PERMANENT_OPERATOR_ABANDONMENT' as const;
export const RELEASED_ERROR='REBALANCE_COMMITMENT_PERMANENTLY_RELEASED' as const;
type Row=Record<string,unknown>;
const stable=(value:unknown):string=>{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
 return `{${Object.keys(value as Row).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Row)[key])}`).join(',')}}`;
};
const hash=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
const parse=(value:unknown)=>{try{return JSON.parse(String(value??'{}'));}catch{throw new Error('REBALANCE_COMMITMENT_RELEASE_EVIDENCE_MALFORMED');}};
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;

/** Same persisted workflow commitment semantics used by the aggregate. */
export function canonicalWorkflowCommitment(row:Row,oldIncluded=false,replacementIncluded=false){
 const execution=parse(row.execution_json),preview=parse(row.preview_json),allocation=execution.fundingAllocation??{};
 const topup=number(allocation.actualTopUpUsd??row.approved_topup_usd??preview.plan?.requiredTopUpUsd),reopen=number(allocation.actualReopenUsd??preview.plan?.actualReopenUsd);
 if(replacementIncluded)return 0;
 return oldIncluded?topup:(reopen!==null&&reopen>0?reopen:null);
}
function rows(repo:SqliteLedgerRepository,sql:string,workflowId:string){return repo.db.prepare(sql).all(workflowId) as Row[];}
export function rebalanceCommitmentReleaseEvidence(repo:SqliteLedgerRepository,workflowId:string,preparedProof?:unknown){
 const workflow=repo.db.prepare('SELECT * FROM rebalance_workflows WHERE id=?').get(workflowId) as Row|undefined;if(!workflow)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');
 const old=String(workflow.old_position_id),token=old.startsWith('v4:')?old.slice(3):'';
 const position=token?repo.v4Position(token):undefined;if(!position)throw new Error('REBALANCE_COMMITMENT_RELEASE_OLD_POSITION_UNAVAILABLE');
 const lineage=repo.db.prepare('SELECT * FROM rebalance_lineages WHERE id=?').get(String(workflow.lineage_id)) as Row|undefined;if(!lineage)throw new Error('REBALANCE_LINEAGE_NOT_FOUND');
 const commitment=canonicalWorkflowCommitment(workflow,false,false);if(commitment===null)throw new Error('REBALANCE_COMMITMENT_RELEASE_AMOUNT_UNAVAILABLE');
 const tx=rows(repo,'SELECT semantic_stage,attempt,status,nonce,tx_hash,failure_reason FROM rebalance_transactions WHERE workflow_id=? ORDER BY semantic_stage,attempt,tx_hash',workflowId);
 const receipts=rows(repo,'SELECT stage,tx_hash,receipt_json,confirmed_at FROM rebalance_receipts WHERE workflow_id=? ORDER BY stage,tx_hash',workflowId);
 const accounting=rows(repo,'SELECT id,kind,token_address,amount_raw,usd_value,price_source,price_block,observed_at,provenance_json FROM rebalance_accounting_events WHERE workflow_id=? ORDER BY id',workflowId);
 const evidence={workflowId,state:String(workflow.state),revision:Number(workflow.revision),oldPositionId:old,replacementPositionId:workflow.replacement_position_id??null,lineageId:String(workflow.lineage_id),mode:String(workflow.mode),approvedTopUpUsd:workflow.approved_topup_usd??null,preview:{plan:parse(workflow.preview_json).plan??null},transactions:tx,receipts,accounting,oldPosition:{status:String(position.status),liquidityRaw:String(position.liquidity_raw)},sourceWalletAddress:String(position.owner).toLowerCase(),derivedCommitmentUsd:commitment,protocol:String(lineage.protocol_version),preparedReleaseProof:preparedProof??null};
 return {workflow,position,evidence,fingerprint:hash(evidence),releasedCommitmentUsd:commitment};
}
export function rebalanceCommitmentReleaseMarkerValid(repo:SqliteLedgerRepository,workflowId:string){
 const marker=repo.db.prepare('SELECT * FROM rebalance_commitment_releases WHERE workflow_id=?').get(workflowId) as Row|undefined;if(!marker)return;
 try{const saved=parse(marker.evidence_json),current=rebalanceCommitmentReleaseEvidence(repo,workflowId,(saved as Row).preparedReleaseProof??null);if(String(marker.release_kind)!==PERMANENT_OPERATOR_ABANDONMENT||String(marker.evidence_fingerprint)!==current.fingerprint||String(marker.evidence_json)!==stable(current.evidence)||Number(marker.released_commitment_usd)!==current.releasedCommitmentUsd||String(marker.old_position_id)!==String(current.workflow.old_position_id)||String(marker.lineage_id)!==String(current.workflow.lineage_id)||String(marker.source_wallet_address).toLowerCase()!==String(current.evidence.sourceWalletAddress))throw new Error('invalid');return marker;}catch{throw new Error('BOT_MANAGED_EXPOSURE_RELEASE_MARKER_INVALID');}
}
export function assertRebalanceCommitmentNotPermanentlyReleased(repo:SqliteLedgerRepository,workflowId:string){
 const marker=rebalanceCommitmentReleaseMarkerValid(repo,workflowId);if(!marker)return;
 throw new Error(RELEASED_ERROR);
}
export function releaseConfirmationToken(input:{workflowId:string;fingerprint:string;releasedCommitmentUsd:number;expiresAt:number}){return Buffer.from(JSON.stringify({...input,releaseKind:PERMANENT_OPERATOR_ABANDONMENT})).toString('base64url');}
export function verifyReleaseConfirmationToken(token:string,input:{workflowId:string;fingerprint:string;releasedCommitmentUsd:number;now?:number}){try{const value=JSON.parse(Buffer.from(token,'base64url').toString('utf8')) as Row;return value.workflowId===input.workflowId&&value.fingerprint===input.fingerprint&&value.releaseKind===PERMANENT_OPERATOR_ABANDONMENT&&Number(value.releasedCommitmentUsd)===input.releasedCommitmentUsd&&Number(value.expiresAt)>(input.now??Date.now());}catch{return false;}}
export function insertRebalanceCommitmentRelease(repo:SqliteLedgerRepository,input:{workflowId:string;operatorActor:string;operatorReason:string;current?:ReturnType<typeof rebalanceCommitmentReleaseEvidence>}){
 const current=input.current??rebalanceCommitmentReleaseEvidence(repo,input.workflowId),w=current.workflow;
 if(repo.db.prepare('SELECT 1 FROM rebalance_commitment_releases WHERE workflow_id=?').get(input.workflowId))throw new Error('REBALANCE_COMMITMENT_RELEASE_ALREADY_EXISTS');
 const evidence=stable(current.evidence),at=new Date().toISOString();repo.db.prepare('INSERT INTO rebalance_commitment_releases(id,workflow_id,release_kind,old_position_id,lineage_id,source_wallet_address,workflow_state_at_release,workflow_revision_at_release,released_commitment_usd,evidence_fingerprint,operator_actor,operator_reason,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),input.workflowId,PERMANENT_OPERATOR_ABANDONMENT,String(w.old_position_id),String(w.lineage_id),String(current.evidence.sourceWalletAddress),String(w.state),Number(w.revision),current.releasedCommitmentUsd,current.fingerprint,input.operatorActor,input.operatorReason,evidence,at);
 return repo.db.prepare('SELECT * FROM rebalance_commitment_releases WHERE workflow_id=?').get(input.workflowId) as Row;
}
function validStoredHash(value:unknown):value is Hash{return typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value);}
function validStoredNonce(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
async function preparedReleaseProof(repo:SqliteLedgerRepository,workflowId:string,wallet:Address,rpc:FallbackRpc){
 const prepared=rows(repo,"SELECT semantic_stage,attempt,status,nonce,tx_hash,submitted_at,confirmed_at FROM rebalance_transactions WHERE workflow_id=? AND status='PREPARED' ORDER BY semantic_stage,attempt,tx_hash",workflowId);
 const unresolved=rows(repo,"SELECT semantic_stage,attempt,status,nonce,tx_hash FROM rebalance_transactions WHERE workflow_id=? AND status='SUBMITTED' ORDER BY semantic_stage,attempt,tx_hash",workflowId);if(unresolved.length)throw new Error('REBALANCE_COMMITMENT_RELEASE_PREPARED_TRANSACTION_UNPROVEN');
 const proof=[] as Row[];
 for(const row of prepared){
  if(row.submitted_at!==null||row.confirmed_at!==null||!validStoredNonce(row.nonce)||!validStoredHash(row.tx_hash))throw new Error('REBALANCE_COMMITMENT_RELEASE_PREPARED_TRANSACTION_UNPROVEN');
  const nonce=row.nonce as number,evidence=await rebalanceExactHashEvidence(rpc,wallet,row.tx_hash,nonce);
  if(evidence.kind!=='ABSENT'||evidence.latestNonce!==evidence.pendingNonce||evidence.latestNonce<=nonce)throw new Error('REBALANCE_COMMITMENT_RELEASE_PREPARED_TRANSACTION_UNPROVEN');
  proof.push({semanticStage:String(row.semantic_stage),nonce,exactHashLookup:'ABSENT',receiptLookup:'ABSENT',latestNonce:evidence.latestNonce,pendingNonce:evidence.pendingNonce,proofBlock:null,proofTimestamp:null,classification:'PREPARED_UNSUBMITTED_NONCE_EXHAUSTED'});
 }
 return proof;
}
export async function assertPermanentReleaseEligibility(repo:SqliteLedgerRepository,workflowId:string,rpc:FallbackRpc){
 const base=rebalanceCommitmentReleaseEvidence(repo,workflowId),w=base.workflow,p=base.position;
 if(String(w.state)!=='FAILED_RECOVERABLE'||w.replacement_position_id!==null)throw new Error('REBALANCE_COMMITMENT_RELEASE_WORKFLOW_INELIGIBLE');
 if(!['burned','closed'].includes(String(p.status))||BigInt(String(p.liquidity_raw))!==0n)throw new Error('REBALANCE_COMMITMENT_RELEASE_OLD_POSITION_NOT_TERMINAL');
 if(repo.db.prepare('SELECT 1 FROM nonce_mutex LIMIT 1').get())throw new Error('REBALANCE_COMMITMENT_RELEASE_NONCE_MUTEX_HELD');
 const unsafe=repo.db.prepare("SELECT 1 FROM rebalance_transactions WHERE workflow_id=? AND status IN ('SUBMITTED') LIMIT 1").get(workflowId);if(unsafe)throw new Error('REBALANCE_COMMITMENT_RELEASE_AMBIGUOUS_TRANSACTION');
 const proof=await preparedReleaseProof(repo,workflowId,String(base.evidence.sourceWalletAddress) as Address,rpc);
 return rebalanceCommitmentReleaseEvidence(repo,workflowId,proof.length?proof:null);
}

type ClosedNoReplacementPreview={
 workflowId:string;oldPositionId:string;tokenId:string;journalFingerprint:string;
 close:{transactionRowId:string;exactHash:string;nonce:number;receiptBlock:number};
 burn:{transactionRowId:string;exactHash:string;nonce:number;receiptBlock:number;lifecycleIntentId:string};
 abandonedAttempt:{transactionRowId:string;semanticStage:string;exactHash:string;nonce:number;latestNonce:number;pendingNonce:number;classification:'SIGNED_HASH_ABSENT_NONCE_AVAILABLE'};
 burnedProof:{classification:'OWNER_OF_NOT_MINTED_ALL_PROVIDERS';providerCount:number};
 proposedRowChanges:string[];resultingWorkflowCheckpoint:'PERMANENTLY_NON_RESUMABLE_CLOSED_NO_REPLACEMENT';
 alreadyTerminalized?:boolean;
};
function confirmedReceiptBlock(row:Row,stage:string){
 if(String(row.status)!=='CONFIRMED'||!validStoredHash(row.tx_hash)||row.receipt_json===null)throw new Error(`REBALANCE_CLOSED_NO_REPLACEMENT_${stage}_UNPROVEN`);
 let receipt:Row;try{receipt=parse(row.receipt_json) as Row;}catch{throw new Error(`REBALANCE_CLOSED_NO_REPLACEMENT_${stage}_UNPROVEN`);}
 if(receipt.status!=='success'||String(receipt.transactionHash).toLowerCase()!==String(row.tx_hash).toLowerCase()||!/^\d+$/.test(String(receipt.blockNumber)))throw new Error(`REBALANCE_CLOSED_NO_REPLACEMENT_${stage}_UNPROVEN`);
 return Number(receipt.blockNumber);
}
function closedNoReplacementJournal(repo:SqliteLedgerRepository,workflowId:string){
 const workflow=repo.db.prepare('SELECT * FROM rebalance_workflows WHERE id=?').get(workflowId) as Row|undefined;if(!workflow)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');
 const oldPositionId=String(workflow.old_position_id),tokenId=oldPositionId.replace(/^v4:/,'');if(oldPositionId===tokenId)throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_V4_REQUIRED');
 const position=repo.v4Position(tokenId);if(!position)throw new Error('REBALANCE_COMMITMENT_RELEASE_OLD_POSITION_UNAVAILABLE');
 const transactions=rows(repo,'SELECT * FROM rebalance_transactions WHERE workflow_id=? ORDER BY created_at,id',workflowId),receipts=rows(repo,'SELECT * FROM rebalance_receipts WHERE workflow_id=? ORDER BY stage,tx_hash',workflowId);
 const lifecycle=repo.db.prepare('SELECT * FROM v4_lifecycle_intents WHERE token_id=? ORDER BY created_at,id').all(tokenId) as Row[];
 const lifecycleReceipts=repo.db.prepare('SELECT r.* FROM v4_lifecycle_receipts r JOIN v4_lifecycle_intents i ON i.id=r.intent_id WHERE i.token_id=? ORDER BY r.tx_hash').all(tokenId) as Row[];
 const accounting=rows(repo,'SELECT * FROM rebalance_accounting_events WHERE workflow_id=? ORDER BY id',workflowId);
 return {workflow,oldPositionId,tokenId,position,transactions,receipts,lifecycle,lifecycleReceipts,accounting,fingerprint:hash({workflow,position,transactions,receipts,lifecycle,lifecycleReceipts,accounting})};
}
function notMinted(error:unknown){return /NOT_MINTED|not minted|nonexistent|invalid token|owner query|revert/i.test(error instanceof Error?error.message:String(error));}
async function exactBurnedProof(rpc:FallbackRpc,tokenId:bigint){
 const clients=(rpc as unknown as {clients?:PublicClient[]}).clients;
 const probe=async(client:PublicClient)=>{try{await client.readContract({address:V4_ROBINHOOD_DEPLOYMENTS.positionManager,abi:positionManagerAbi,functionName:'ownerOf',args:[tokenId]});return 'EXISTS' as const;}catch(error){return notMinted(error)?'NOT_MINTED' as const:'AMBIGUOUS' as const;}};
 const observations=clients?.length?await Promise.all(clients.map(probe)):[await rpc.withClient(probe,{stage:'closed_no_replacement_terminalization',method:'PositionManager.ownerOf'})];
 if(!observations.length||observations.some(value=>value!=='NOT_MINTED'))throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_BURN_UNPROVEN');
 return {classification:'OWNER_OF_NOT_MINTED_ALL_PROVIDERS' as const,providerCount:observations.length};
}
/** Explicit incident-recovery path for a fully confirmed close+burn where the
 * only later signed attempt is proven absent and its nonce remains available.
 * This is deliberately separate from the stricter passive commitment release. */
export async function previewClosedNoReplacementTerminalization(repo:SqliteLedgerRepository,rpc:FallbackRpc,wallet:Address,workflowId:string):Promise<ClosedNoReplacementPreview>{
 const journal=closedNoReplacementJournal(repo,workflowId),w=journal.workflow,p=journal.position;
 if(rebalanceCommitmentReleaseMarkerValid(repo,workflowId))return {workflowId,oldPositionId:journal.oldPositionId,tokenId:journal.tokenId,journalFingerprint:journal.fingerprint,close:{} as never,burn:{} as never,abandonedAttempt:{} as never,burnedProof:{classification:'OWNER_OF_NOT_MINTED_ALL_PROVIDERS',providerCount:0},proposedRowChanges:[],resultingWorkflowCheckpoint:'PERMANENTLY_NON_RESUMABLE_CLOSED_NO_REPLACEMENT',alreadyTerminalized:true};
 if(String(w.state)!=='FAILED_RECOVERABLE'||w.replacement_position_id!==null||!['closed','burned'].includes(String(p.status))||BigInt(String(p.liquidity_raw))!==0n||String(p.owner).toLowerCase()!==wallet.toLowerCase())throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_SHAPE_INVALID');
 if(repo.db.prepare('SELECT 1 FROM nonce_mutex LIMIT 1').get())throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_NONCE_MUTEX_HELD');
 const close=journal.transactions.filter(row=>row.semantic_stage==='CLOSE_FULL'&&row.status==='CONFIRMED'),burn=journal.transactions.filter(row=>row.semantic_stage==='CLOSE_BURN'&&row.status==='CONFIRMED'),unresolved=journal.transactions.filter(row=>row.status==='PREPARED'||row.status==='SUBMITTED');
 if(close.length!==1||burn.length!==1||unresolved.length!==1||unresolved[0]!.status!=='PREPARED')throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_JOURNAL_INVALID');
 const closeRow=close[0]!,burnRow=burn[0]!,attempt=unresolved[0]!,closeBlock=confirmedReceiptBlock(closeRow,'CLOSE_FULL'),burnBlock=confirmedReceiptBlock(burnRow,'CLOSE_BURN');
 if(attempt.submitted_at!==null||attempt.confirmed_at!==null||!validStoredNonce(attempt.nonce)||!validStoredHash(attempt.tx_hash))throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_ATTEMPT_UNPROVEN');
 const burnIntent=journal.lifecycle.find(row=>row.action==='burn'&&String(row.tx_hash).toLowerCase()===String(burnRow.tx_hash).toLowerCase());
 if(!burnIntent||!journal.lifecycleReceipts.some(row=>String(row.intent_id)===String(burnIntent.id)&&String(row.tx_hash).toLowerCase()===String(burnRow.tx_hash).toLowerCase()))throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_BURN_JOURNAL_UNPROVEN');
 const [closeEvidence,burnEvidence,attemptEvidence,burnedProof]=await Promise.all([rebalanceExactHashEvidence(rpc,wallet,closeRow.tx_hash as Hash,Number(closeRow.nonce)),rebalanceExactHashEvidence(rpc,wallet,burnRow.tx_hash as Hash,Number(burnRow.nonce)),rebalanceExactHashEvidence(rpc,wallet,attempt.tx_hash as Hash,Number(attempt.nonce)),exactBurnedProof(rpc,BigInt(journal.tokenId))]);
 if(closeEvidence.kind!=='RECEIPT'||closeEvidence.receipt.status!=='success'||Number(closeEvidence.receipt.blockNumber)!==closeBlock)throw new Error(closeEvidence.kind==='INCONCLUSIVE'?`REBALANCE_CLOSED_NO_REPLACEMENT_CLOSE_FULL_AMBIGUOUS:${closeEvidence.reason}`:'REBALANCE_CLOSED_NO_REPLACEMENT_CLOSE_FULL_UNPROVEN');
 if(burnEvidence.kind!=='RECEIPT'||burnEvidence.receipt.status!=='success'||Number(burnEvidence.receipt.blockNumber)!==burnBlock)throw new Error(burnEvidence.kind==='INCONCLUSIVE'?`REBALANCE_CLOSED_NO_REPLACEMENT_CLOSE_BURN_AMBIGUOUS:${burnEvidence.reason}`:'REBALANCE_CLOSED_NO_REPLACEMENT_CLOSE_BURN_UNPROVEN');
 if(attemptEvidence.kind!=='ABSENT'||attemptEvidence.latestNonce!==Number(attempt.nonce)||attemptEvidence.pendingNonce!==Number(attempt.nonce))throw new Error(attemptEvidence.kind==='INCONCLUSIVE'?`REBALANCE_CLOSED_NO_REPLACEMENT_ATTEMPT_AMBIGUOUS:${attemptEvidence.reason}`:'REBALANCE_CLOSED_NO_REPLACEMENT_ATTEMPT_UNPROVEN');
 return {workflowId,oldPositionId:journal.oldPositionId,tokenId:journal.tokenId,journalFingerprint:journal.fingerprint,close:{transactionRowId:String(closeRow.id),exactHash:String(closeRow.tx_hash),nonce:Number(closeRow.nonce),receiptBlock:closeBlock},burn:{transactionRowId:String(burnRow.id),exactHash:String(burnRow.tx_hash),nonce:Number(burnRow.nonce),receiptBlock:burnBlock,lifecycleIntentId:String(burnIntent.id)},abandonedAttempt:{transactionRowId:String(attempt.id),semanticStage:String(attempt.semantic_stage),exactHash:String(attempt.tx_hash),nonce:Number(attempt.nonce),latestNonce:attemptEvidence.latestNonce,pendingNonce:attemptEvidence.pendingNonce,classification:'SIGNED_HASH_ABSENT_NONCE_AVAILABLE'},burnedProof,proposedRowChanges:['later PREPARED attempt → FAILED (exact hash retained)','burn lifecycle intent → BURNED','v4 position → burned/liquidity=0','terminal accounting differences → idempotently finalized','rebalance commitment release → append-only permanent marker'],resultingWorkflowCheckpoint:'PERMANENTLY_NON_RESUMABLE_CLOSED_NO_REPLACEMENT'};
}
export function closedNoReplacementToken(input:{workflowId:string;journalFingerprint:string;closeHash:string;burnHash:string;abandonedHash:string;abandonedNonce:number;expiresAt:number}){return Buffer.from(JSON.stringify(input)).toString('base64url');}
export function verifyClosedNoReplacementToken(token:string,input:{workflowId:string;journalFingerprint:string;closeHash:string;burnHash:string;abandonedHash:string;abandonedNonce:number;now?:number}){try{const value=JSON.parse(Buffer.from(token,'base64url').toString('utf8')) as Row;return value.workflowId===input.workflowId&&value.journalFingerprint===input.journalFingerprint&&String(value.closeHash).toLowerCase()===input.closeHash.toLowerCase()&&String(value.burnHash).toLowerCase()===input.burnHash.toLowerCase()&&String(value.abandonedHash).toLowerCase()===input.abandonedHash.toLowerCase()&&Number(value.abandonedNonce)===input.abandonedNonce&&Number(value.expiresAt)>(input.now??Date.now());}catch{return false;}}
export function applyClosedNoReplacementTerminalization(repo:SqliteLedgerRepository,preview:ClosedNoReplacementPreview){
 if(preview.alreadyTerminalized)return {status:'ALREADY_TERMINALIZED' as const,marker:rebalanceCommitmentReleaseMarkerValid(repo,preview.workflowId),terminalAccountingInserted:0};
 let accountingInserted=0,marker:Row|undefined;
 repo.db.transaction(()=>{
  const current=closedNoReplacementJournal(repo,preview.workflowId);if(current.fingerprint!==preview.journalFingerprint)throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_EVIDENCE_CHANGED');
  const at=new Date().toISOString(),changed=repo.db.prepare("UPDATE rebalance_transactions SET status='FAILED',failure_reason='SIGNED_HASH_PROVEN_ABSENT_NONCE_AVAILABLE_OPERATOR_TERMINALIZATION',updated_at=? WHERE id=? AND workflow_id=? AND status='PREPARED' AND tx_hash=? AND nonce=? AND submitted_at IS NULL AND confirmed_at IS NULL").run(at,preview.abandonedAttempt.transactionRowId,preview.workflowId,preview.abandonedAttempt.exactHash,preview.abandonedAttempt.nonce).changes;if(changed!==1)throw new Error('REBALANCE_CLOSED_NO_REPLACEMENT_ATTEMPT_CHANGED');
  repo.db.prepare("UPDATE v4_lifecycle_intents SET state='BURNED',failure_reason=NULL,updated_at=? WHERE id=? AND action='burn' AND tx_hash=? AND state IN ('CONFIRMED','RECONCILED','BURNED')").run(at,preview.burn.lifecycleIntentId,preview.burn.exactHash);
  repo.db.prepare("INSERT OR IGNORE INTO v4_lifecycle_transitions(intent_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'BURNED',?,? FROM v4_lifecycle_transitions WHERE intent_id=? AND NOT EXISTS(SELECT 1 FROM v4_lifecycle_transitions WHERE intent_id=? AND state='BURNED')").run(preview.burn.lifecycleIntentId,JSON.stringify({exactHash:preview.burn.exactHash,operatorTerminalization:true}),at,preview.burn.lifecycleIntentId,preview.burn.lifecycleIntentId);
  repo.db.prepare("UPDATE v4_positions SET status='burned',liquidity_raw='0',updated_at=? WHERE token_id=? AND CAST(liquidity_raw AS INTEGER)=0").run(at,preview.tokenId);
  accountingInserted=repo.finalizeV4TerminalAccounting(preview.tokenId).inserted;
  const release=rebalanceCommitmentReleaseEvidence(repo,preview.workflowId);marker=insertRebalanceCommitmentRelease(repo,{workflowId:preview.workflowId,operatorActor:'cli:rebalance-commitment-release-closed-no-replacement',operatorReason:'confirmed close and burn; no replacement; later signed hash proven absent with nonce available',current:release});
 })();
 return {status:'TERMINALIZED' as const,marker,terminalAccountingInserted:accountingInserted};
}
