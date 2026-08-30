import type { FailureRecoveryDecision } from "./failure-recovery";
import type { AgentContext } from "./types";

export function applyFreshContextRetry(
  context: AgentContext,
  decision: FailureRecoveryDecision,
): AgentContext {
  if (decision.action !== "RETRY_WITH_FRESH_CONTEXT") {
    throw new Error("Fresh-context retry requires a retry recovery decision.");
  }

  // Keep only the original cue.
  // Temporary assumptions and intermediate data are discarded.
  const cue = context.workingMemory.cue;

  return {
    ...context,

    // Rebuild the task from fresh context.
    phase: "BUILD_CONTEXT",

    // Record the failure that triggered this recovery.
    failureCount: decision.failureCount,

    // One real retry is now being consumed.
    retryCount: context.retryCount + 1,

    // A normal first retry has no cooldown.
    cooldownUntilMs: null,

    // Fresh mind: preserve the root cue only.
    workingMemory: cue === undefined ? {} : { cue },
  };
}
