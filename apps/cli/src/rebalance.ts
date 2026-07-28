import { randomUUID } from 'node:crypto';
import { sanitizeSensitiveText } from '@robin/core';
import type { SqliteLedgerRepository } from '@robin/ledger';
import { assertRebalanceCommitmentNotPermanentlyReleased } from './rebalance-commitment-release.js';

export const REBALANCE_STATES=[
 'PREVIEWED','TOPUP_AUTHORIZED','CLOSE_STARTED','CLOSE_FULL_CONFIRMED','CLOSE_CONFIRMED','ASSETS_CLASSIFIED',
 'SURPLUS_SWAP_STARTED','SURPLUS_SWAP_CONFIRMED','TOPUP_STARTED','TOPUP_CONFIRMED',
 'FUNDING_SWAP_STARTED','FUNDING_SWAP_CONFIRMED','PRICE_REFRESHED','REOPEN_STARTED',
 'REOPEN_CONFIRMED','COMPLETED','FAILED_RECOVERABLE','FAILED_TERMINAL','CANCELLED',
] as const;
export type RebalanceState=typeof REBALANCE_STATES[number];
export type RebalanceMode='REBALANCE'|'REBALANCE_COMPOUND';
export type RebalancePlanInput={
 mode:RebalanceMode;
 originalPrincipalUsd:number;
 recoveredPrincipalUsd:number;
 verifiedFeesUsd:number;
 compoundCapUsd:number;
 originalFundingSymbol:'USDG'|'WETH'|string;
};
export type RebalancePlan={
 mode:RebalanceMode;
 originalPrincipalUsd:number;
 recoveredPrincipalUsd:number;
 verifiedFeesUsd:number;
 requiredTopUpUsd:number;
 requestedReopenUsd:number;
 actualReopenUsd:number;
 principalSurplusUsd:number;
 compoundFeesUsd:number;
 feeSurplusToUsdgUsd:number;
 totalSurplusToUsdgUsd:number;
 originalFundingSymbol:string;
 classification:{
  principalForReopenUsd:number;
  feesForReopenUsd:number;
  principalSurplusToUsdgUsd:number;
  feesToUsdgUsd:number;
 };
};
const valid=(value:number)=>Number.isFinite(value)&&value>=0;
export function calculateRebalancePlan(input:RebalancePlanInput):RebalancePlan{
 if(!valid(input.originalPrincipalUsd)||input.originalPrincipalUsd<=0||!valid(input.recoveredPrincipalUsd)||!valid(input.verifiedFeesUsd)||!valid(input.compoundCapUsd)||input.compoundCapUsd<=0)throw new Error('REBALANCE_ACCOUNTING_INCOMPLETE');
 if(input.mode==='REBALANCE_COMPOUND'&&input.compoundCapUsd<input.originalPrincipalUsd)throw new Error('REBALANCE_COMPOUND_CAP_BELOW_ORIGINAL_PRINCIPAL');
 const p0=input.originalPrincipalUsd,p=input.recoveredPrincipalUsd,f=input.verifiedFeesUsd,requiredTopUpUsd=Math.max(0,p0-p),principalSurplusUsd=Math.max(0,p-p0),requestedReopenUsd=input.mode==='REBALANCE'?p0:p0+f,actualReopenUsd=input.mode==='REBALANCE'?p0:Math.min(requestedReopenUsd,input.compoundCapUsd),compoundFeesUsd=input.mode==='REBALANCE_COMPOUND'?Math.max(0,actualReopenUsd-p0):0,feeSurplusToUsdgUsd=f-compoundFeesUsd,totalSurplusToUsdgUsd=principalSurplusUsd+feeSurplusToUsdgUsd;
 return {mode:input.mode,originalPrincipalUsd:p0,recoveredPrincipalUsd:p,verifiedFeesUsd:f,requiredTopUpUsd,requestedReopenUsd,actualReopenUsd,principalSurplusUsd,compoundFeesUsd,feeSurplusToUsdgUsd,totalSurplusToUsdgUsd,originalFundingSymbol:input.originalFundingSymbol,classification:{principalForReopenUsd:p0,feesForReopenUsd:compoundFeesUsd,principalSurplusToUsdgUsd:principalSurplusUsd,feesToUsdgUsd:feeSurplusToUsdgUsd}};
}
export type TopUpAvailability={originalFundingUsd:number;usdgUsd:number};
export type RebalanceApprovalDecision={requestedApprovalUsd:number;actualReopenedFundingRequirementUsd:number;maximumApprovalUsd:number;exactAmount:true;unlimited:false};
export function evaluateRebalanceApproval(input:{requestedApprovalUsd:number;actualReopenedFundingRequirementUsd:number;maximumApprovalUsd:number}):RebalanceApprovalDecision{
 if(![input.requestedApprovalUsd,input.actualReopenedFundingRequirementUsd,input.maximumApprovalUsd].every(value=>Number.isFinite(value)&&value>0))throw new Error('REBALANCE_APPROVAL_VALUE_INVALID');
 if(input.requestedApprovalUsd!==input.actualReopenedFundingRequirementUsd)throw new Error('REBALANCE_APPROVAL_NOT_EXACT');
 if(input.requestedApprovalUsd>input.maximumApprovalUsd)throw new Error('REBALANCE_APPROVAL_CAP_EXCEEDED');
 return {...input,exactAmount:true,unlimited:false};
}
export function rebalanceApprovalPreviewLines(decision:RebalanceApprovalDecision){return [`Exact reopened-funding approval: $${decision.requestedApprovalUsd.toFixed(2)}`,`Effective rebalance approval maximum: $${decision.maximumApprovalUsd.toFixed(2)}`];}
export function rebalanceConfirmationLabel(actualExternalTopUpUsd:number,reopenedFundingApprovalRequired=false){
 if(actualExternalTopUpUsd>0)return 'Approve Top-up & Rebalance';
 return reopenedFundingApprovalRequired?'Approve Funding & Rebalance':'Confirm Rebalance';
}
export function authorizeTopUp(plan:RebalancePlan,maximumAuthorizedUsd:number,balances:TopUpAvailability){
 if(!valid(maximumAuthorizedUsd)||maximumAuthorizedUsd>plan.originalPrincipalUsd||plan.requiredTopUpUsd>maximumAuthorizedUsd)throw new Error('REBALANCE_TOPUP_AUTHORIZATION_EXCEEDED');
 if(!valid(balances.originalFundingUsd)||!valid(balances.usdgUsd))throw new Error('REBALANCE_TOPUP_BALANCE_UNAVAILABLE');
 const fromOriginalFundingUsd=Math.min(plan.requiredTopUpUsd,balances.originalFundingUsd),remaining=plan.requiredTopUpUsd-fromOriginalFundingUsd,fromUsdgUsd=plan.originalFundingSymbol==='USDG'?0:Math.min(remaining,balances.usdgUsd);
 if(fromOriginalFundingUsd+fromUsdgUsd<plan.requiredTopUpUsd)throw new Error('REBALANCE_TOPUP_BALANCE_INSUFFICIENT');
 return {maximumAuthorizedUsd,actualTopUpUsd:plan.requiredTopUpUsd,fromOriginalFundingUsd,fromUsdgUsd,walletAssetsDebited:[...(fromOriginalFundingUsd>0?[plan.originalFundingSymbol]:[]),...(fromUsdgUsd>0?['USDG']:[])]};
}
export function rebalanceSwapRoutes(plan:RebalancePlan){
 const funding=plan.originalFundingSymbol;
 if(plan.mode==='REBALANCE')return {feeRoutes:[`target fees → USDG`,`${funding} fees → USDG`],principalSurplusRoute:'principal surplus → USDG',reopenRoute:`single-sided ${funding} → same pool`};
 return {feeRoutes:[`target fees → ${funding}`,`${funding} fees remain ${funding}`],principalSurplusRoute:'principal surplus → USDG',excessFeeRoute:'fees above compound cap → USDG',reopenRoute:`single-sided ${funding} → same pool`};
}
const progression:RebalanceState[]=['PREVIEWED','TOPUP_AUTHORIZED','CLOSE_STARTED','CLOSE_FULL_CONFIRMED','CLOSE_CONFIRMED','ASSETS_CLASSIFIED','SURPLUS_SWAP_STARTED','SURPLUS_SWAP_CONFIRMED','TOPUP_STARTED','TOPUP_CONFIRMED','FUNDING_SWAP_STARTED','FUNDING_SWAP_CONFIRMED','PRICE_REFRESHED','REOPEN_STARTED','REOPEN_CONFIRMED','COMPLETED'];
const json=(value:unknown)=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?item.toString():item);
export function ensureRebalanceLineage(repo:SqliteLedgerRepository,input:{rootPositionId:string;originalPrincipalUsd:number;fundingToken:string;fundingSymbol:string;protocol:'v3'|'v4';poolId:string}){
 if(!valid(input.originalPrincipalUsd)||input.originalPrincipalUsd<=0)throw new Error('REBALANCE_ACCOUNTING_INCOMPLETE');
 const existing=repo.db.prepare('SELECT * FROM rebalance_lineages WHERE root_position_id=?').get(input.rootPositionId) as Record<string,unknown>|undefined;
 if(existing){if(Number(existing.original_principal_usd)!==input.originalPrincipalUsd||String(existing.original_funding_token).toLowerCase()!==input.fundingToken.toLowerCase()||String(existing.pool_id).toLowerCase()!==input.poolId.toLowerCase())throw new Error('REBALANCE_LINEAGE_IMMUTABLE_MISMATCH');return existing;}
 const id=randomUUID(),at=new Date().toISOString();repo.db.prepare('INSERT INTO rebalance_lineages(id,root_position_id,original_principal_usd,original_funding_token,original_funding_symbol,protocol_version,pool_id,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,input.rootPositionId,input.originalPrincipalUsd,input.fundingToken,input.fundingSymbol,input.protocol,input.poolId,at);return repo.db.prepare('SELECT * FROM rebalance_lineages WHERE id=?').get(id) as Record<string,unknown>;
}
export function createRebalanceWorkflow(repo:SqliteLedgerRepository,input:{idempotencyKey:string;lineageId:string;oldPositionId:string;mode:RebalanceMode;downsidePct:number;preview:unknown}):Record<string,unknown>{
 const existing=repo.db.prepare('SELECT * FROM rebalance_workflows WHERE idempotency_key=?').get(input.idempotencyKey) as Record<string,unknown>|undefined;if(existing)return existing;
 const active=repo.db.prepare("SELECT id FROM rebalance_workflows WHERE old_position_id=? AND state NOT IN ('COMPLETED','FAILED_TERMINAL','CANCELLED') LIMIT 1").get(input.oldPositionId) as {id:string}|undefined;if(active)return reuseRebalanceWorkflowForFreshPreview(repo,{...input,oldPositionActive:true});
 if(!Number.isFinite(input.downsidePct)||input.downsidePct<=0||input.downsidePct>=100)throw new Error('REBALANCE_RANGE_INVALID');
 const id=randomUUID(),at=new Date().toISOString();repo.db.prepare("INSERT INTO rebalance_workflows(id,idempotency_key,lineage_id,old_position_id,mode,downside_pct,state,preview_json,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,input.idempotencyKey,input.lineageId,input.oldPositionId,input.mode,input.downsidePct,'PREVIEWED',json(input.preview),json({}),at,at);repo.db.prepare("INSERT INTO rebalance_transitions(workflow_id,ordinal,state,details_json,created_at) VALUES(?,0,'PREVIEWED',?,?)").run(id,json(input.preview),at);return rebalanceWorkflow(repo,id)!;
}
export function reuseRebalanceWorkflowForFreshPreview(repo:SqliteLedgerRepository,input:{idempotencyKey:string;lineageId:string;oldPositionId:string;mode:RebalanceMode;downsidePct:number;preview:unknown;oldPositionActive:boolean}):Record<string,unknown>{
 const existing=repo.db.prepare("SELECT * FROM rebalance_workflows WHERE old_position_id=? AND state NOT IN ('COMPLETED','FAILED_TERMINAL','CANCELLED') ORDER BY updated_at DESC LIMIT 1").get(input.oldPositionId) as Record<string,unknown>|undefined;
 if(!existing)return createRebalanceWorkflow(repo,input);
 const workflowId=String(existing.id);assertRebalanceCommitmentNotPermanentlyReleased(repo,workflowId);const hasTx=Boolean(repo.db.prepare('SELECT 1 FROM rebalance_transactions WHERE workflow_id=? LIMIT 1').get(workflowId)),hasReceipt=Boolean(repo.db.prepare('SELECT 1 FROM rebalance_receipts WHERE workflow_id=? LIMIT 1').get(workflowId));
 if(hasTx||hasReceipt||existing.replacement_position_id)throw new Error('REBALANCE_RECONCILIATION_REQUIRED');
 if(!input.oldPositionActive)throw new Error('REBALANCE_OLD_POSITION_NOT_ACTIVE');
 const at=new Date().toISOString(),from=String(existing.state),details={freshPreview:true,reused:true,resumeFrom:from,oldPositionActive:true};
 repo.db.transaction(()=>{repo.db.prepare("UPDATE rebalance_workflows SET idempotency_key=?,lineage_id=?,mode=?,downside_pct=?,state='PREVIEWED',approved_topup_usd=NULL,preview_json=?,state_json=?,execution_json='{}',projected_gas_usd=NULL,actual_gas_usd=0,last_error=NULL,revision=revision+1,updated_at=? WHERE id=?").run(input.idempotencyKey,input.lineageId,input.mode,input.downsidePct,json(input.preview),json(details),at,workflowId);repo.db.prepare("INSERT INTO rebalance_transitions(workflow_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'PREVIEWED',?,? FROM rebalance_transitions WHERE workflow_id=?").run(workflowId,json(details),at,workflowId);})();
 return rebalanceWorkflow(repo,workflowId)!;
}
export function rebalanceWorkflow(repo:SqliteLedgerRepository,id:string){return repo.db.prepare('SELECT * FROM rebalance_workflows WHERE id=?').get(id) as Record<string,unknown>|undefined;}
export function rebalanceTransitions(repo:SqliteLedgerRepository,id:string){return repo.db.prepare('SELECT * FROM rebalance_transitions WHERE workflow_id=? ORDER BY ordinal').all(id) as Record<string,unknown>[];}
export function transitionRebalance(repo:SqliteLedgerRepository,input:{workflowId:string;expectedState:RebalanceState;nextState:RebalanceState;details?:unknown;receipt?:{stage:string;txHash:string;receipt:unknown};replacementPositionId?:string;error?:string}){
 assertRebalanceCommitmentNotPermanentlyReleased(repo,input.workflowId);
 const current=rebalanceWorkflow(repo,input.workflowId);if(!current)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');const state=String(current.state) as RebalanceState;
 const currentIndex=progression.indexOf(state),nextIndex=progression.indexOf(input.nextState);if(state===input.nextState||(nextIndex>=0&&currentIndex>nextIndex))return current;
 if(state!==input.expectedState)throw new Error('REBALANCE_STALE_OR_DUPLICATE_TRANSITION');
 const terminalTransition=['FAILED_RECOVERABLE','FAILED_TERMINAL','CANCELLED'].includes(input.nextState);if(!terminalTransition&&!(currentIndex>=0&&nextIndex===currentIndex+1))throw new Error('REBALANCE_INVALID_STATE_TRANSITION');
 if(input.nextState.endsWith('_CONFIRMED')&&!input.receipt)throw new Error('REBALANCE_RECEIPT_REQUIRED');
 const at=new Date().toISOString(),safeError=input.error===undefined?null:sanitizeSensitiveText(input.error),run=repo.db.transaction(()=>{if(input.receipt)repo.db.prepare('INSERT OR IGNORE INTO rebalance_receipts(workflow_id,stage,tx_hash,receipt_json,confirmed_at) VALUES(?,?,?,?,?)').run(input.workflowId,input.receipt.stage,input.receipt.txHash,json(input.receipt.receipt),at);const changed=repo.db.prepare('UPDATE rebalance_workflows SET state=?,revision=revision+1,state_json=?,replacement_position_id=COALESCE(?,replacement_position_id),last_error=?,updated_at=? WHERE id=? AND state=? AND revision=?').run(input.nextState,json(input.details??{}),input.replacementPositionId??null,safeError,at,input.workflowId,input.expectedState,Number(current.revision)).changes;if(changed!==1)throw new Error('REBALANCE_CONCURRENT_TRANSITION');repo.db.prepare('INSERT INTO rebalance_transitions(workflow_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM rebalance_transitions WHERE workflow_id=?').run(input.workflowId,input.nextState,json(input.details??{}),at,input.workflowId);});run();return rebalanceWorkflow(repo,input.workflowId)!;
}
export function authorizeRebalanceWorkflow(repo:SqliteLedgerRepository,input:{workflowId:string;maximumTopUpUsd:number;balances:TopUpAvailability}):Record<string,unknown>&{authorization:ReturnType<typeof authorizeTopUp>}{
 assertRebalanceCommitmentNotPermanentlyReleased(repo,input.workflowId);
 const workflow=rebalanceWorkflow(repo,input.workflowId);if(!workflow)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');const preview=JSON.parse(String(workflow.preview_json)) as {plan:RebalancePlan},authorization=authorizeTopUp(preview.plan,input.maximumTopUpUsd,input.balances),at=new Date().toISOString(),run=repo.db.transaction(()=>{const changed=repo.db.prepare("UPDATE rebalance_workflows SET state='TOPUP_AUTHORIZED',approved_topup_usd=?,revision=revision+1,state_json=?,updated_at=? WHERE id=? AND state='PREVIEWED'").run(input.maximumTopUpUsd,json({authorization}),at,input.workflowId).changes;if(changed!==1){const now=rebalanceWorkflow(repo,input.workflowId);if(now?.state==='TOPUP_AUTHORIZED')return;throw new Error('REBALANCE_STALE_OR_DUPLICATE_CALLBACK');}repo.db.prepare("INSERT INTO rebalance_transitions(workflow_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,'TOPUP_AUTHORIZED',?,? FROM rebalance_transitions WHERE workflow_id=?").run(input.workflowId,json({authorization}),at,input.workflowId);});run();return {...rebalanceWorkflow(repo,input.workflowId)!,authorization};
}
export function recordRebalanceAccounting(repo:SqliteLedgerRepository,input:{workflowId:string;idempotencyKey:string;kind:string;tokenAddress?:string;amountRaw?:bigint;usdValue?:number;priceSource?:string;priceBlock?:bigint;provenance:unknown}){
 if(input.usdValue!==undefined&&!valid(input.usdValue))throw new Error('REBALANCE_ACCOUNTING_VALUE_INVALID');repo.db.prepare('INSERT OR IGNORE INTO rebalance_accounting_events(id,workflow_id,kind,token_address,amount_raw,usd_value,price_source,price_block,observed_at,provenance_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.idempotencyKey,input.workflowId,input.kind,input.tokenAddress??null,input.amountRaw?.toString()??null,input.usdValue??null,input.priceSource??null,input.priceBlock?.toString()??null,new Date().toISOString(),json(input.provenance));
}
export function evaluateRebalanceExecutionGate(input:{executionEnabled:boolean;dryRun:boolean;emergencyPause:boolean;estimatedTxGasUsd:number;estimatedLifecycleGasUsd:number;maxTxGasUsd:number;maxLifecycleGasUsd:number;priceFresh:boolean;poolActive:boolean;accountingComplete:boolean}){
 const reasons:string[]=[];if(!input.executionEnabled)reasons.push('EXECUTION_DISABLED');if(input.dryRun)reasons.push('DRY_RUN_ENABLED');if(input.emergencyPause)reasons.push('EMERGENCY_PAUSE');if(!input.accountingComplete)reasons.push('REBALANCE_ACCOUNTING_INCOMPLETE');if(!input.priceFresh)reasons.push('REBALANCE_PRICE_STALE');if(!input.poolActive)reasons.push('REBALANCE_POOL_NO_ACTIVE_LIQUIDITY');if(!Number.isFinite(input.estimatedTxGasUsd)||!Number.isFinite(input.estimatedLifecycleGasUsd))reasons.push('REBALANCE_GAS_ESTIMATE_UNAVAILABLE');else{if(input.estimatedTxGasUsd>input.maxTxGasUsd)reasons.push('TX_GAS_CAP_EXCEEDED');if(input.estimatedLifecycleGasUsd>input.maxLifecycleGasUsd)reasons.push('LIFECYCLE_GAS_BUDGET_EXCEEDED');}return {executionReachable:reasons.length===0,reasons,mainnetTransactionsSent:0 as const};
}
export function markRebalanceRecoverable(repo:SqliteLedgerRepository,workflowId:string,error:string){const row=rebalanceWorkflow(repo,workflowId);if(!row)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');return transitionRebalance(repo,{workflowId,expectedState:String(row.state) as RebalanceState,nextState:'FAILED_RECOVERABLE',details:{resumeFrom:row.state},error});}
export function markRebalancePreTransactionFailure(repo:SqliteLedgerRepository,workflowId:string,error:string){const row=rebalanceWorkflow(repo,workflowId);if(!row)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');const hasTx=Boolean(repo.db.prepare('SELECT 1 FROM rebalance_transactions WHERE workflow_id=? LIMIT 1').get(workflowId)),hasReceipt=Boolean(repo.db.prepare('SELECT 1 FROM rebalance_receipts WHERE workflow_id=? LIMIT 1').get(workflowId));if(hasTx||hasReceipt||row.replacement_position_id)return row;const current=String(row.state) as RebalanceState;if(['FAILED_RECOVERABLE','FAILED_TERMINAL','CANCELLED','COMPLETED'].includes(current))return row;return markRebalanceRecoverable(repo,workflowId,error);}
export function markRebalanceExecutionFailure(repo:SqliteLedgerRepository,workflowId:string,error:string){
 const row=rebalanceWorkflow(repo,workflowId);if(!row)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');const current=String(row.state) as RebalanceState;if(['FAILED_TERMINAL','CANCELLED','COMPLETED'].includes(current))return row;
 if(current==='FAILED_RECOVERABLE'){repo.db.prepare('UPDATE rebalance_workflows SET last_error=?,updated_at=? WHERE id=?').run(sanitizeSensitiveText(error),new Date().toISOString(),workflowId);return rebalanceWorkflow(repo,workflowId)!;}
 return markRebalanceRecoverable(repo,workflowId,error);
}
export function resumeRebalance(repo:SqliteLedgerRepository,workflowId:string,options:{internalRecovery?:boolean}={}){
 assertRebalanceCommitmentNotPermanentlyReleased(repo,workflowId);
 const row=rebalanceWorkflow(repo,workflowId);if(!row)throw new Error('REBALANCE_WORKFLOW_NOT_FOUND');if(String(row.state)!=='FAILED_RECOVERABLE')return row;
 if(!options.internalRecovery)throw new Error('REBALANCE_FRESH_PREVIEW_REQUIRED');
 const state=JSON.parse(String(row.state_json)) as {resumeFrom?:RebalanceState},resumeFrom=state.resumeFrom;if(!resumeFrom||!progression.includes(resumeFrom))throw new Error('REBALANCE_RESUME_STATE_INVALID');
 const pending=repo.db.prepare("SELECT semantic_stage,status,tx_hash FROM rebalance_transactions WHERE workflow_id=? AND status IN ('PREPARED','SUBMITTED') ORDER BY created_at LIMIT 1").get(workflowId) as Record<string,unknown>|undefined;
 const at=new Date().toISOString(),details={internalRecovery:true,resumeFrom,pendingSubmission:pending??null},run=repo.db.transaction(()=>{const changed=repo.db.prepare("UPDATE rebalance_workflows SET state=?,revision=revision+1,state_json=?,updated_at=? WHERE id=? AND state='FAILED_RECOVERABLE'").run(resumeFrom,json(details),at,workflowId).changes;if(changed!==1)throw new Error('REBALANCE_CONCURRENT_TRANSITION');repo.db.prepare('INSERT INTO rebalance_transitions(workflow_id,ordinal,state,details_json,created_at) SELECT ?,COALESCE(MAX(ordinal),-1)+1,?,?,? FROM rebalance_transitions WHERE workflow_id=?').run(workflowId,resumeFrom,json(details),at,workflowId);});run();return rebalanceWorkflow(repo,workflowId)!;
}
