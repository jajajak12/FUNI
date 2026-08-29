export const V4_DURABLE_RECOVERY_EXACT_STAGES = [
  "OPEN_ERC20_APPROVAL",
  "OPEN_PERMIT2_APPROVAL",
  "OPEN_BATCH",
  "CLOSE_BATCH",
] as const;

export const V4_DURABLE_RECOVERY_STAGE_PREFIXES = [
  "COLLECT_BATCH:",
  "REPOSITION_PREPARE_ERC20_APPROVAL:",
  "REPOSITION_PREPARE_PERMIT2_APPROVAL:",
] as const;

export function isDurableV4RecoveryStage(stage: string) {
  return (
    (V4_DURABLE_RECOVERY_EXACT_STAGES as readonly string[]).includes(stage) ||
    V4_DURABLE_RECOVERY_STAGE_PREFIXES.some((prefix) => stage.startsWith(prefix))
  );
}
export function assertDurableV4RecoveryStage(stage: string) {
  if (!isDurableV4RecoveryStage(stage))
    throw new Error("V4_DURABLE_RECOVERY_STAGE_UNREGISTERED");
}

export function isDurableV4ApprovalStage(stage: string) {
  return (
    stage === "OPEN_ERC20_APPROVAL" ||
    stage === "OPEN_PERMIT2_APPROVAL" ||
    stage.startsWith("REPOSITION_PREPARE_ERC20_APPROVAL:") ||
    stage.startsWith("REPOSITION_PREPARE_PERMIT2_APPROVAL:")
  );
}

export function isDurableV4LifecycleStage(
  stage: string,
): stage is "OPEN_BATCH" | "CLOSE_BATCH" | `COLLECT_BATCH:${string}` {
  return (
    stage === "OPEN_BATCH" ||
    stage === "CLOSE_BATCH" ||
    stage.startsWith("COLLECT_BATCH:")
  );
}

export function durableV4RecoveryStageSql(alias: "journal" | "j") {
  const exact = V4_DURABLE_RECOVERY_EXACT_STAGES.map((stage) => `'${stage}'`).join(",");
  const prefixes = V4_DURABLE_RECOVERY_STAGE_PREFIXES.map(
    (prefix) => `${alias}.semantic_stage LIKE '${prefix}%'`,
  ).join(" OR ");
  return `(${alias}.semantic_stage IN (${exact}) OR ${prefixes})`;
}
