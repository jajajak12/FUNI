export type DirectLookupCandidateTruth = {
  executionEligible: boolean;
  uiState?: string;
};

export type DirectLookupAccelerationDecision = {
  cachedCandidateCount: number;
  freshExecutableCount: number;
  staleSupportedCount: number;
  unsupportedCount: number;
  accelerationNeeded: boolean;
  reason: "NO_REGISTRY_ROWS" | "STALE_SUPPORTED_CANDIDATES" | "UNSUPPORTED_ONLY" | "SUPPORTED_TRUTH_FRESH";
};

/** Explicit operator lookup policy. Structural blockers never become StateView work. */
export function needsDirectLookupAcceleration(
  candidates: readonly DirectLookupCandidateTruth[],
): DirectLookupAccelerationDecision {
  const unsupportedCount = candidates.filter(candidate =>
      String(candidate.uiState ?? "").startsWith("UNSUPPORTED:"),
    ).length,
    freshExecutableCount = candidates.filter(candidate => candidate.executionEligible).length,
    staleSupportedCount = candidates.filter(candidate =>
      candidate.uiState === "CHECKING" || candidate.uiState === "TEMPORARILY_UNAVAILABLE" || candidate.uiState === "NOT_INITIALIZED" || candidate.uiState === "EVIDENCE_UNAVAILABLE",
    ).length;
  if (candidates.length === 0)
    return {cachedCandidateCount:0,freshExecutableCount,staleSupportedCount,unsupportedCount,accelerationNeeded:true,reason:"NO_REGISTRY_ROWS"};
  if (staleSupportedCount > 0)
    return {cachedCandidateCount:candidates.length,freshExecutableCount,staleSupportedCount,unsupportedCount,accelerationNeeded:true,reason:"STALE_SUPPORTED_CANDIDATES"};
  if (unsupportedCount === candidates.length)
    return {cachedCandidateCount:candidates.length,freshExecutableCount,staleSupportedCount,unsupportedCount,accelerationNeeded:false,reason:"UNSUPPORTED_ONLY"};
  return {cachedCandidateCount:candidates.length,freshExecutableCount,staleSupportedCount,unsupportedCount,accelerationNeeded:false,reason:"SUPPORTED_TRUTH_FRESH"};
}
