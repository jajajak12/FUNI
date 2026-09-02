export const LIVE_PREVIEW_HARD_DEADLINE_MS = 15_000;
export const LIVE_PREVIEW_TERMINAL_DELIVERY_RESERVE_MS = 1_500;
export const LIVE_PREVIEW_TELEGRAM_OPERATION_MAX_MS = 3_000;

export type LivePreviewPhase =
  | "PREPARING"
  | "COMPUTED"
  | "DELIVERED"
  | "FAILED"
  | "SUPERSEDED"
  | "DELIVERY_FAILED";

export type LivePreviewOutcome =
  | "AUTHORITATIVE_LIVE_PREVIEW"
  | "EXPLICIT_FAIL_CLOSED"
  | "SUPERSEDED_NO_OP";

export type LivePreviewIdentity = {
  sessionId: string;
  flowRevision: number;
  requestId: string;
  poolId: string;
  amountIdentity: string;
  startedAtMs: number;
  hardDeadlineAtMs: number;
};

export type LivePreviewTerminal = {
  phase: Extract<LivePreviewPhase, "DELIVERED" | "FAILED" | "SUPERSEDED" | "DELIVERY_FAILED">;
  outcome: LivePreviewOutcome;
  code: string;
  terminalAtMs: number;
};

export class LivePreviewLifecycleError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LivePreviewLifecycleError";
  }
}

type Telemetry = (event: string, data: Record<string, unknown>) => void;

export class LivePreviewExecutionContext {
  readonly abortController = new AbortController();
  readonly signal = this.abortController.signal;
  private readonly deadlineController = new AbortController();
  private hardTimer: ReturnType<typeof setTimeout> | undefined;
  private _phase: LivePreviewPhase = "PREPARING";
  private _terminal: LivePreviewTerminal | undefined;
  private cleanupOwned = true;

  constructor(
    readonly identity: LivePreviewIdentity,
    private readonly current: () => boolean,
    private readonly telemetry?: Telemetry,
    private readonly now: () => number = Date.now,
  ) {
    const remaining = identity.hardDeadlineAtMs - now();
    if (remaining <= 0) {
      this.terminalize("FAILED", "EXPLICIT_FAIL_CLOSED", "LIVE_PREVIEW_HARD_DEADLINE");
      return;
    }
    this.hardTimer = setTimeout(() => {
      this.terminalize(
        this._phase === "COMPUTED" ? "DELIVERY_FAILED" : "FAILED",
        "EXPLICIT_FAIL_CLOSED",
        "LIVE_PREVIEW_HARD_DEADLINE",
      );
    }, remaining);
    this.hardTimer.unref?.();
    this.emit("live_preview_lifecycle", { phase: "PREPARING", code: "ACCEPTED" });
  }

  get phase() { return this._phase; }
  get terminal() { return this._terminal; }
  get cleanupPending() { return this.cleanupOwned; }
  get flowRevision() { return this.identity.flowRevision; }

  record(event: string, data: Record<string, unknown>) { this.emit(event, data); }

  setFlowRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision < this.identity.flowRevision)
      throw new LivePreviewLifecycleError("LIVE_PREVIEW_FLOW_REVISION_INVALID");
    this.identity.flowRevision = revision;
  }

  remainingMs() { return Math.max(0, this.identity.hardDeadlineAtMs - this.now()); }

  validateCurrent() {
    if (this._terminal) throw new LivePreviewLifecycleError(this._terminal.code);
    if (this.remainingMs() <= 0) {
      this.terminalize("FAILED", "EXPLICIT_FAIL_CLOSED", "LIVE_PREVIEW_HARD_DEADLINE");
      throw new LivePreviewLifecycleError("LIVE_PREVIEW_HARD_DEADLINE");
    }
    if (!this.current()) {
      this.supersede("LIVE_PREVIEW_IDENTITY_SUPERSEDED");
      throw new LivePreviewLifecycleError("LIVE_PREVIEW_IDENTITY_SUPERSEDED");
    }
  }

  markComputed() {
    this.validateCurrent();
    if (this._phase !== "PREPARING")
      throw new LivePreviewLifecycleError("LIVE_PREVIEW_COMPUTED_TRANSITION_INVALID");
    this._phase = "COMPUTED";
    this.emit("live_preview_lifecycle", { phase: "COMPUTED", code: "AUTHORITATIVE_PREVIEW_PERSISTED" });
  }

  cancelWork(reason: unknown) {
    if (!this.abortController.signal.aborted)
      this.abortController.abort(reason instanceof Error ? reason : new LivePreviewLifecycleError(String(reason)));
  }

  supersede(code: string) {
    return this.terminalize("SUPERSEDED", "SUPERSEDED_NO_OP", code);
  }

  terminalize(phase: LivePreviewTerminal["phase"], outcome: LivePreviewOutcome, code: string) {
    if (this._terminal) return this._terminal;
    const terminal = { phase, outcome, code, terminalAtMs: this.now() } satisfies LivePreviewTerminal;
    this._terminal = terminal;
    this._phase = phase;
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.hardTimer = undefined;
    if (!this.abortController.signal.aborted) this.abortController.abort(new LivePreviewLifecycleError(code));
    if (!this.deadlineController.signal.aborted) this.deadlineController.abort(new LivePreviewLifecycleError(code));
    this.cleanupOwned = false;
    this.emit("live_preview_lifecycle", terminal);
    return terminal;
  }

  async run<T>(
    stage: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: { maxMs?: number; reserveMs?: number; terminalDelivery?: boolean } = {},
  ): Promise<T> {
    if (!options.terminalDelivery) this.validateCurrent();
    else {
      if (this._terminal?.phase === "SUPERSEDED") throw new LivePreviewLifecycleError(this._terminal.code);
      if (!this.current()) {
        this.supersede("LIVE_PREVIEW_IDENTITY_SUPERSEDED");
        throw new LivePreviewLifecycleError("LIVE_PREVIEW_IDENTITY_SUPERSEDED");
      }
    }
    const available = this.remainingMs() - (options.reserveMs ?? 0),
      budget = Math.min(options.maxMs ?? available, available);
    if (budget <= 0) throw new LivePreviewLifecycleError("LIVE_PREVIEW_OPERATION_BUDGET_EXHAUSTED");
    const controller = new AbortController(),
      parents = options.terminalDelivery
        ? [this.deadlineController.signal]
        : [this.abortController.signal, this.deadlineController.signal],
      cancel = (signal: AbortSignal) => () => controller.abort(signal.reason ?? new LivePreviewLifecycleError("LIVE_PREVIEW_ABORTED"));
    const listeners = parents.map(signal => ({ signal, listener: cancel(signal) }));
    for (const { signal, listener } of listeners) {
      if (signal.aborted) listener();
      else signal.addEventListener("abort", listener, { once: true });
    }
    const startedAtMs = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new LivePreviewLifecycleError(`${stage}_TIMEOUT`);
    timer = setTimeout(() => controller.abort(timeout), budget);
    timer.unref?.();
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason ?? timeout);
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? timeout), { once: true });
    });
    const work = Promise.resolve().then(() => operation(controller.signal));
    work.catch(() => undefined);
    try {
      const value = await Promise.race([work, aborted]);
      if (!options.terminalDelivery) this.validateCurrent();
      this.emit("live_preview_operation", { stage, outcome: "SUCCEEDED", elapsedMs: this.now() - startedAtMs });
      return value;
    } catch (error) {
      this.emit("live_preview_operation", {
        stage,
        outcome: controller.signal.aborted ? "ABORTED" : "FAILED",
        code: error instanceof Error ? error.message : String(error),
        elapsedMs: this.now() - startedAtMs,
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    }
  }

  async notifyTerminal(
    stage: string,
    operation: (signal: AbortSignal) => Promise<unknown>,
    maxMs = 1_000,
  ) {
    if (!this._terminal) throw new LivePreviewLifecycleError("LIVE_PREVIEW_TERMINAL_NOTIFICATION_BEFORE_TERMINAL");
    if (this._terminal.phase === "SUPERSEDED" || !this.current()) {
      this.emit("live_preview_terminal_notification", { stage, outcome: "SKIPPED_STALE" });
      return false;
    }
    const controller = new AbortController(),
      timeout = new LivePreviewLifecycleError(`${stage}_TIMEOUT`),
      timer = setTimeout(() => controller.abort(timeout), maxMs),
      aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? timeout), { once: true });
      }),
      work = Promise.resolve().then(() => operation(controller.signal));
    timer.unref?.();
    work.catch(() => undefined);
    try {
      await Promise.race([work, aborted]);
      this.emit("live_preview_terminal_notification", { stage, outcome: "DELIVERED" });
      return true;
    } catch (error) {
      this.emit("live_preview_terminal_notification", {
        stage,
        outcome: "FAILED",
        code: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private emit(event: string, data: Record<string, unknown>) {
    try {
      this.telemetry?.(event, {
        ...this.identity,
        ...data,
        remainingMs: this.remainingMs(),
      });
    } catch {}
  }
}

export function createLivePreviewExecutionContext(input: {
  sessionId: string;
  flowRevision: number;
  requestId: string;
  poolId: string;
  amountIdentity: string;
  startedAtMs?: number;
  hardDeadlineMs?: number;
  isCurrent: () => boolean;
  telemetry?: Telemetry;
  now?: () => number;
}) {
  const now = input.now ?? Date.now,
    startedAtMs = input.startedAtMs ?? now();
  return new LivePreviewExecutionContext({
    sessionId: input.sessionId,
    flowRevision: input.flowRevision,
    requestId: input.requestId,
    poolId: input.poolId,
    amountIdentity: input.amountIdentity,
    startedAtMs,
    hardDeadlineAtMs: startedAtMs + (input.hardDeadlineMs ?? LIVE_PREVIEW_HARD_DEADLINE_MS),
  }, input.isCurrent, input.telemetry, now);
}

export function isLivePreviewTimeout(error: unknown) {
  return error instanceof LivePreviewLifecycleError && /(?:TIMEOUT|DEADLINE|BUDGET_EXHAUSTED)$/.test(error.code);
}

export async function runLivePreviewDeliveryWorkflow<T, R>(input: {
  execution: LivePreviewExecutionContext;
  compute: (signal: AbortSignal) => Promise<T>;
  persistComputed: (value: T, signal: AbortSignal) => Promise<void>;
  render: (value: T, liquidityLine: string) => R;
  deliver: (rendered: R, signal: AbortSignal) => Promise<unknown>;
  deliverFailure: (text: string, signal: AbortSignal) => Promise<unknown>;
  computedOutcome: (value: T) => "AUTHORITATIVE_LIVE_PREVIEW" | "EXPLICIT_FAIL_CLOSED";
  failureText: (error: unknown, timedOut: boolean) => string;
  persistTerminal?: (terminal: LivePreviewTerminal) => void | Promise<void>;
  liquidity?: Promise<string>;
}) {
  const execution = input.execution;
  let liquidityLine = "Pool liquidity: Unavailable";
  if (input.liquidity) void input.liquidity.then(value => {
    if (execution.phase !== "PREPARING") {
      execution.record("live_preview_optional_enrichment", { outcome: "DISCARDED_AFTER_COMPUTE" });
      return;
    }
    try {
      execution.validateCurrent();
      liquidityLine = value;
      execution.record("live_preview_optional_enrichment", { outcome: "AVAILABLE_BEFORE_RENDER" });
    } catch {
      execution.record("live_preview_optional_enrichment", { outcome: "DISCARDED_STALE" });
    }
  }).catch(error => execution.record("live_preview_optional_enrichment", {
    outcome: "UNAVAILABLE",
    code: error instanceof Error ? error.message : String(error),
  }));
  try {
    const value = await execution.run("LIVE_PREVIEW_COMPUTE", input.compute, {
      reserveMs: LIVE_PREVIEW_TERMINAL_DELIVERY_RESERVE_MS,
    });
    execution.validateCurrent();
    await execution.run("LIVE_PREVIEW_PERSIST_COMPUTED", signal => input.persistComputed(value, signal), {
      reserveMs: 1_200,
    });
    execution.markComputed();
    execution.validateCurrent();
    const rendered = input.render(value, liquidityLine), outcome = input.computedOutcome(value);
    await execution.run("TELEGRAM_FINAL_PREVIEW_DELIVERY", signal => input.deliver(rendered, signal), {
      maxMs: LIVE_PREVIEW_TELEGRAM_OPERATION_MAX_MS,
      reserveMs: 1_000,
    });
    const terminal = outcome === "AUTHORITATIVE_LIVE_PREVIEW"
      ? execution.terminalize("DELIVERED", outcome, "AUTHORITATIVE_PREVIEW_DELIVERED")
      : execution.terminalize("FAILED", outcome, "AUTHORITATIVE_PREVIEW_BLOCKED_DELIVERED");
    await input.persistTerminal?.(terminal);
    return terminal;
  } catch (error) {
    if (execution.terminal?.phase === "SUPERSEDED") return execution.terminal;
    execution.cancelWork(error);
    const terminal = execution.terminal ?? execution.terminalize(
      "FAILED",
      "EXPLICIT_FAIL_CLOSED",
      error instanceof LivePreviewLifecycleError ? error.code : "LIVE_PREVIEW_FAIL_CLOSED",
    );
    await input.persistTerminal?.(terminal);
    await execution.notifyTerminal(
      "TELEGRAM_PREVIEW_FAILURE_DELIVERY",
      signal => input.deliverFailure(input.failureText(error, isLivePreviewTimeout(error) || terminal.code === "LIVE_PREVIEW_HARD_DEADLINE"), signal),
    );
    return terminal;
  }
}
