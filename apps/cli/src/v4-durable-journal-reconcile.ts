import { getAddress, type Address, type Hash, type TransactionReceipt } from "viem";
import { robinhoodMainnet, type FallbackRpc } from "@funi/core";
import type { SqliteLedgerRepository } from "@funi/ledger";
import { V4_ROBINHOOD_DEPLOYMENTS } from "@funi/v4";
import { exactHashEvidence, type ExactHashEvidence } from "./transaction-boundary.js";
import { reconcileConfirmedV4BidLadderJournal } from "./v4-bid-ladder-live.js";

const CHAIN_ID = 4663;
export const V4_DURABLE_RECOVERY_LIMIT = 8;
type Candidate = {
  journal_id: string;
  wallet_address: string;
  workflow_identity: string;
  semantic_stage: "OPEN_BATCH" | "CLOSE_BATCH" | `COLLECT_BATCH:${string}`;
  attempt: number;
  status: "PREPARED" | "SUBMITTED" | "CONFIRMED";
  nonce: number;
  expected_hash: string;
  to_address: string;
  receipt_json: string | null;
};

function receipt(value: string): TransactionReceipt {
  return JSON.parse(value, (key, item) =>
    [
      "blockNumber",
      "cumulativeGasUsed",
      "effectiveGasPrice",
      "gasUsed",
      "blobGasPrice",
      "blobGasUsed",
    ].includes(key) && typeof item === "string"
      ? BigInt(item)
      : item,
  ) as TransactionReceipt;
}

/** The wallet/nonce index makes the eligible set wallet-wide and deterministic;
 * LIMIT bounds both RPC calls and ledger finalizations per normal cycle. */
export function durableV4RecoveryCandidates(
  repo: SqliteLedgerRepository,
  wallet: Address | undefined,
  limit = V4_DURABLE_RECOVERY_LIMIT,
  journalIds?: readonly string[],
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
    throw new Error("V4_DURABLE_RECOVERY_LIMIT_INVALID");
  const walletPredicate = wallet ? "AND journal.wallet_address=?" : "",journalPredicate=journalIds?.length?`AND journal.journal_id IN (${journalIds.map(()=>'?').join(',')})`:"";
  return repo.db
    .prepare(
      `SELECT journal.*
       FROM chain_transaction_journal AS journal INDEXED BY chain_transaction_wallet_nonce_idx
       JOIN v4_bid_ladders AS ladder ON ladder.ladder_id=journal.workflow_identity
       WHERE journal.chain_id=? ${walletPredicate} ${journalPredicate}
         AND journal.protocol='uniswap_v4'
         AND (journal.semantic_stage IN ('OPEN_BATCH','CLOSE_BATCH') OR journal.semantic_stage LIKE 'COLLECT_BATCH:%')
         AND (
           journal.status IN ('PREPARED','SUBMITTED')
           OR (journal.status='CONFIRMED' AND (
             (journal.semantic_stage='OPEN_BATCH' AND
               (ladder.status='PLANNED'
               OR (ladder.status='OPEN' AND (EXISTS(SELECT 1 FROM v4_bid_ladder_legs leg WHERE leg.ladder_id=ladder.ladder_id AND (leg.status<>'OPEN' OR leg.token_id IS NULL))
               OR (SELECT COUNT(*) FROM v4_positions position WHERE position.open_intent_id=ladder.ladder_id)<>5
               OR (SELECT COUNT(*) FROM positions generic JOIN v4_positions position ON generic.id='v4:'||position.token_id WHERE position.open_intent_id=ladder.ladder_id)<>5
               OR (SELECT COUNT(*) FROM position_deposits deposit JOIN v4_positions position ON deposit.position_id='v4:'||position.token_id WHERE position.open_intent_id=ladder.ladder_id)<>5
               OR (SELECT COUNT(*) FROM active_position_reconciliations marker JOIN v4_positions position ON marker.position_id='v4:'||position.token_id WHERE position.open_intent_id=ladder.ladder_id)<>5))))
             OR (journal.semantic_stage='CLOSE_BATCH' AND ladder.status<>'CLOSED')
             OR (journal.semantic_stage LIKE 'COLLECT_BATCH:%' AND
               ((SELECT COUNT(*) FROM collections collection WHERE lower(collection.tx_hash)=lower(journal.expected_hash))<>5
               OR NOT EXISTS(SELECT 1 FROM realized_pnl_events event
                 WHERE event.workflow_identity=journal.workflow_identity
                   AND event.journal_stage=journal.semantic_stage
                   AND lower(event.transaction_hash)=lower(journal.expected_hash)
                   AND event.event_kind='CLAIM'
                   AND event.valuation_status='AVAILABLE')))
           ))
         )
       ORDER BY CASE journal.status WHEN 'PREPARED' THEN 0 WHEN 'SUBMITTED' THEN 1 ELSE 2 END,
                journal.nonce, journal.attempt
       LIMIT ?`,
    )
    .all(...(wallet ? [CHAIN_ID, wallet.toLowerCase(),...(journalIds??[]),limit] : [CHAIN_ID,...(journalIds??[]),limit])) as Candidate[];
}

function fundingUsd(repo: SqliteLedgerRepository, ladderId: string) {
  const parent = repo.loadBidLadder(ladderId);
  if (!parent) throw new Error("V4_BID_LADDER_NOT_FOUND");
  const snapshot = Number(parent.entry_usd_snapshot);
  // PREPARED admission already persisted the authoritative snapshot. The
  // finalizer uses COALESCE, so no live price is needed during recovery.
  if (
    parent.entry_usd_snapshot !== null &&
    parent.entry_usd_snapshot !== undefined &&
    Number.isFinite(snapshot) &&
    snapshot >= 0
  )
    return 1;
  if (
    String(parent.funding_token).toLowerCase() ===
    robinhoodMainnet.assets.USDG.toLowerCase()
  )
    return 1;
  const raw = Number(parent.total_funding_amount_raw),
    metadata = repo.tokenMetadata(String(parent.funding_token));
  if (!Number.isFinite(snapshot) || snapshot <= 0 || !Number.isFinite(raw) || raw <= 0 || !metadata)
    throw new Error("V4_DURABLE_RECOVERY_FUNDING_PRICE_UNAVAILABLE");
  return snapshot / (raw / 10 ** Number(metadata.decimals));
}

export async function reconcileDurableV4Journals(input: {
  repo: SqliteLedgerRepository;
  rpc: FallbackRpc;
  wallet?: Address;
  limit?: number;
  observe?: (
    rpc: FallbackRpc,
    wallet: Address,
    hash: Hash,
    nonce: number,
  ) => Promise<ExactHashEvidence>;
  journalIds?: readonly string[];
}) {
  const candidates = durableV4RecoveryCandidates(
      input.repo,
      input.wallet,
      input.limit,
      input.journalIds,
    ),
    observe = input.observe ?? exactHashEvidence,
    results: Array<Record<string, unknown>> = [];
  const assertReceiptIdentity = (candidate: Candidate, value: TransactionReceipt) => {
    if (
      value.transactionHash.toLowerCase() !== candidate.expected_hash.toLowerCase() ||
      !value.to ||
      value.to.toLowerCase() !== V4_ROBINHOOD_DEPLOYMENTS.positionManager.toLowerCase()
    )
      throw new Error("V4_DURABLE_RECOVERY_RECEIPT_IDENTITY_MISMATCH");
  };
  for (const candidate of candidates) {
    try {
      if (
        (input.wallet && getAddress(candidate.wallet_address) !== getAddress(input.wallet)) ||
        getAddress(candidate.to_address) !== V4_ROBINHOOD_DEPLOYMENTS.positionManager
      )
        throw new Error("V4_DURABLE_RECOVERY_SCOPE_MISMATCH");
      const candidateWallet = getAddress(candidate.wallet_address);
      let exactReceipt: TransactionReceipt | undefined;
      if (candidate.status === "CONFIRMED") {
        if (!candidate.receipt_json)
          throw new Error("V4_DURABLE_RECOVERY_CONFIRMED_RECEIPT_MISSING");
        exactReceipt = receipt(candidate.receipt_json);
      } else {
        const evidence = await observe(
          input.rpc,
          candidateWallet,
          candidate.expected_hash as Hash,
          candidate.nonce,
        );
        if (evidence.kind === "RECEIPT") {
          assertReceiptIdentity(candidate, evidence.receipt);
          input.repo.reconcileDurableChainTransaction({
            chainId: CHAIN_ID,
            wallet: candidateWallet,
            workflowIdentity: candidate.workflow_identity,
            semanticStage: candidate.semantic_stage,
            attempt: candidate.attempt,
            expectedHash: candidate.expected_hash,
            evidence: {
              kind: "RECEIPT",
              receipt: evidence.receipt as unknown as Record<string, unknown>,
            },
          });
          if (evidence.receipt.status === "reverted") {
            results.push({
              journalId: candidate.journal_id,
              outcome: "FAILED",
              failureReason: "TRANSACTION_REVERTED",
            });
            continue;
          }
          exactReceipt = evidence.receipt;
        } else if (
          evidence.kind === "ABSENT" &&
          evidence.latestNonce > candidate.nonce
        ) {
          input.repo.reconcileDurableChainTransaction({
            chainId: CHAIN_ID,
            wallet: candidateWallet,
            workflowIdentity: candidate.workflow_identity,
            semanticStage: candidate.semantic_stage,
            attempt: candidate.attempt,
            expectedHash: candidate.expected_hash,
            evidence: {
              kind: "NONCE_UNAVAILABLE",
              latestNonce: evidence.latestNonce,
              pendingNonce: evidence.pendingNonce,
            },
          });
          results.push({
            journalId: candidate.journal_id,
            outcome: "FAILED",
            failureReason: "NONCE_NO_LONGER_AVAILABLE",
          });
          continue;
        } else {
          results.push({
            journalId: candidate.journal_id,
            outcome: "UNRESOLVED",
            evidence: evidence.kind,
          });
          continue;
        }
      }
      assertReceiptIdentity(candidate, exactReceipt);
      const reconciliation = await reconcileConfirmedV4BidLadderJournal({
        repo: input.repo,
        rpc: input.rpc,
        ladderId: candidate.workflow_identity,
        wallet: candidateWallet,
        fundingUsd: fundingUsd(input.repo, candidate.workflow_identity),
        nativeUsd: 1,
        runtime: {
          executionEnabled: false,
          dryRun: true,
          emergencyPause: true,
          signerConfigured: false,
          allowlisted: false,
          maxPositionUsd: 0,
          maxApprovalUsd: 0,
          maxGasUsd: 0,
          slippageBps: 0,
        },
        semanticStage: candidate.semantic_stage,
        receipt: exactReceipt,
      });
      results.push({
        journalId: candidate.journal_id,
        outcome: "CONFIRMED_RECONCILED",
        semanticStage: candidate.semantic_stage,
        reconciliation,
      });
    } catch (error) {
      results.push({
        journalId: candidate.journal_id,
        outcome: "FINALIZATION_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    scanned: candidates.length,
    limit: input.limit ?? V4_DURABLE_RECOVERY_LIMIT,
    results,
    signingAttempts: 0 as const,
    broadcasts: 0 as const,
    mainnetTransactionsSent: 0 as const,
  };
}
